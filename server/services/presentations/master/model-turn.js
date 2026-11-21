'use strict';

const { performance } = require('node:perf_hooks');
const runtime = require('./runtime');
const { callModelJson, recordAgentModelUsage, AGENT_MODEL_REQUEST_TIMEOUT_MS } = require('../../agent-model');
const { normalizeChatError } = require('../../chat-errors');
const { estimateMessagesTokens } = require('../../context-budget');
const { estimateTokens } = require('../../../llm');
const { messagesForModel, markImagePageRead } = require('./model-input');
const { compactMessages, planRequest, requestLimits, usageRecord } = require('./context');
const { fitReferenceMessages } = require('./reference-context');
const { archiveOlderObservations } = require('./history');
const { phaseMessages } = require('./phase-context');
const { ensureModelQuota } = require('../../model-daily-quota');
const { getBeijingTimestamp } = require('../../../time');
const { recordTurnDiagnostic } = require('./observations');
const { hostGuidance, currentHostPrompt } = require('./host-protocol');
const { citationId } = require('./citation-repair');

function modelFailure(error, timeoutMs) {
    const status = Number(error.response?.status || error.statusCode || error.status);
    const diagnosis = normalizeChatError({ error: error.message, detail: error.response?.data, statusCode: status,
        code: error.code === 'CONTEXT_LENGTH_EXCEEDED' ? error.code : undefined });
    if (diagnosis.code === 'CONTEXT_LENGTH_EXCEEDED') return runtime.error('模型服务拒绝了本轮上下文。请核对模型实际窗口和输入上限，或切换模型后从检查点继续。', 'PPT_MASTER_UPSTREAM_CONTEXT_LIMIT', 422);
    if (['AI_QUEUE_FULL', 'AI_QUEUE_TIMEOUT', 'AI_ENDPOINT_CIRCUIT_OPEN'].includes(error.code)) return error;
    if (!error.response && error.code === 'INSUFFICIENT_QUOTA') return runtime.error(error.message, 'PPT_MASTER_QUOTA_EXCEEDED', 429);
    if (status === 402 || diagnosis.code === 'INSUFFICIENT_QUOTA') return runtime.error('模型服务额度不足，请核对供应商用量和余额后从检查点继续。', 'PPT_MASTER_MODEL_PROVIDER_QUOTA', 429);
    if (status === 429) return runtime.error('模型服务暂时限流，请稍后从检查点继续。', 'PPT_MASTER_MODEL_RATE_LIMIT', 429);
    if (status === 504) return Object.assign(runtime.error('上游模型网关返回 HTTP 504。检查点已保留。', 'PPT_MASTER_MODEL_TIMEOUT', 504),
        { modelFailureKind: 'upstream_timeout' });
    if (error.code === 'AGENT_MODEL_FIRST_RESPONSE_TIMEOUT'
        || (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) && !error.syscall && /^timeout of \d+ms exceeded$/i.test(error.message))) {
        return Object.assign(runtime.error(`模型请求超时，Pivot 本轮请求时限为 ${Math.ceil(timeoutMs / 1000)} 秒。检查点已保留。`,
            'PPT_MASTER_MODEL_TIMEOUT', 504), { modelFailureKind: 'local_timeout' });
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        return Object.assign(runtime.error('连接模型服务超时。请核对模型服务与网关的连通状态后从检查点继续。',
            'PPT_MASTER_MODEL_TIMEOUT', 504), { modelFailureKind: 'transport_timeout' });
    }
    if (status === 401 || status === 403) return runtime.error('模型服务拒绝授权，请在模型管理中核对密钥与权限后继续。', 'PPT_MASTER_MODEL_AUTH', status);
    if (['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) {
        return Object.assign(runtime.error('模型服务连接提前关闭，Pivot 未收到完整回复。检查点已保留。', 'PPT_MASTER_MODEL_CONNECTION', 502),
            { modelFailureKind: 'connection_reset' });
    }
    if (status >= 500 || diagnosis.code === 'UPSTREAM_UNAVAILABLE' || ['EAI_AGAIN', 'ECONNREFUSED', 'ENOTFOUND'].includes(error.code)) {
        return Object.assign(runtime.error('模型服务或上游网关暂不可用，检查点已保留。', 'PPT_MASTER_MODEL_CONNECTION', 502),
            status >= 500 ? { modelFailureKind: 'gateway_error' } : {});
    }
    if (status >= 400) return runtime.error(`模型服务拒绝请求（HTTP ${status}），请核对模型配置后从检查点继续。`, 'PPT_MASTER_MODEL_REQUEST_REJECTED', 422);
    return error;
}

