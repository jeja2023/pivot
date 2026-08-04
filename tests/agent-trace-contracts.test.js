const test = require('node:test');
const assert = require('node:assert/strict');

const { db } = require('../server/db');
const {
    inspectDagContracts,
    outputValueForContract,
    validateJsonSchemaDefinition,
    validateValueAgainstSchema
} = require('../server/services/agent-dag-contracts');
const {
    ensureAgentTrace,
    finishAgentTraceSpan,
    getAgentTraceForUser,
    startAgentTraceSpan
} = require('../server/services/agent-traces');
const { normalizeDagSpec } = require('../server/services/agent-validators');
const { resolveDagTemplateReference } = require('../server/services/agent-dag-utils');
const {
    buildAgentResumeContext,
    listAgentCheckpointsForUser,
    recordAgentCheckpoint
} = require('../server/services/agent-checkpoints');
const {
    createAgentEvalSuite,
    getAgentEvalRun,
    getAgentEvalSuite,
    gradeAgentOutput,
    listAgentEvalSuites,
    startAgentEvaluation,
    updateAgentEvalSuite
} = require('../server/services/agent-evaluations');
const { executeAgentHandoff, executeBuiltInTool, getBuiltInToolDefinitions } = require('../server/services/agent-tools');
const { listRuns } = require('../server/services/agent-runs');

test('DAG 规范化保留节点输入输出契约', () => {
    const dag = normalizeDagSpec({
        nodes: [{
            id: 'summary',
            title: '总结',
            tool: 'agent.llm',
            input: { model: '1', prompt: '{{goal}}' },
            inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
            outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }
        }]
    });
    assert.equal(dag.nodes[0].inputSchema.required[0], 'prompt');
    assert.equal(dag.nodes[0].outputSchema.properties.answer.type, 'string');
});

test('契约校验支持模板变量并返回可读字段路径', () => {
    const schema = {
        type: 'object',
        required: ['query', 'limit'],
        properties: {
            query: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 10 }
        },
        additionalProperties: false
    };
    assert.deepEqual(validateJsonSchemaDefinition(schema), []);
    assert.deepEqual(validateValueAgainstSchema({ query: '{{goal}}', limit: '{{inputs.limit}}' }, schema, { allowTemplates: true }), []);
    const issues = validateValueAgainstSchema({ query: '风险', limit: 20 }, schema);
    assert.equal(issues.some(issue => issue.includes('值.limit') && issue.includes('不能大于 10')), true);
});

test('工作流契约检查汇总输入覆盖并提示缺少输出契约', () => {
    const report = inspectDagContracts({
        nodes: [{
            id: 'search',
            title: '检索',
            tool: 'rag.search',
            input: { query: '{{goal}}' },
            inputSchema: {},
            outputSchema: {}
        }]
    }, [{
        name: 'rag.search',
        input_schema: {
            type: 'object',
            required: ['query'],
            properties: { query: { type: 'string' } }
        }
    }]);
    assert.equal(report.blockers.length, 0);
    assert.equal(report.summary.inputContractCount, 1);
    assert.equal(report.summary.outputContractCount, 0);
    assert.equal(report.warnings.some(item => item.includes('输出契约')), true);
});

test('大模型 JSON 输出契约校验使用解析后的业务对象', () => {
    const value = outputValueForContract({ content: '{"answer":"完成"}', responseFormat: 'json' }, {
        tool: 'agent.llm',
        input: { responseFormat: 'json' }
    });
    assert.deepEqual(value, { answer: '完成' });
});

