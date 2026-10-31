'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { queryOne, query, execute } = require('../server/db/client');
const { createAgentRunFactory } = require('../server/services/agent-runtime/run-creation');
const { runs: { runAgent } } = require('../server/services/agent-runtime');

test('普通和流式真实运行器在四次空搜索后暂停，保留目标并等待工具范围修订', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const keys = ['AGENT_STREAMING_TOOLS', 'ALLOW_SENSITIVE_OUTBOUND_URLS', 'AGENT_NATIVE_TOOL_CALLS'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    process.env.AGENT_NATIVE_TOOL_CALLS = 'enabled';
    const counts = new Map();
    const service = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const payload = JSON.parse(Buffer.concat(chunks));
            const count = (counts.get(payload.model) || 0) + 1;
            counts.set(payload.model, count);
            const input = { query: `zzzz_absent_tool_${count}` };
            if (payload.stream) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `search-${count}`, type: 'function', function: { name: 'tools.search', arguments: JSON.stringify(input) } }] }, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
                res.end('data: [DONE]\n\n');
            } else {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ action: 'tool', tool: 'tools.search', input, thought: '查找已授权工具' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
            }
        });
    });
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    try {
        for (const mode of ['json', 'native']) {
            process.env.AGENT_STREAMING_TOOLS = mode === 'native' ? 'true' : 'false';
            const modelName = `empty-search-${mode}-${process.pid}`;
            const model = await queryOne("INSERT INTO models (user_id,name,url,api_key,model_name,status,created_at,supports_tool_calls,tool_call_mode) VALUES (?,?,?,'',?,'active',NOW(),TRUE,'enabled') RETURNING id", [user.id, modelName, `http://127.0.0.1:${service.address().port}/v1`, modelName]);
            let run;
            try {
                run = await createAgentRunFactory({ enqueueAgentRun() {} })({ user, modelId: model.id, goal: '找到并调用绘图工具', maxSteps: 8, toolAllowlist: ['models.list'], metadata: { autoPersonalSkill: false }, retryLimit: 0 });
                await runAgent(run.id, user);
                const row = await queryOne('SELECT status,error_message FROM agent_runs WHERE id = ?', [run.id]);
                assert.equal(row.status, 'needs_input', `${mode}: ${row.error_message}`);
                assert.match(row.error_message, /停止重复搜索/);
                assert.equal(counts.get(modelName), 4);
                const steps = await query("SELECT output FROM agent_steps WHERE run_id = ? AND status = 'error'", [run.id]);
                assert.ok(steps.some(step => JSON.stringify(step.output).includes('TOOL_DISCOVERY_NO_PROGRESS')));
            } finally {
                if (run) await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
                await execute('DELETE FROM models WHERE id = ?', [model.id]);
            }
        }
    } finally {
        for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
        service.closeAllConnections?.();
        await new Promise(resolve => service.close(resolve));
    }
});