async function runModelTurn(user, id, state, model, hooks, deps, progressGuidance, citationIssues) {
    const limits = requestLimits(model);
    const makeView = async () => {
        const original = await (deps.messagesForModel || messagesForModel)(user, id, state, model);
        const compacted = compactMessages(original, { forModel: true });
        const { messages: prepared, ranges } = phaseMessages(compacted.messages, state);
        // 清单阶段使用宿主协议、所选模板和材料。绘制指引在制稿阶段恢复。
        const planning = state.request.draftFirst && state.managedProject && state.review?.approvals && !state.review.approvals.design;
        const visible = (planning || citationIssues?.length) ? prepared.filter(message => !(message.role === 'user'
            && typeof message.content === 'string' && (
                /^\{"runtimeDocument":"(?:SKILL\.md|workflows\/[^"]+)",/u.test(message.content)
                || message.content.startsWith('宿主中断后从已保存检查点继续。') && message.content.includes('repairCitations')
            ))) : prepared;
        if (visible[0]?.role === 'system' && typeof visible[0].content === 'string') {
            visible[0] = { ...visible[0], content: [currentHostPrompt(visible[0].content), hostGuidance(state), progressGuidance].filter(Boolean).join('\n') };
        }
        if (citationIssues?.length) {
            visible.push({ role: 'user', content: JSON.stringify({
                citationRepairEvidence: citationIssues.map(issue => ({ ...issue, ...(!issue.missing ? { id: citationId(issue) } : {}) })),
                ...(state.citationDraft?.plan ? { savedCitationPlan: state.citationDraft.plan } : {})
            }) });
        }
        const messages = fitReferenceMessages(visible, limits.fullOutputInputBudget, ranges);
        return { original, messages, compactedWrites: compacted.compactedWrites, inputEstimate: estimateMessagesTokens(messages) };
    };
    const archive = async options => {
        try {
            if (!await archiveOlderObservations(state, options)) return false;
        } catch (error) {
            // 达到归档容量时仍可发送已符合单轮预算的请求。
            if (error.code === 'PPT_MASTER_HISTORY_LIMIT') return false;
            throw error;
        }
        await hooks.checkpoint(state, { phase: 'authoring', message: '已归档较早的工具结果，正在继续制作。' });
        return true;
    };
    let view = await makeView();
    const original = view.original;
    if (state.focusModelHistory) {
        if (await archive({ force: true, recentTurns: 1 })) view = await makeView();
    } else if (await archive({ force: view.inputEstimate > limits.archiveAt, preserveActive: true })) view = await makeView();
    if (view.inputEstimate > limits.fullOutputInputBudget && await archive({ force: true, recentTurns: 1 })) view = await makeView();

    const send = async () => {
        state.modelRequest = { contextWindow: limits.contextWindow, configuredInputLimit: limits.configuredInputLimit,
            inputEstimate: view.inputEstimate, timeoutSeconds: Math.ceil(AGENT_MODEL_REQUEST_TIMEOUT_MS / 1000) };
        const remainingTokens = state.request.tokenBudget === 0 ? Infinity : state.request.tokenBudget - state.usedTokens;
        const plan = planRequest(view.messages, original, model, remainingTokens, limits);
        state.modelRequest.outputLimit = plan.maxTokens;
        // 为后续模型请求的指引、确认答复和工具元数据留出容量。
        const readResultBudget = Math.max(1000, Math.floor((limits.fullOutputInputBudget - plan.breakdown.initial) / 2));
        await hooks.ensureCurrent();
        const usageRef = {};
        let output, releaseQuota = () => {};
        let startedAt, turnStartMs;
        const finishTiming = () => ({ startedAt, durationMs: Math.round(performance.now() - turnStartMs) });
        try {
            if (!deps.callModel) releaseQuota = await ensureModelQuota(user, model, view.messages, plan.maxTokens, { signal: hooks.signal, inputEstimate: plan.inputEstimate });
            startedAt = getBeijingTimestamp();
            turnStartMs = performance.now();
            // 非流式调用使用该选项设置 HTTP 等待时限。PPT 必须等完整 JSON，再校验和执行动作。
            output = await (deps.callModel || callModelJson)(model, view.messages, { user, signal: hooks.signal, maxTokens: plan.maxTokens,
                firstResponseTimeoutMs: AGENT_MODEL_REQUEST_TIMEOUT_MS,
                temperature: 0.2, usageRef, quotaManaged: true, enableThinking: false, budget: deps.budget, responseFormat: { type: 'json_object' } });
        } catch (error) {
            const timing = turnStartMs === undefined ? null : finishTiming();
            releaseQuota();
            hooks.signal?.throwIfAborted();
            const failure = modelFailure(error, AGENT_MODEL_REQUEST_TIMEOUT_MS);
            if (timing) {
                usageRecord(state, plan, usageRef, undefined, view.compactedWrites, estimateTokens, { ...timing, failed: true });
                recordTurnDiagnostic(state, { outcome: 'model_failed', errorCode: failure.code, modelFailureKind: failure.modelFailureKind });
            }
            if (failure.code === 'PPT_MASTER_MODEL_TIMEOUT' || failure.code === 'PPT_MASTER_MODEL_CONNECTION') state.focusModelHistory = true;
            throw failure;
        }
        try {
            usageRecord(state, plan, usageRef, output, view.compactedWrites, estimateTokens, finishTiming());
            delete state.focusModelHistory;
            markImagePageRead(state, view.messages);
            if (!deps.callModel) await recordAgentModelUsage(user, model, view.messages, output, 'ppt_master_engine', state.request.runId || '', {
                usageRef, budget: deps.budget, estimatedUsage: { inputTokens: plan.inputEstimate, outputTokens: estimateTokens(typeof output === 'string' ? output : JSON.stringify(output)) }
            });
        } finally { releaseQuota(); }
        return { output, usageRef, readResultBudget };
    };
    try {
        return await send();
    } catch (error) {
        if (error.code !== 'PPT_MASTER_UPSTREAM_CONTEXT_LIMIT' || !await archive({ force: true, recentTurns: 1 })) throw error;
        const reduced = await makeView();
        if (reduced.inputEstimate >= view.inputEstimate) throw error;
        view = reduced;
        return send();
    }
}

module.exports = { runModelTurn };