test('Agent Trace 对用户隔离并脱敏输入输出', () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', 'Trace User', 'QA', 'user', 'active', datetime('now', '+8 hours'))
    `).run(`trace_user_${suffix}`);
    const otherInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', 'Other User', 'QA', 'user', 'active', datetime('now', '+8 hours'))
    `).run(`trace_other_${suffix}`);
    const user = { id: Number(userInfo.lastInsertRowid) };
    const other = { id: Number(otherInfo.lastInsertRowid) };
    const runId = `trace-run-${suffix}`;
    try {
        db.prepare(`
            INSERT INTO agent_runs (id, user_id, goal, title, status, created_at, updated_at)
            VALUES (?, ?, '检查运行追踪', '追踪测试', 'running', datetime('now', '+8 hours'), datetime('now', '+8 hours'))
        `).run(runId, user.id);
        ensureAgentTrace({ id: runId, user_id: user.id, status: 'running' }, { apiKey: 'trace-secret', mode: 'test' });
        const spanId = startAgentTraceSpan(runId, {
            type: 'tool',
            name: '安全工具调用',
            input: { query: '风险', password: 'do-not-store', nested: { access_token: 'hidden' } }
        });
        finishAgentTraceSpan(spanId, { output: { ok: true, token: 'hidden-output' }, durationMs: 25 });
        const trace = getAgentTraceForUser(runId, user);
        assert.equal(trace.spans.length, 1);
        assert.equal(trace.spans[0].input.password, '[已脱敏]');
        assert.equal(trace.spans[0].input.nested.access_token, '[已脱敏]');
        assert.equal(trace.spans[0].output.token, '[已脱敏]');
        assert.equal(trace.trace.metadata.apiKey, '[已脱敏]');
        assert.equal(getAgentTraceForUser(runId, other), null);
        recordAgentCheckpoint(runId, {
            stepIndex: 2,
            type: 'tool',
            status: 'completed',
            state: { toolName: 'rag.search', input: { query: '风险' }, output: { matches: 2 } }
        });
        recordAgentCheckpoint(runId, {
            stepIndex: 3,
            type: 'tool',
            status: 'error',
            state: { toolName: 'reports.read', errorMessage: '文件不可用' }
        });
        const checkpoints = listAgentCheckpointsForUser(runId, user);
        assert.equal(checkpoints.length, 2);
        assert.equal(listAgentCheckpointsForUser(runId, other), null);
        const resumeContext = buildAgentResumeContext(runId);
        assert.equal(resumeContext.observations[0].tool, 'rag.search');
        assert.equal(resumeContext.recentFailures[0].error, '文件不可用');
    } finally {
        db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId);
        db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(user.id, other.id);
    }
});

test('智能体规则评分同时覆盖内容、JSON 结构、耗时与 Token', () => {
    const graded = gradeAgentOutput({
        run: {
            status: 'completed',
            final_answer: '{"answer":"风险已完成"}',
            duration_ms: 850,
            total_tokens: 320
        },
        evalCase: {
            expected_output: '风险',
            assertions: {
                requiredPhrases: ['完成'],
                forbiddenPhrases: ['失败'],
                requireJson: true,
                maxDurationMs: 1000,
                maxTokens: 500,
                outputSchema: {
                    type: 'object',
                    required: ['answer'],
                    properties: { answer: { type: 'string' } }
                }
            }
        },
        passThreshold: 80
    });
    assert.equal(graded.passed, true);
    assert.equal(graded.score, 100);
    assert.equal(graded.rules.every(rule => rule.passed), true);
});

test('评测集按用户隔离，真实批次可回收评分且编辑不破坏历史结果', () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', 'Eval User', 'QA', 'user', 'active', datetime('now', '+8 hours'))
    `).run(`eval_user_${suffix}`);
    const otherInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', 'Eval Other', 'QA', 'user', 'active', datetime('now', '+8 hours'))
    `).run(`eval_other_${suffix}`);
    const user = { id: Number(userInfo.lastInsertRowid) };
    const other = { id: Number(otherInfo.lastInsertRowid) };
    const createdRunIds = [];
    try {
        const evaluation = createAgentEvalSuite(user, {
            name: '发布质量回归',
            targetType: 'free',
            runConfig: { passThreshold: 80 },
            cases: [{
                name: '风险总结',
                input: '总结风险',
                assertions: { requiredPhrases: ['完成'], maxTokens: 500 }
            }]
        });
        assert.equal(evaluation.cases.length, 1);
        assert.equal(listAgentEvalSuites(user).length, 1);
        assert.equal(getAgentEvalSuite(evaluation.suite.id, other), null);

        const batch = startAgentEvaluation(evaluation.suite.id, user, { modelId: 1 }, options => {
            const runId = `eval-agent-run-${suffix}-${createdRunIds.length + 1}`;
            createdRunIds.push(runId);
            db.prepare(`
                INSERT INTO agent_runs (
                    id, user_id, goal, title, status, final_answer, total_tokens, metadata, created_at, updated_at, completed_at
                ) VALUES (?, ?, ?, ?, 'completed', '任务完成', 120, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'), datetime('now', '+8 hours'))
            `).run(runId, options.user.id, options.goal, options.title, JSON.stringify(options.metadata || {}));
            return { id: runId };
        });
        assert.equal(batch.run.status, 'completed');
        assert.equal(batch.run.summary.passRate, 100);
        assert.equal(batch.results[0].passed, true);
        assert.equal(getAgentEvalRun(batch.run.id, other), null);
        assert.equal(listRuns(user).total, 0);
        assert.equal(listRuns(user, { includePreview: true }).total, 1);

        const updated = updateAgentEvalSuite(evaluation.suite.id, user, {
            name: '发布质量回归',
            targetType: 'free',
            cases: [{ name: '新用例', input: '输出新结果', assertions: { minLength: 2 } }]
        });
        assert.equal(updated.cases.length, 1);
        assert.equal(updated.cases[0].name, '新用例');
        assert.equal(getAgentEvalRun(batch.run.id, user).results[0].case_name, '风险总结');
    } finally {
        db.prepare('DELETE FROM agent_eval_suites WHERE user_id = ?').run(user.id);
        createdRunIds.forEach(runId => db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId));
        db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(user.id, other.id);
    }
});

