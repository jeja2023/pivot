const assert = require('node:assert/strict');
const test = require('node:test');
const { TaskBudget, BudgetExceededError, normalizeTaskBudget } = require('../server/services/agent-budget');
const { ToolRegistry, normalizeToolContract } = require('../server/services/agent-contracts');
const { enforceToolPolicy, evaluateToolPolicy } = require('../server/services/agent-policy');
const { diagnoseError } = require('../server/services/agent-diagnosis');
const { validateNetworkPolicyUrl } = require('../server/services/agent-network-policy');
const { createWorkspaceJail } = require('../server/services/agent-sandbox');
const { compileTraceToWorkflow, normalizeTrace } = require('../server/services/agent-trace-compiler');
const { parseSkillManifest, validateSkillManifest } = require('../server/services/agent-skills');
const { canTransitionAgentRunStatus } = require('../server/services/agent-runtime/state-machine');
const { assertWorkerConfiguration } = require('../desktop/agent-runtime');
const { putAgentBlob } = require('../server/services/agent-blob-store');
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
});

test('PEP denies disallowed MCP and requires approval for risky calls', () => {
    assert.equal(evaluateToolPolicy({ run: { tool_policy: 'builtin_only' }, tool: { name: 'mcp.1.x', source: 'mcp' } }).decision, 'denied');
    assert.equal(evaluateToolPolicy({ run: { approval_policy: 'approve_all_mcp' }, tool: { name: 'mcp.1.x', source: 'mcp', input_schema: { type: 'object' } }, input: {} }).decision, 'require_approval');
    assert.throws(() => enforceToolPolicy({ run: { approval_policy: 'approve_all_mcp' }, tool: { name: 'mcp.1.x', source: 'mcp', input_schema: { type: 'object' } }, input: {} }), /人工审批/);
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
    assert.equal(draft.nodes[1].dependsOn[0], 'step_1');
});

test('Skill manifest parser and digest validator accept JSON/YAML subset', () => {
    const manifest = parseSkillManifest('id: corp.demo\nname: demo\nversion: 1.0.0\npermissions:\n  - code.execute');
    assert.equal(manifest.name, 'demo');
    const checked = validateSkillManifest({ id: 'corp.demo', name: 'demo', version: '1.0.0' });
    assert.equal(checked.valid, true);
});

test('desktop worker requires explicit approval and network policy allowlist', () => {
    assert.throws(() => assertWorkerConfiguration({ approved: false }), /审批/);
    assert.throws(() => assertWorkerConfiguration({ approved: true, networkEnabled: true, networkPolicy: { allowed_origins: [] } }), /allowlist/);
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
