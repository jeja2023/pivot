'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { queryOne, query, execute } = require('../server/db/client');
const { createAgentRunFactory } = require('../server/services/agent-runtime/run-creation');
const { runs: { runAgent } } = require('../server/services/agent-runtime');
const { recordAgentToolCall, listAgentToolCalls } = require('../server/services/agent-tool-audit');
const { agentToolStepId } = require('../server/services/agent-tool-call-identity');
const { providerToolName } = require('../server/services/model-tool-protocol');
const { TaskBudget, normalizeTaskBudget } = require('../server/services/agent-budget');
const { evaluateToolPolicy } = require('../server/services/agent-policy');

test('默认风险容量可完成发现、读取和交付，显式零值及低预算仍执行', () => {
    const budget = new TaskBudget();
    for (let index = 0; index < 16; index++) budget.consumeTool({ name: 'tools.describe', risk_level: 1 });
    for (let index = 0; index < 8; index++) budget.consumeTool({ name: 'mcp.1.read', risk_level: 3, network: true });
    assert.equal(budget.counts.risk, 40);
    const limited = new TaskBudget({ risk_budget: 20 });
    for (let index = 0; index < 6; index++) limited.consumeTool({ risk_level: 3 });
    assert.throws(() => limited.consumeTool({ risk_level: 3 }), error => error.code === 'AGENT_BUDGET_EXCEEDED');
    assert.equal(normalizeTaskBudget({ riskBudget: 0 }).risk_budget, 0);
    assert.equal(normalizeTaskBudget({ risk_budget: 20 }).risk_budget, 20);
    const guarded = evaluateToolPolicy({ run: { approval_policy: 'safe_mcp_auto' }, tool: { name: 'mcp.1.send', source: 'mcp', risk_level: 4, side_effect: true }, input: {}, budget });
    assert.equal(guarded.decision, 'require_approval');
    const effects = new TaskBudget();
    for (let index = 0; index < 10; index++) effects.consumeTool({ name: 'mcp.1.send', risk_level: 1, side_effect: true });
    assert.throws(() => effects.consumeTool({ name: 'mcp.1.send', risk_level: 1, side_effect: true }), /副作用/);
});

test('长步骤标识可真实持久化，审计保留原始关联且不同调用不会覆盖', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const runId = `run_${require('node:crypto').randomBytes(12).toString('hex')}`;
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,created_at,updated_at) VALUES (?,?,'标识边界','验证长调用标识','running',NOW(),NOW())", [runId, user.id]);
    try {
        const raw = `${runId}:1:call_${'c'.repeat(32)}`;
        await recordAgentToolCall({ runId, stepId: raw, operationKey: raw, toolName: 'tools.search', input: { query: '边界验证' }, output: { candidates: [] } });
        await recordAgentToolCall({ runId, stepId: raw + 'different', operationKey: raw + 'different', toolName: 'tools.search', output: {} });
        const long = raw + 'x'.repeat(300);
        await recordAgentToolCall({ runId, stepId: long, operationKey: long, toolName: 'tools.search', output: {} });
        const rows = await query('SELECT step_id,operation_key,context_snapshot FROM agent_tool_calls WHERE run_id = ? ORDER BY created_at,id', [runId]);
        assert.equal(rows.length, 3);
        assert.equal(new Set(rows.map(row => row.step_id)).size, 3);
        assert.ok(rows.every(row => row.step_id.length <= 64));
        assert.ok(rows.every(row => row.operation_key.length <= 255));
        const first = rows.find(row => row.operation_key === raw);
        assert.equal(first.step_id, agentToolStepId(runId, 1, 'call_' + 'c'.repeat(32)));
        const context = typeof first.context_snapshot === 'string' ? JSON.parse(first.context_snapshot) : first.context_snapshot;
        assert.equal(context.originalStepId, raw);
        const listed = (await listAgentToolCalls(runId)).find(row => row.step_id === first.step_id);
        assert.equal(listed.context_snapshot.originalStepId, raw);
        assert.deepEqual(listed.input_payload, { query: '边界验证' });
    } finally { await execute('DELETE FROM agent_runs WHERE id = ?', [runId]); }
});

