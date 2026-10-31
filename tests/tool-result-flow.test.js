'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createToolPolicyEngine } = require('../server/services/tool-policy-engine');

test('统一调用入口把 MCP 业务错误记为失败，不进入成功日志或输出契约校验', async () => {
    const events = [];
    const engine = createToolPolicyEngine({
        formatToolList: async () => [{ name: 'echo.read', source: 'builtin', input_schema: { type: 'object' } }],
        buildToolExecutionPlan: async ({ input }) => ({ input, policy: { decision: 'allow' }, retry: { retryable: false } }),
        recordToolInvocationEvent: async event => { events.push(event); }
    });
    await assert.rejects(engine.invoke({ actor: { id: 7 }, toolName: 'echo.read', input: {} }, async () => ({
        isError: true, content: [{ type: 'text', text: '绘图语法不正确' }]
    })), error => error.code === 'MCP_TOOL_EXECUTION_ERROR' && error.status === 422);
    assert.equal(events.at(-1).status, 'error');
    assert.equal(events.some(event => event.status === 'success'), false);
});

function runtimeHarness(result) {
    const module = { exports: {} };
    const events = [];
    let deliveries = 0;
    const tool = { name: 'mcp.89.render_diagram', source: 'mcp' };
    const meta = { name: 'tools.execute', source: 'builtin' };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/services/agent-tool-runtime.js'), 'utf8'), {
        module, process, Set, require(name) {
            if (name === './agent-tools') return { executeBuiltInTool: async (_name, _input, user, context) => module.exports.executeToolByName(tool.name, {}, user, [tool], { ...context, discoveredExecution: true }) };
            if (name === './mcp-client') return { executeMcpTool: async () => result };
            if (name === './tool-policy-engine') return { evaluateToolInvocation: async request => ({ input: request.input, executionPlan: {}, tool: request.tool }), validateToolOutput: () => [] };
            if (name === './tool-execution-guard') return { acquire: () => ({ release() {} }) };
            if (name === './agent-shared-tool-guard') return { acquireSharedToolLease: async () => ({ release() {} }) };
            if (name === './tool-invocation-events') return { recordToolInvocationEvent: async event => { events.push(event); } };
            if (name === './agent-tool-orchestrator') return { defaultToolOrchestrator: { execute: async hooks => {
                try { const output = await hooks.execute({ input: hooks.input }); await hooks.onComplete({ output, effectiveInput: hooks.input }); return output; }
                catch (error) { await hooks.onFailure({ error, effectiveInput: hooks.input }); throw error; }
            } } };
            if (name === './tool-result-artifacts') return { materializeToolArtifact: async output => {
                deliveries++;
                assert.ok(output.structuredContent.pivotArtifact.svg, '第二次处理已经移除 SVG 的摘要会失败');
                return { structuredContent: { pivotArtifact: { kind: 'diagram' } }, artifactId: 'artifact', renditionId: 'rendition' };
            } };
            return name.startsWith('.') ? require(path.join(__dirname, '../server/services', name)) : require(name);
        }
    });
    return { execute: () => module.exports.executeToolByName(meta.name, {}, { id: 7 }, [meta], {}), events, deliveries: () => deliveries };
}

test('tools.execute 嵌套业务执行只交付一次产物，外层保留产物标识', async () => {
    const harness = runtimeHarness({ structuredContent: { pivotArtifact: { kind: 'diagram', svg: '<svg/>' } } });
    const result = await harness.execute();
    assert.equal(result.artifactId, 'artifact');
    assert.equal(result.renditionId, 'rendition');
    assert.equal(harness.deliveries(), 1);
    assert.equal(harness.events.filter(event => event.status === 'success').length, 2);
});

test('嵌套执行的 MCP 业务失败不生成产物，并沿两层运行时报告失败', async () => {
    const harness = runtimeHarness({ isError: true, content: [{ type: 'text', text: '绘图失败' }] });
    await assert.rejects(harness.execute(), error => error.code === 'MCP_TOOL_EXECUTION_ERROR');
    assert.equal(harness.deliveries(), 0);
    assert.equal(harness.events.filter(event => event.status === 'error').length, 2);
    assert.equal(harness.events.some(event => event.status === 'success'), false);
});

test('单步测试在 HTTP 成功但 isError 为真时显示失败并保留错误详情', async () => {
    const elements = Object.fromEntries(['name', 'input', 'status', 'result', 'run-btn'].map(id => [`mcp-tool-test-${id}`, { value: id === 'name' ? 'mcp.89.render_diagram' : '{}' }]));
    let api;
    const context = { URL, document: { getElementById: id => elements[id] || null }, API_BASE: '/api',
        apiFetch: async () => ({ ok: true, status: 200, json: async () => ({ result: { isError: true, content: [{ type: 'text', text: '绘图失败' }] } }) }),
        window: { Pivot: { legacy: {}, moduleApi: () => ({}), exposeModule: (_name, exposed) => { api = exposed; } } } };
    vm.createContext(context);
    for (const name of ['mcp-workbench-common.js', 'mcp-workbench-main.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/chat', name), 'utf8'), context);
    await api.runMcpToolTest();
    assert.match(elements['mcp-tool-test-status'].textContent, /执行失败/);
    assert.match(elements['mcp-tool-test-result'].textContent, /绘图失败/);
});

test('任务编辑器无工具控件沿用授权目录，旧界面显式全不选仍拒绝', () => {
    const context = { document: { querySelectorAll: () => [] }, window: { Pivot: { legacy: {} } }, agentToolsCache: [{}] };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/chat/agent-run-actions.js'), 'utf8'), context);
    assert.deepEqual(Array.from(vm.runInContext('getSelectedAgentToolAllowlist()', context)), []);
    context.document.querySelectorAll = selector => selector.endsWith(':checked') ? [] : [{}];
    assert.deepEqual(Array.from(vm.runInContext('getSelectedAgentToolAllowlist()', context)), ['__none__']);
});
