'use strict';

const { createAgentRunner } = require('../../server/services/agent-runtime/run-execution');
const validators = require('../../server/services/agent-validators');
const { TERMINAL_STATUSES } = require('../../server/services/agent-runtime/state-machine');

function createRoundRunner(overrides = {}) {
    const steps = [], updates = [], queued = [], errors = [];
    const run = { id: 'round-run', user_id: 7, goal: '读取多项信息', title: '轮次验证', status: 'queued', max_steps: 3,
        run_mode: 'standard', tool_policy: 'builtin_only', tool_allowlist: '[]', approval_policy: 'safe_mcp_auto',
        timeout_ms: 60000, budget_config: { max_steps: 5, max_tokens_total: 100000 }, context_config: '{}', metadata: {}, created_at: new Date().toISOString() };
    const deps = { ...validators,
        activeRunControllers: new Map(), taskBudgetsBySignal: new Map(), assertRunNotCancelled: async () => {}, assertRunUserActive: async () => {}, isRunCancelled: () => false,
        AGENT_DEFAULT_TIMEOUT_MS: 60000, AGENT_TOOL_TIMEOUT_MS: 30000, AGENT_ANSWER_MIN_MAX_TOKENS: 1024,
        AGENT_AUTO_CONTINUE_ON_STEP_LIMIT: true, AGENT_AUTO_CONTINUE_ON_TIMEOUT: true, AGENT_MAX_AUTO_CONTINUATIONS: 12, AGENT_MAX_TOTAL_RUNTIME_MS: 7200000,
        getRunForUser: async () => run, getRunUser: async () => ({ id: 7 }), getRunnableModelForUserAsync: async () => ({ id: 3, name: '测试模型' }),
        getRunStatus: async () => run.status,
        compactToolOutputForModel: value => value, findAgentToolByName: (_name, list) => list[0],
        getRunMetadata: value => validators.parseJsonObject(value.metadata) || {}, getAgentRunTitle: () => run.title,
        normalizePositiveInt: (value, fallback) => Number(value) || fallback, normalizeRouterStrategy: () => 'fixed',
        execute: async () => 1, queryOne: async () => null, updateRun: async (_id, patch) => { updates.push(patch); Object.assign(run, patch); },
        listSteps: async () => steps, insertStep: async (_id, index, step) => steps.push({ ...step, step_index: index }),
        formatToolList: async () => ['tools.search', 'tools.describe', 'tools.execute', 'system.health'].map(name => ({ name, source: 'builtin', idempotent: true })), listToolReliability: async () => [], selectToolOrder: value => value,
        approvalInputHash: value => JSON.stringify(value),
        recordAgentModelUsage: async () => ({}), ensureAgentTrace: async () => {}, recordAgentTraceSpan: async () => {}, createAgentNotification: async () => {},
        createPersistedAgentStepContext: async () => ({}), recordAgentEvent: async () => {}, buildAgentAuditFields: () => ({}), buildPlannerMessages: () => [],
        withTimeout: async operation => operation(new AbortController().signal), resolveAgentRequestTimeoutMs: () => 60000,
        resolveAgentPlanningThinking: () => false,
        buildVisionHistory: async value => value, limitVisionImages: value => value, recordAgentToolCall: async () => {}, normalizeToolInput: (_name, input) => input,
        diagnoseError: () => ({ category: 'unknown' }), claimAgentControlMessages: async () => [], maybePauseForApproval: async () => false, isApprovalGranted: () => false,
        setRunMetadata: async (_id, patch) => { run.metadata = { ...validators.parseJsonObject(run.metadata), ...patch }; }, enqueueAgentRun: () => queued.push(1),
        buildAgentResumeContext: async () => ({ latestStepIndex: steps.filter(step => step.type === 'plan').at(-1)?.step_index || 1, checkpointCount: 1, observations: [] }),
        synthesizeFinalAnswer: async () => '部分结果', verifyAgentOutcome: async () => ({ outcomeStatus: 'verified', hardFailures: [] }),
        startAgentTraceSpan: async () => 'span', finishAgentTraceSpan: async () => {}, syncAgentTraceFromRun: async () => {},
        recordRunRetryReason: async () => {}, getBeijingTimestamp: () => new Date().toISOString(), TERMINAL_STATUSES,
        logger: { error(value) { errors.push(value); }, warn() {} }, getAgentRuntimeDeps: (_signal, budget) => ({ taskBudget: budget }), ...overrides };
    return { run, deps, steps, updates, queued, errors, start: () => createAgentRunner(deps).runAgent(run.id, { id: 7 }) };
}

module.exports = { createRoundRunner };