test('真实原生执行使用兼容名称和长provider调用ID，默认交付核验拒绝未交付的回复', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const saved = Object.fromEntries(['AGENT_STREAMING_TOOLS', 'AGENT_NATIVE_TOOL_CALLS', 'ALLOW_SENSITIVE_OUTBOUND_URLS'].map(key => [key, process.env[key]]));
    Object.assign(process.env, { AGENT_STREAMING_TOOLS: 'true', AGENT_NATIVE_TOOL_CALLS: 'enabled', ALLOW_SENSITIVE_OUTBOUND_URLS: 'true' });
    const counts = new Map(), requests = [], faults = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                requests.push(body);
                for (const message of body.messages) for (const call of message.tool_calls || []) assert.match(call.function.name, /^[A-Za-z0-9_-]{1,64}$/);
                if (body.messages[0]?.content === '检查历史工具协议') {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ choices: [{ message: { content: '历史关联有效' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
                }
                const verify = body.messages[0]?.content.includes('独立核验交付');
                const blocked = body.model.includes('blocked'), awaitingInput = body.model.includes('awaiting');
                if (verify) {
                    const verdict = awaitingInput ? { passed: false, needsInput: true, coveredDeliverables: [], missing: ['请补充收款账号'] }
                        : blocked ? { passed: false, needsInput: false, coveredDeliverables: [], missing: ['尚未生成要求的交付文件'] } : { passed: true, needsInput: false, coveredDeliverables: [], missing: [] };
                    res.writeHead(200, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
                }
                assert.equal(body.stream, true);
                assert.ok(body.tools.every(tool => /^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name)));
                const count = (counts.get(body.model) || 0) + 1;
                counts.set(body.model, count);
                const nativeName = providerToolName('tools.execute');
                const tool = !blocked && !awaitingInput && count < 3;
                const delta = tool ? { tool_calls: [{ index: 0, id: 'call_' + String(count).repeat(32), type: 'function', function: { name: nativeName, arguments: JSON.stringify({ toolName: 'models.list' }) } }] }
                    : { content: awaitingInput ? '请补充收款账号后继续。' : blocked ? '当前无法完成交付，尚未生成文件。' : '已查询当前可用模型并完成交付。' };
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
                res.end('data: [DONE]\n\n');
            } catch (error) { faults.push(error); res.writeHead(500); res.end('{}'); }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        for (const mode of ['success', 'blocked', 'awaiting']) {
            const name = `execution-chain-${mode}-${process.pid}`;
            const model = await queryOne("INSERT INTO models (name,url,model_name,status,supports_tool_calls,tool_call_mode) VALUES (?,?,?,'active',TRUE,'enabled') RETURNING id", [name, `http://127.0.0.1:${server.address().port}/v1`, name]);
            let run;
            try {
                run = await createAgentRunFactory({})({ user, modelId: model.id, goal: mode === 'success' ? '查询可用模型并交付结论' : mode === 'awaiting' ? '登记报销，缺少收款账号时先询问' : '生成文件并提交交付结果', maxSteps: 8, toolAllowlist: ['models.list'], taskContract: {}, metadata: { autoPersonalSkill: false } });
                assert.equal(run.metadata.taskContract.acceptance.requireSemanticVerification, true);
                await runAgent(run.id, user);
                assert.deepEqual(faults, []);
                const final = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [run.id]);
                assert.equal(final.status, mode === 'success' ? 'completed' : 'needs_input', final.error_message);
                assert.equal(final.metadata.taskVerification.outcomeStatus, mode === 'success' ? 'verified' : 'needs_input');
                if (mode === 'awaiting') {
                    assert.equal(counts.get(name), 1);
                    assert.equal(final.metadata.taskVerification.semanticVerification.reason, 'user_input_required');
                }
                if (mode === 'blocked') assert.equal(final.metadata.taskContract.repairAttempts, 2);
                if (mode === 'success') {
                    const historyAnswer = await require('../server/services/agent-model').callModelText({ id: model.id, model_name: name, url: `http://127.0.0.1:${server.address().port}/v1` }, [
                        { role: 'system', content: '检查历史工具协议' },
                        { role: 'assistant', content: '', tool_calls: [{ id: 'history_call', type: 'function', function: { name: 'tools.execute', arguments: '{}' } }] },
                        { role: 'tool', tool_call_id: 'history_call', content: '{}' }
                    ], { user, maxTokens: 64 });
                    assert.equal(historyAnswer, '历史关联有效');
                    const calls = await query('SELECT step_id FROM agent_tool_calls WHERE run_id = ?', [run.id]);
                    assert.ok(calls.length >= 2);
                    assert.ok(calls.every(call => call.step_id.length <= 64));
                    const control = await query("SELECT * FROM agent_steps WHERE run_id = ? AND type = 'control'", [run.id]);
                    assert.equal(control.length, 0);
                }
            } finally {
                if (run) await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
                await execute('DELETE FROM models WHERE id = ?', [model.id]);
            }
        }
        assert.ok(requests.some(body => body.messages[0]?.content.includes('独立核验交付')));
    } finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});
