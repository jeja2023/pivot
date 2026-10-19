'use strict';

const repository = require('../repositories/agent-learning-evaluation');
const { hasSensitiveContent } = require('./long-term-memory/memory-utils');
const { createAgentEvalSuite, startAgentEvaluation, getAgentEvalRun } = require('./agent-evaluations');

function selectLearningExamples(rows, candidate, excludedRunId) {
    const required = new Set(candidate.tools || []);
    return rows.filter(row => row.id !== excludedRunId && !hasSensitiveContent(`${row.goal}\n${row.final_answer}\n${row.modified_answer || ''}`)
        && (Array.isArray(row.tools) ? row.tools : []).filter(tool => required.has(tool)).length >= 2)
        .filter((row, index, all) => all.findIndex(other => other.goal === row.goal) === index).slice(0, 8);
}

async function startLearningEvaluation({ user, run, candidate, version }, deps = {}) {
    const rows = await (deps.humanVerifiedExamples || repository.humanVerifiedExamples)(user.id);
    const examples = selectLearningExamples(rows, candidate, run.id);
    if (examples.length < 5) return { scheduled: false, reason: 'insufficient_independent_human_examples' };
    const suite = await (deps.createAgentEvalSuite || createAgentEvalSuite)(user, {
        name: `个人经验验证-${version.id}`, description: '基于本人至少五个独立、已核验并获正面反馈的任务冻结；不把来源任务重复计为评测样本。',
        modelId: run.chosen_model_id || run.model_id, targetType: 'free',
        runConfig: { maxSteps: 8, maxTokenBudget: 12000, toolPolicy: 'builtin_only' },
        cases: examples.map((row, index) => ({ name: `独立任务-${index + 1}`, input: row.goal,
            expectedOutput: row.modified_answer || row.final_answer,
            assertions: { evaluationTier: index === 0 ? 'contract' : 'scenario', minLength: 20 } }))
    });
    const runtime = deps.createAgentRun || require('./agent-runtime').runs.createAgentRun;
    const evaluation = await (deps.startAgentEvaluation || startAgentEvaluation)(suite.suite.id, user, {}, options => runtime({
        ...options, evaluationSkillVersionId: version.id,
        toolAllowlist: candidate.tools, networkPolicy: { enabled: false },
        budgetConfig: { max_steps: 8, max_tokens_total: 12000, max_runtime_seconds: 120, max_external_side_effects: 0, max_file_writes: 0, max_network_requests: 0 },
        metadata: { ...options.metadata, autoPersonalSkill: false }
    }));
    return { scheduled: true, evaluationRunId: evaluation.run.id };
}

async function resumeFinishedLearningEvaluations() {
    for (const row of await repository.pendingEvaluations()) {
        const summary = typeof row.result_summary === 'string' ? JSON.parse(row.result_summary) : row.result_summary;
        if (!summary?.evaluationRunId) continue;
        const evaluation = await getAgentEvalRun(summary.evaluationRunId, { id: row.user_id });
        if (evaluation?.run?.status === 'completed') await repository.resumeLearningJob(row.id, row.user_id);
    }
}

module.exports = { startLearningEvaluation, resumeFinishedLearningEvaluations, selectLearningExamples };
