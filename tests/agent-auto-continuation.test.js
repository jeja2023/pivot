'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createAgentRunner } = require('../server/services/agent-runtime/run-execution');
const { TaskBudget, normalizeTaskBudget } = require('../server/services/agent-budget');
const { TERMINAL_STATUSES } = require('../server/services/agent-runtime/state-machine');

test('模型时间片结束且没有在途工具时，Agent 自动从安全检查点续跑', async () => {
    const activeRunControllers = new Map();
    const updates = [];
    const controls = [];
    const metadata = {};
    let enqueued = 0;
    const run = {
        id: 'auto-continue-run',
        user_id: 7,
        title: '自动续跑测试',
        goal: '生成一个 Python 程序',
        status: 'queued',
        timeout_ms: 60_000,
        max_steps: 3,
        run_mode: 'standard',
        tool_policy: 'builtin_only',
        tool_allowlist: '[]',
        approval_policy: 'safe_mcp_auto',
        budget_config: '{}',
        context_config: '{}',
        metadata: '{}',
        created_at: new Date().toISOString(),
        started_at: null
    };
    const timeout = Object.assign(new Error('流式工具规划执行超时'), { code: 'AGENT_TIMEOUT' });
    const { runAgent } = createAgentRunner({
        activeRunControllers,
        taskBudgetsBySignal: new Map(),
        assertRunNotCancelled() {},
        assertRunUserActive: async () => {},
        isRunCancelled: () => false,
        AGENT_DEFAULT_TIMEOUT_MS: 60_000,
        AGENT_TOOL_TIMEOUT_MS: 30_000,
        AGENT_AUTO_CONTINUE_ON_TIMEOUT: true,
        AGENT_AUTO_CONTINUE_ON_STEP_LIMIT: true,
        AGENT_MAX_AUTO_CONTINUATIONS: 2,
        AGENT_MAX_TOTAL_RUNTIME_MS: 60 * 60 * 1000,
        AGENT_ANSWER_MIN_MAX_TOKENS: 1024,
        getRunForUser: async () => run,
        getRunUser: async () => ({ id: 7 }),
        getRunnableModelForUserAsync: async () => ({ id: 3, name: '测试模型', model_name: 'test-model' }),
        compactToolOutputForModel: value => value,
        executeToolByName: async () => ({}),
        findAgentToolByName: () => null,
        runAgentDag: async () => {},
        isStreamingToolsEnabled: () => true,
        tryRunAgentStreaming: async () => { throw timeout; },
        callModelText: async () => '',
        resolveAgentRequestTimeoutMs: () => 60_000,
        recordAgentModelUsage: async () => ({}),
        normalizeToolInput: value => value,
        chooseModel: async () => null,
        normalizeRouterStrategy: () => 'fixed',
        assessConfidence: () => ({ confident: true }),
        pickEscalationModel: async () => null,
        getModelEndpointRuntimeStatus: () => ({}),
        getAgentRuntimeDeps: () => ({}),
        execute: async () => 1,
        queryOne: async sql => /checkpoint_type = 'tool'/.test(sql) ? null : null,
        updateRun: async (_id, fields) => { updates.push(fields); Object.assign(run, fields); return 1; },
        getRunStatus: async () => run.status,
        insertStep: async (_id, _index, step) => { controls.push(step); },
        listSteps: async () => [],
        getRunMetadata: () => metadata,
        getAgentRunTitle: item => item.title,
        formatToolList: async () => [{ name: 'rag.search', source: 'builtin', idempotent: true }],
        listToolReliability: async () => [],
        selectToolOrder: list => list,
        normalizeMaxSteps: value => Number(value),
        normalizeRunMode: value => value,
        normalizePositiveInt: (value, fallback) => Number(value) || fallback,
        parseJsonObject: value => typeof value === 'object' ? value : JSON.parse(value || '{}'),
        normalizeTaskBudget,
        TaskBudget,
        recordAgentToolCall: async () => {},
        recordAgentTraceSpan: async () => {},
        ensureAgentTrace: async () => {},
        createAgentNotification: async () => {},
        createPersistedAgentStepContext: async () => ({}),
        recordAgentEvent: async () => {},
        buildAgentAuditFields: () => ({}),
        buildPlannerMessages: () => [],
        synthesizeFinalAnswer: async () => '',
        withTimeout: async operation => operation(new AbortController().signal),
        buildVisionHistory: async value => value,
        limitVisionImages: value => value,
        diagnoseError: () => ({ category: 'unknown' }),
        buildAgentResumeContext: async () => ({ latestStepIndex: 0, checkpointCount: 0, observations: [], recentFailures: [] }),
        claimAgentControlMessages: async () => [],
        approvalInputHash: () => '',
        maybePauseForApproval: async () => false,
        isApprovalGranted: () => false,
        waitForWorkflowDelay: async () => ({}),
        stableWorkflowDelayKey: () => '',
        setRunMetadata: async (_id, patch) => { Object.assign(metadata, patch); },
        recordRunRetryReason: async () => {},
        enqueueAgentRun: () => { enqueued += 1; },
        startAgentTraceSpan: async () => 'span',
        finishAgentTraceSpan: async () => {},
        syncAgentTraceFromRun: async () => {},
        TERMINAL_STATUSES,
        logger: { error() {}, warn() {} },
        getBeijingTimestamp: () => new Date().toISOString()
    });

    await runAgent(run.id, { id: 7 });
    assert.equal(run.status, 'queued');
    assert.equal(enqueued, 1);
    assert.equal(metadata.autoContinuation.count, 1);
    assert.equal(controls.some(step => /自动续跑/.test(step.title)), true);
    assert.equal(updates.some(fields => fields.status === 'completed_with_errors'), false);
});

test('轮次时间片耗尽会复用安全检查点续跑，而不是直接生成不完整终态', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agent-runtime', 'run-execution.js'), 'utf8');
    const streaming = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agent-streaming-runtime.js'), 'utf8');
    assert.match(source, /AGENT_AUTO_CONTINUE_ON_STEP_LIMIT/);
    assert.match(source, /reason: 'step_limit'/);
    assert.match(source, /roundsUsed \+ maxSteps/);
    assert.match(streaming, /stepLimitReached: roundsUsed >= sliceEndStep/);
});