test('多智能体工具提供隔离委派契约与结构化 Handoff', () => {
    const tools = getBuiltInToolDefinitions({ id: 1, role: 'user' });
    const delegate = tools.find(tool => tool.name === 'agent.delegate');
    const handoff = tools.find(tool => tool.name === 'agent.handoff');
    assert.ok(delegate);
    assert.ok(handoff);
    assert.deepEqual(delegate.input_schema.required, ['task', 'agentName', 'role', 'model']);
    assert.match(delegate.description, /调用一次独立模型/);
    assert.match(delegate.description, /自动附带结构化 Handoff/);
    assert.match(handoff.description, /不调用模型/);
    const output = executeAgentHandoff({
        fromAgent: '研究员',
        toAgent: 'Supervisor',
        summary: '已核验两个来源。',
        findings: ['结论 A'],
        evidence: ['文档 1'],
        risks: ['样本不足'],
        openQuestions: ['是否补充数据'],
        confidence: 0.8
    });
    assert.equal(output.type, 'agent_handoff');
    assert.equal(output.toAgent, 'Supervisor');
    assert.equal(output.findings[0], '结论 A');
    assert.equal(output.confidence, 0.8);
});

test('工作流输出提供轻量的交付格式选项', () => {
    const tools = getBuiltInToolDefinitions({ id: 1, role: 'user' });
    const output = tools.find(tool => tool.name === 'workflow.output');
    assert.ok(output);
    assert.deepEqual(output.input_schema.properties.format.enum, ['markdown', 'text', 'json']);
    assert.deepEqual(output.input_schema.properties.presentation.enum, ['default', 'table', 'file']);
});

test('工作流输出支持表格数据和文件引用交付', async () => {
    const table = await executeBuiltInTool('workflow.output', {
        name: 'rows',
        value: [{ customer: '甲', total: 2 }, { customer: '乙', total: 3 }],
        presentation: 'table'
    }, { id: 1 });
    assert.equal(table.presentation, 'table');
    assert.deepEqual(table.table.columns, ['customer', 'total']);
    assert.equal(table.table.rowCount, 2);

    const file = await executeBuiltInTool('workflow.output', {
        name: 'download',
        value: { id: 'file-1', name: '结果.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        presentation: 'file'
    }, { id: 1 });
    assert.equal(file.presentation, 'file');
    assert.equal(file.file.id, 'file-1');
    await assert.rejects(() => executeBuiltInTool('workflow.output', { name: 'bad', value: 'not-a-file', presentation: 'file' }, { id: 1 }), /文件产物需要提供文件引用对象/);
});

test('下游字段引用可以读取大模型 JSON 内容的嵌套路径', () => {
    const states = new Map([['extract', { output: { content: '{"customer":{"name":"甲"}}' } }]]);
    const nodeMap = new Map([['extract', { id: 'extract', title: '抽取' }]]);
    assert.equal(resolveDagTemplateReference('nodes.extract.output.customer.name', { states, nodeMap }), '甲');
});
