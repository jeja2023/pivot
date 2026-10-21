const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveModelTaskTokenBudget, normalizeModelTaskBudget, resolveChatAgentBudget } = require('../server/services/agent-token-policy');
const { TaskBudget } = require('../server/services/agent-budget');
const { getModelContextBudget } = require('../server/services/context-budget');

function withAutomaticBudget(fn) {
    const original = process.env.AGENT_TASK_MAX_TOKENS_TOTAL;
    process.env.AGENT_TASK_MAX_TOKENS_TOTAL = '0';
    try { return fn(); } finally {
        if (original === undefined) delete process.env.AGENT_TASK_MAX_TOKENS_TOTAL;
        else process.env.AGENT_TASK_MAX_TOKENS_TOTAL = original;
    }
}

test('256K 模型按多轮累计预算运行，单次上下文仍受模型窗口约束', () => {
    const model = { context_window_tokens: 262144, max_tokens: 16384 };
    assert.equal(resolveModelTaskTokenBudget(model, {}), 2097152);
    const budget = new TaskBudget({ max_tokens_total: resolveModelTaskTokenBudget(model, {}) });
    budget.recordTokens(70000);
    budget.recordTokens(200000);
    assert.equal(budget.snapshot().counts.tokens_total, 270000);
    assert.equal(getModelContextBudget(model).contextWindow, 262144);
    assert.ok(getModelContextBudget(model).inputBudget < 262144);
});

test('管理员显式累计限额、任务小预算和零预算均不会被自适应放大', () => {
    const model = { context_window_tokens: 262144 };
    assert.equal(resolveModelTaskTokenBudget(model, { AGENT_TASK_MAX_TOKENS_TOTAL: '60000' }), 60000);
    assert.equal(resolveModelTaskTokenBudget(model, { AGENT_TASK_MAX_TOKENS_TOTAL: '20000000' }), 10000000);
    assert.equal(normalizeModelTaskBudget({ max_tokens_total: 12345 }, model).max_tokens_total, 12345);
    assert.equal(normalizeModelTaskBudget({ maxTokensTotal: 23456 }, model).max_tokens_total, 23456);
    assert.equal(normalizeModelTaskBudget({ max_tokens_total: 0 }, model).max_tokens_total, 0);
    const budget = new TaskBudget({ max_tokens_total: 100 });
    assert.throws(() => budget.recordTokens(101), error => error.code === 'AGENT_BUDGET_EXCEEDED');
});

test('缺省或异常配置有保守回退，自动预算有总上限', () => {
    assert.equal(resolveModelTaskTokenBudget({ context_window_tokens: 32768 }, {}), 500000);
    assert.equal(resolveModelTaskTokenBudget({ context_window_tokens: 262144 }, { AGENT_TASK_MAX_TOKENS_TOTAL: 'invalid' }), 2097152);
    assert.equal(resolveModelTaskTokenBudget({ context_window_tokens: 20000000 }, {}), 10000000);
    withAutomaticBudget(() => assert.equal(normalizeModelTaskBudget({}, { context_window_tokens: 262144 }).max_tokens_total, 2097152));
});

test('聊天自动接管使用所选模型累计预算并继续保留步骤、工具和审批边界', async () => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/services/chat-agent-handoff.js'), 'utf8'), {
        module, require(name) {
            if (name === './chat-preference-context') return { resolveChatProject: async () => ({ projectId: null }) };
            if (name === './chat-agent-bridge') return { normalizeChatHistory: rows => rows, prepareChatAgentContext: async () => ({}), buildChatAgentMetadata: () => ({ chatHistory: [], chatBridge: {} }) };
            if (name.startsWith('./')) return require(path.join(__dirname, '../server/services', name));
            return require(name);
        }
    });
    let input;
    const original = process.env.AGENT_TASK_MAX_TOKENS_TOTAL;
    process.env.AGENT_TASK_MAX_TOKENS_TOTAL = '0';
    try {
        await module.exports.createChatAgentHandoff({ user: { id: 1 }, userId: 1, sessionId: 'test', userMessageId: 2,
            visibleContent: '分析资料并生成报告', modelContent: '分析资料并生成报告', modelCfg: { id: 3, context_window_tokens: 262144 },
            automaticExecution: { action: 'agent_run', requiredCapabilities: ['agent.execute'] },
            agentRunFactory: async options => { input = options; return { id: 'run' }; } });
        assert.equal(input.maxTokenBudget, 2097152);
        assert.equal(input.budgetConfig.max_tokens_total, 2097152);
        assert.equal(input.maxSteps, 30);
        assert.equal(input.approvalPolicy, 'safe_mcp_auto');
        assert.equal(input.toolPolicy, 'builtin_only');
        assert.match(input.metadata.taskContract.budgetRef, /^sha256:/);
    } finally {
        if (original === undefined) delete process.env.AGENT_TASK_MAX_TOKENS_TOTAL;
        else process.env.AGENT_TASK_MAX_TOKENS_TOTAL = original;
    }
});

test('纯知识问答按资料量分配小预算，显式 Agent 与自动任务均适用', () => {
    withAutomaticBudget(() => {
        const options = { modelCfg: { context_window_tokens: 262144 }, ragEnabled: true,
            content: '知识库中的请假规定是什么？', context: { ragContext: '已有相关资料' } };
        for (const decision of [{}, { action: 'agent_run', requiredCapabilities: ['agent.execute', 'knowledge.search'] }]) {
            const result = resolveChatAgentBudget({ ...options, decision });
            assert.equal(result.profile, 'knowledge_qa');
            assert.equal(result.budget.max_tokens_total, 32768);
            assert.equal(result.budget.max_steps, 6);
            assert.equal(result.budget.max_tool_calls, 6);
        }
        const history = Array.from({ length: 24 }, () => ({ role: 'assistant', content: '资料'.repeat(4000) }));
        const larger = resolveChatAgentBudget({ ...options, history, context: { ragContext: '资料'.repeat(12000) } });
        assert.equal(larger.history.length, 6);
        assert.ok(larger.budget.max_tokens_total > 32768);
        assert.ok(larger.budget.max_tokens_total <= 131072);
    });
});

test('复杂任务保留通用预算，知识问答仍服从管理员更低的限额', () => {
    withAutomaticBudget(() => {
        const options = { modelCfg: { context_window_tokens: 262144 }, ragEnabled: true, content: '检索资料并交付文件',
            decision: { action: 'agent_run', requiredCapabilities: ['knowledge.search', 'artifact.deliver'] } };
        assert.equal(resolveChatAgentBudget(options).profile, 'standard');
        assert.equal(resolveChatAgentBudget(options).budget.max_steps, 30);
        assert.equal(resolveChatAgentBudget({ ...options, mcpEnabled: true }).profile, 'standard');
    });
    const original = process.env.AGENT_TASK_MAX_TOKENS_TOTAL;
    process.env.AGENT_TASK_MAX_TOKENS_TOTAL = '10000';
    try {
        assert.equal(resolveChatAgentBudget({ ragEnabled: true, content: '制度规定是什么？' }).budget.max_tokens_total, 10000);
    } finally {
        if (original === undefined) delete process.env.AGENT_TASK_MAX_TOKENS_TOTAL;
        else process.env.AGENT_TASK_MAX_TOKENS_TOTAL = original;
    }
});
