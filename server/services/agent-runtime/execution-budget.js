'use strict';

const { runRoundPolicy } = require('../agent-round-policy');
const { TaskBudget, normalizeTaskBudget } = require('../agent-budget');
const { parseJsonObject } = require('../agent-validators');

async function prepareExecutionBudget(run, { updateRun, listSteps, assertRunNotCancelled = async () => {}, maxTotalRuntimeMs = 7200000, defaultTimeoutMs = 600000 }) {
    const policy = runRoundPolicy(run), config = parseJsonObject(run.budget_config) || {};
    const previous = parseJsonObject(run.usage_stats) || {};
    // 旧任务可能只在用量快照中保存风险限额，升级默认容量不能扩大其已持久化边界。
    if (config.risk_budget == null && config.riskBudget == null && previous.limits?.risk_budget != null) config.risk_budget = previous.limits.risk_budget;
    const limits = normalizeTaskBudget({ ...config, max_steps: policy.totalSteps });
    if (Number(run.max_token_budget) > 0) limits.max_tokens_total = Math.min(limits.max_tokens_total, Number(run.max_token_budget));
    policy.reserveTokens = Math.min(8192, Math.floor(limits.max_tokens_total * .1));
    const counts = { ...(previous.counts || {}) };
    if (previous.accountingVersion !== 2) {
        const steps = await listSteps(run.id);
        counts.steps = Math.max(Number(counts.steps) || 0, steps.filter(step => step.type === 'plan').length);
        counts.tool_calls = Math.max(Number(counts.tool_calls) || 0, steps.filter(step => step.type === 'tool').length);
    }
    counts.tokens_total = Math.max(Number(counts.tokens_total) || 0, Number(run.total_tokens) || 0);
    const priorElapsedSeconds = Math.max(0, Number(previous.elapsed_seconds) || 0);
    const metadata = parseJsonObject(run.metadata) || {};
    const revision = JSON.stringify([metadata.taskContract?.revision || 0, metadata.capabilityConstraints?.sourceMessageId || '']);
    const progress = { ...(previous.progress || {}) };
    const revisionChanged = progress.revision !== revision;
    if (revisionChanged) progress.lastProgressRound = Number(counts.steps) || 0;
    progress.revision = revision;
    const segmentNumber = Math.max(0, Number(metadata.autoContinuation?.count) || 0) + 1;
    const sameSegment = previous.accountingVersion === 2 && previous.segment?.number === segmentNumber && !revisionChanged;
    const totalRuntimeSeconds = Math.min(limits.max_runtime_seconds, maxTotalRuntimeMs / 1000);
    limits.max_runtime_seconds = totalRuntimeSeconds;
    const segmentSpentMs = sameSegment ? Math.max(0, priorElapsedSeconds - (Number(previous.segment?.startElapsedSeconds) || 0)) * 1000 : 0;
    const segmentMs = Math.min(Math.max(1, Math.max(Number(run.timeout_ms) || defaultTimeoutMs, 60000) - segmentSpentMs), Math.max(1, (totalRuntimeSeconds - priorElapsedSeconds) * 1000));
    const budget = new TaskBudget(limits, { policy, counts, progress, priorElapsedSeconds, segmentNumber,
        ...(sameSegment ? { segmentStartSteps: previous.segment.startSteps, segmentStartProgress: previous.segment.startProgress, segmentStartElapsed: previous.segment.startElapsedSeconds } : {}),
        persist: async snapshot => {
            await assertRunNotCancelled(run.id);
            const serialized = JSON.stringify(snapshot);
            const changed = await updateRun(run.id, { usage_stats: serialized });
            if (changed === 0 || changed === false) throw new Error('任务累计用量未能写入。');
            run.usage_stats = serialized;
        } });
    const segmentDeadline = Date.now() + segmentMs;
    const reserveMs = Math.min(30000, Math.floor(segmentMs / 4));
    return { taskBudget: budget, deadline: segmentDeadline, executionDeadline: segmentDeadline - reserveMs };
}

async function beginPlanningRound(budget) {
    if (budget?.beginPlanningRound) return budget.beginPlanningRound();
    budget?.consumeStep();
}

module.exports = { prepareExecutionBudget, beginPlanningRound };
