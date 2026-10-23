'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { queryOne, query, execute } = require('../server/db/client');
const { createAgentRunFactory } = require('../server/services/agent-runtime/run-creation');
const { runs: { runAgent } } = require('../server/services/agent-runtime');

test('real JSON and native Agent runners recover a skipped contract, execute once, verify and finish the transaction', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const previous = { streaming: process.env.AGENT_STREAMING_TOOLS, outbound: process.env.ALLOW_SENSITIVE_OUTBOUND_URLS, native: process.env.AGENT_NATIVE_TOOL_CALLS };
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    const requests = [];
    const counts = new Map();
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const payload = JSON.parse(Buffer.concat(chunks).toString());
            requests.push(payload);
            const count = (counts.get(payload.model) || 0) + 1;
            counts.set(payload.model, count);
            const plan = count < 3 ? { action: 'tool', tool: 'tools.execute', input: { toolName: 'models.list' }, thought: '查询已授权模型' }
                : { action: 'final', answer: count === 3 ? '已完成可用模型查询。' : '已完成可用模型查询，核验通过。', thought: '交付已核验结果' };
            if (payload.stream) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const delta = count < 3 ? { tool_calls: [{ index: 0, id: `execute-${count}`, type: 'function', function: {
                    name: 'tools.execute', arguments: JSON.stringify(plan.input)
                } }] } : { content: plan.answer };
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: count < 3 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
                res.end('data: [DONE]\n\n');
            } else {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const factory = createAgentRunFactory({ enqueueAgentRun() {} });
    try {
        for (const mode of ['json', 'native']) {
            process.env.AGENT_STREAMING_TOOLS = mode === 'json' ? 'false' : 'true';
            process.env.AGENT_NATIVE_TOOL_CALLS = 'enabled';
            const modelName = `flow-audit-${mode}-${process.pid}`;
            const model = await queryOne("INSERT INTO models (user_id,name,url,api_key,model_name,status,created_at,supports_tool_calls,tool_call_mode) VALUES (?,?,?,'',?,'active',NOW(),TRUE,'enabled') RETURNING id", [user.id, modelName, `http://127.0.0.1:${server.address().port}/v1`, modelName]);
            let run;
            try {
                run = await factory({ user, modelId: model.id, goal: '查询我可用的模型并给出结论', toolAllowlist: ['models.list'], maxSteps: 6,
                    metadata: { autoPersonalSkill: false }, taskContract: { acceptance: { requiredPhrases: ['核验通过'] } },
                    budgetConfig: { max_tool_calls: 2, risk_budget: 5 }, retryLimit: 0 });
                await runAgent(run.id, user);
                const completed = await queryOne('SELECT status,error_message,final_answer,metadata FROM agent_runs WHERE id = ?', [run.id]);
                assert.equal(completed.status, 'completed', `${mode}: ${completed.error_message}`);
                assert.equal(completed.final_answer, '已完成可用模型查询，核验通过。');
                const steps = await query('SELECT type,tool_name,status,output,error_message FROM agent_steps WHERE run_id = ? ORDER BY id', [run.id]);
                assert.equal(steps.some(step => step.status === 'error'), false, JSON.stringify(steps.filter(step => step.status === 'error')));
                const outputs = steps.filter(step => step.tool_name === 'tools.execute').map(step => JSON.parse(step.output));
                assert.equal(outputs.length, 2);
                assert.equal(outputs[0].executed, false);
                assert.ok(Array.isArray(outputs[1]));
                const transactions = await query('SELECT status FROM agent_task_transactions WHERE run_id = ?', [run.id]);
                assert.equal(transactions[0].status, 'committed');
                const checkpoints = await query('SELECT tool_name FROM agent_run_checkpoints WHERE run_id = ? AND checkpoint_type = ?', [run.id, 'tool']);
                assert.deepEqual(checkpoints.map(row => row.tool_name).filter(Boolean), ['models.list']);
                assert.equal(counts.get(modelName), 4);
                assert.equal(completed.metadata.taskContract.repairAttempts, 1);
            } finally {
                if (run) await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
                await execute('DELETE FROM models WHERE id = ?', [model.id]);
            }
        }
        assert.ok(requests.some(payload => payload.stream === true));
        assert.ok(requests.some(payload => payload.stream === false));
    } finally {
        for (const [key, value] of [['AGENT_STREAMING_TOOLS', previous.streaming], ['ALLOW_SENSITIVE_OUTBOUND_URLS', previous.outbound], ['AGENT_NATIVE_TOOL_CALLS', previous.native]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
});
