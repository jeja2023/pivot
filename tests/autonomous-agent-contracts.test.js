const assert = require('node:assert/strict');
const test = require('node:test');
const { TaskBudget, BudgetExceededError, normalizeTaskBudget } = require('../server/services/agent-budget');
const { ToolRegistry, normalizeToolContract } = require('../server/services/agent-contracts');
const { enforceToolPolicy, evaluateToolPolicy } = require('../server/services/agent-policy');
const { diagnoseError } = require('../server/services/agent-diagnosis');
const { assertRedirectAllowed, validateNetworkPolicyUrl } = require('../server/services/agent-network-policy');
const { createWorkspaceJail } = require('../server/services/agent-sandbox');
const { compileTraceToWorkflow, normalizeTrace } = require('../server/services/agent-trace-compiler');
const { buildSkillExecutionContext, parseSkillManifest, validateSkillManifest } = require('../server/services/agent-skills');
const { canTransitionAgentRunStatus } = require('../server/services/agent-runtime/state-machine');
const { assertWorkerConfiguration } = require('../desktop/agent-runtime');
const { putAgentBlob } = require('../server/services/agent-blob-store');
const { isModelExtractionTimeoutError, buildExtractorMessages } = require('../server/services/long-term-memory/memory-extraction');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('TaskBudget enforces risk, tool and error circuit breakers', () => {
    const budget = new TaskBudget(normalizeTaskBudget({ max_tool_calls: 1, risk_budget: 3, max_consecutive_errors: 1 }));
    budget.consumeTool({ name: 'safe', risk_level: 2 });
    assert.throws(() => budget.consumeTool({ name: 'write', risk_level: 2 }), BudgetExceededError);
    const errors = new TaskBudget({ max_consecutive_errors: 1 });
    errors.recordError();
    assert.throws(() => errors.recordError(), /连续错误/);
});

test('ToolRegistry normalizes contracts and validates input schemas', () => {
    const contract = normalizeToolContract({ name: 'demo', input_schema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } });
    const registry = new ToolRegistry([contract]);
    assert.equal(registry.validate('demo', {}).length, 1);
    assert.equal(registry.validate('demo', { q: 'ok' }).length, 0);
});

test('read-only tools are inferred idempotent while mutating tools are not', () => {
    assert.equal(normalizeToolContract({ name: 'db.query' }).idempotent, true);
    assert.equal(normalizeToolContract({ name: 'reports.export' }).idempotent, false);
});

test('state machine permits terminal completion directly from planning', () => {
    assert.equal(canTransitionAgentRunStatus('planning', 'completed'), true);
    assert.equal(canTransitionAgentRunStatus('planning', 'completed_with_errors'), true);
    assert.equal(canTransitionAgentRunStatus('replanning', 'completed_with_errors'), true);
});

test('PEP denies disallowed MCP and requires approval for risky calls', () => {
    assert.equal(evaluateToolPolicy({ run: { tool_policy: 'builtin_only' }, tool: { name: 'mcp.1.x', source: 'mcp' } }).decision, 'denied');
    assert.equal(evaluateToolPolicy({ run: { approval_policy: 'approve_all_mcp' }, tool: { name: 'mcp.1.x', source: 'mcp', input_schema: { type: 'object' } }, input: {} }).decision, 'require_approval');
    assert.throws(() => enforceToolPolicy({ run: { approval_policy: 'approve_all_mcp' }, tool: { name: 'mcp.1.x', source: 'mcp', input_schema: { type: 'object' } }, input: {} }), /人工审批/);
    const approvedBudget = new TaskBudget({ max_tool_calls: 1 });
    assert.equal(evaluateToolPolicy({ run: { approval_policy: 'approve_all_mcp' }, tool: { name: 'mcp.1.x', source: 'mcp', input_schema: { type: 'object' } }, input: {}, budget: approvedBudget, allowApproval: true }).decision, 'allow');
    assert.equal(approvedBudget.snapshot().counts.tool_calls, 1);
});

test('content review policy normalizes model references before contract validation', () => {
    const result = evaluateToolPolicy({
        run: { model_id: 42 },
        tool: {
            name: 'agent.content_review',
            input_schema: {
                type: 'object',
                required: ['records', 'model'],
                properties: {
                    records: {},
                    model: { type: 'string' }
                }
            }
        },
        input: {
            data: [{ id: 1, content: '待校对内容' }],
            model: { id: 7, name: '校对模型' }
        }
    });
    assert.equal(result.decision, 'allow');
    assert.equal(result.input.model, '7');
    assert.deepEqual(result.input.records, [{ id: 1, content: '待校对内容' }]);
});

