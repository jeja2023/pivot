'use strict';

const { buildFinalAnswerPrompt } = require('./planner');
const { knowledgeScopeRevision } = require('../chat-knowledge-revision');
const { isExecutionControlError } = require('../agent-execution-control');
const { inferTaskType, modelQualityIdentity } = require('../agent-model-quality');

function createFinalAnswerEscalator({ run, user, budget, signal, assessConfidence, pickEscalationModel, endpointStatusGetter,
    synthesizeFinalAnswer, withTimeout, remainingModelRequestMs, assertRunNotCancelled, recordAgentTraceSpan, logger, minOutputTokens }) {
    let attempted = false;
    return async ({ answer, finishReason, modelCfg, observations, context, plannedKnowledgeRevision }) => {
        if (attempted || signal.aborted || budget.counts.tokens_total >= budget.limits.max_tokens_total ||
            (plannedKnowledgeRevision !== undefined && knowledgeScopeRevision(run) !== plannedKnowledgeRevision)) return null;
        const confidence = assessConfidence({ output: answer, finishReason });
        if (confidence.confident) return null;
        attempted = true;
        try {
            const timeoutMs = Math.floor(remainingModelRequestMs() / 2);
            if (timeoutMs < 1000) return null;
            const upgraded = await withTimeout(async attemptSignal => {
                const { messages } = buildFinalAnswerPrompt(run.goal, observations, context);
                const model = await pickEscalationModel({ user, currentModel: modelCfg, messages, endpointStatusGetter,
                    taskType: inferTaskType(run), budgetOptions: { minOutputTokens } });
                if (!model || attemptSignal.aborted) return null;
                const content = await synthesizeFinalAnswer(model, run.goal, observations, user, run.id, {
                    ...context, signal: attemptSignal, budget, timeoutMs, requireComplete: true
                });
                return { answer: content, model };
            }, timeoutMs, '重新生成最终总结', { signal, timeoutCode: 'AGENT_SUMMARY_ESCALATION_TIMEOUT' });
            if (!upgraded) return null;
            await assertRunNotCancelled(run.id);
            if (plannedKnowledgeRevision !== undefined && knowledgeScopeRevision(run) !== plannedKnowledgeRevision) return null;
            await recordAgentTraceSpan(run.id, { type: 'routing', name: '成本升级重新生成最终总结',
                input: { modelId: modelCfg.id, reason: confidence.reason }, output: { modelId: upgraded.model.id } });
            return upgraded;
        } catch (error) {
            if (signal.aborted || (isExecutionControlError(error) && error.code !== 'AGENT_BUDGET_EXCEEDED')) throw signal.reason || error;
            logger.warn({ runId: run.id, code: error.code }, '成本升级未生成可用总结，已保留首次回答');
            return null;
        }
    };
}

function answerVerificationRun(run, model) {
    return model ? { ...run, chosen_model_id: model.id, executionModelIdentity: modelQualityIdentity(model) } : run;
}

module.exports = { createFinalAnswerEscalator, answerVerificationRun };