test('long-term memory model extraction classifies timeout as a fallback', () => {
    assert.equal(isModelExtractionTimeoutError(Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' })), true);
    assert.equal(isModelExtractionTimeoutError(new Error('invalid response')), false);
    const messages = buildExtractorMessages([{ id: 1, role: 'user', content: '我偏好中文回答。' }]);
    assert.equal(messages.length, 2);
    assert.match(messages[0].content, /Return only JSON/);
});

test('diagnosis maps policy, network and schema errors', () => {
    assert.equal(diagnoseError(new Error('HTTP 502')).category, 'network');
    assert.equal(diagnoseError(Object.assign(new Error('blocked'), { code: 'AGENT_POLICY_DENIED' })).category, 'policy');
    assert.equal(diagnoseError(new Error('KeyError: missing column')).category, 'schema');
});

test('network policy blocks loopback and validates allowed origins', () => {
    assert.throws(() => validateNetworkPolicyUrl('http://127.0.0.1:8080', { allowed_origins: ['http://127.0.0.1:8080'] }), /loopback/);
    assert.throws(() => validateNetworkPolicyUrl('https://example.com:8443', { allowed_origins: ['https://example.com'], allowed_ports: [443] }), /端口/);
    assert.throws(() => validateNetworkPolicyUrl('https://example.com', {}, { requireAllowlist: true }), /Origin 白名单/);
    assert.doesNotThrow(() => validateNetworkPolicyUrl('http://10.20.30.40:8080', { allowed_origins: ['http://10.20.30.40:8080'], allowed_ports: [8080] }));
    assert.doesNotThrow(() => validateNetworkPolicyUrl('https://sso.example.com', { allowed_origins: ['https://oa.example.com'], allowed_redirect_origins: ['https://sso.example.com'], allowed_ports: [443] }, { isRedirect: true }));
    assert.doesNotThrow(() => assertRedirectAllowed('https://oa.example.com', 'https://sso.example.com', { allow_redirect: true, allowed_redirect_origins: ['https://sso.example.com'] }));
});

test('workspace jail rejects path escapes', () => {
    const jail = createWorkspaceJail(require('node:os').tmpdir(), 'test-task');
    assert.ok(jail.resolve('nested/file.txt').includes('test-task'));
    assert.throws(() => jail.resolve('../outside'), /越权/);
});

test('trace compiler removes failed retries after success and emits a draft DAG', () => {
    const calls = normalizeTrace([
        { id: 'a', tool_name: 'db.query', input: { q: 1 }, status: 'error' },
        { id: 'b', tool_name: 'db.query', input: { q: 1 }, status: 'success', side_effect: false },
        { id: 'c', tool_name: 'reports.export', input: { path: '/tmp/out' }, status: 'success', side_effect: true }
    ], { filterExploration: false });
    assert.equal(calls.length, 2);
    const draft = compileTraceToWorkflow(calls, { variables: { output: '/tmp/out' } });
    assert.equal(draft.draft, true);
    assert.equal(draft.nodes.length, 2);
    assert.equal(draft.dagSpec.nodes.length, 2);
    assert.match(draft.yaml, /nodes:/);
    assert.equal(draft.nodes[1].dependsOn[0], 'step_1');
    assert.equal(draft.nodes[1].sideEffect, true);
});

test('Skill manifest parser and digest validator accept JSON/YAML subset', () => {
    const manifest = parseSkillManifest('id: corp.demo\nname: demo\nversion: 1.0.0\npermissions:\n  - code.execute');
    assert.equal(manifest.name, 'demo');
    const checked = validateSkillManifest({ id: 'corp.demo', name: 'demo', version: '1.0.0' });
    assert.equal(checked.valid, true);
    const context = buildSkillExecutionContext({ id: 'corp.demo', name: 'demo', version: '1.0.0', capabilities: ['code.execute'], tools: ['agent.code'] });
    assert.deepEqual(context.skillCapabilities, ['code.execute']);
    assert.deepEqual(context.skillPermissions, ['code.execute']);
    const legacyFieldContext = buildSkillExecutionContext({ id: 'corp.demo', name: 'demo', version: '1.0.0', permissions: ['code.execute'], tools: ['agent.code'] });
    assert.deepEqual(legacyFieldContext.skillCapabilities, ['code.execute']);
    const unregistered = validateSkillManifest({ id: 'corp.demo', name: 'demo', version: '1.0.0', capabilities: ['not.registered'] });
    assert.equal(unregistered.valid, false);
    assert.match(unregistered.errors.join(' '), /未登记的能力/);
    const nested = parseSkillManifest('id: corp.nested\nname: nested\nversion: 1.0.0\ninputs:\n  file:\n    type: file\n    required: true\noutputs:\n  report:\n    type: file\n');
    assert.equal(nested.inputs.file.required, true);
});

test('Skill minimum capabilities are enforced by the PEP under default deny', () => {
    const httpTool = { name: 'agent.http', network: true, capabilities: ['network.request'] };
    const skillRun = declared => ({ metadata: { skillConstraints: { present: true, reference: 'corp.demo', ...declared } } });

    // 1. 无 Skill 上下文的普通任务不得被误拒。
    const plain = evaluateToolPolicy({ run: {}, tool: httpTool, input: { url: 'https://example.com' } });
    assert.notEqual(plain.decision, 'denied');

    // 2. 声明命中时放行；能力与工具必须同时声明。
    const allowed = evaluateToolPolicy({
        run: skillRun({ capabilities: ['network.request'], tools: ['agent.http'] }),
        tool: httpTool,
        input: { url: 'https://example.com' }
    });
    assert.notEqual(allowed.decision, 'denied');

    // 3. 能力未声明即拒绝。
    const denied = evaluateToolPolicy({
        run: skillRun({ capabilities: ['filesystem.read_workspace'], tools: ['agent.http'] }),
        tool: httpTool,
        input: { url: 'https://example.com' }
    });
    assert.equal(denied.decision, 'denied');

    // 4. Skill 上下文存在但声明为空时拒绝全部工具（A1 的修复目标）。
    const emptyDeclaration = evaluateToolPolicy({
        run: skillRun({ capabilities: [], tools: [] }),
        tool: httpTool,
        input: { url: 'https://example.com' }
    });
    assert.equal(emptyDeclaration.decision, 'denied');
    assert.ok(emptyDeclaration.reasonCodes.includes('skill_capabilities_empty'));
    assert.ok(emptyDeclaration.reasonCodes.includes('skill_tools_empty'));

    // 5. 别名放大已关闭：声明窄能力不能匹配宽能力的工具（A3）。
    const amplified = evaluateToolPolicy({
        run: skillRun({ capabilities: ['code.python_execute'], tools: ['agent.code'] }),
        tool: { name: 'agent.code', capabilities: ['code.execute'] },
        input: { code: 'return 1' }
    });
    assert.equal(amplified.decision, 'denied');
    const duckdbAmplified = evaluateToolPolicy({
        run: skillRun({ capabilities: ['data.duckdb.query'], tools: ['agent.code'] }),
        tool: { name: 'agent.code', capabilities: ['code.execute'] },
        input: { code: 'return 1' }
    });
    assert.equal(duckdbAmplified.decision, 'denied');

    // 6. 收敛方向仍成立：声明父能力可覆盖子能力。
    const narrowed = evaluateToolPolicy({
        run: skillRun({ capabilities: ['code.execute'], tools: ['agent.code'] }),
        tool: { name: 'agent.code', capabilities: ['code.sandbox_eval'] },
        input: { code: 'return 1' }
    });
    assert.notEqual(narrowed.decision, 'denied');

    // 7. legacy_unrestricted 兜底在有效期内放行，到期后自动恢复默认拒绝。
    const effective = evaluateToolPolicy({
        run: skillRun({ capabilities: [], tools: [], legacyUnrestricted: true, legacyUnrestrictedUntil: '2099-01-01 00:00:00' }),
        tool: httpTool,
        input: { url: 'https://example.com' }
    });
    assert.notEqual(effective.decision, 'denied');
    const expired = evaluateToolPolicy({
        run: skillRun({ capabilities: [], tools: [], legacyUnrestricted: true, legacyUnrestrictedUntil: '2000-01-01 00:00:00' }),
        tool: httpTool,
        input: { url: 'https://example.com' }
    });
    assert.equal(expired.decision, 'denied');

    // 8. 调用方自报的 metadata 顶层键不能关闭 Skill 约束。
    const spoofed = evaluateToolPolicy({
        run: { metadata: { skillId: 'corp.demo', skillContextPresent: false, skillLegacyUnrestricted: true } },
        tool: httpTool,
        input: { url: 'https://example.com' }
    });
    assert.equal(spoofed.decision, 'denied');
});

test('desktop worker requires main-process approval and denies direct networking', () => {
    assert.throws(() => assertWorkerConfiguration({ approvedByMainProcess: false }), /审批/);
    assert.throws(() => assertWorkerConfiguration({ approvedByMainProcess: true, networkEnabled: true }), /禁止联网/);
});

test('large audit payloads are stored as content-addressed blobs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-blobs-'));
    const previous = process.env.AGENT_BLOB_DIR;
    process.env.AGENT_BLOB_DIR = root;
    try {
        const result = await putAgentBlob({ text: 'x'.repeat(70 * 1024) }, { runId: 'test-run' });
        assert.equal(result.inline, false);
        assert.match(result.ref, /^agent-blob:\/\/test-run\//);
        assert.equal(fs.existsSync(result.filePath), true);
    } finally {
        if (previous === undefined) delete process.env.AGENT_BLOB_DIR;
        else process.env.AGENT_BLOB_DIR = previous;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
