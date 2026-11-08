'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { queryOne, query, execute } = require('../server/db/client');
const { createAgentRunFactory } = require('../server/services/agent-runtime/run-creation');
const { runs: { runAgent } } = require('../server/services/agent-runtime');

test('普通和流式运行器连续参数错误后可修复继续，无法修复时有界收尾并保留正文', async () => {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    const keys = ['AGENT_STREAMING_TOOLS', 'ALLOW_SENSITIVE_OUTBOUND_URLS', 'AGENT_NATIVE_TOOL_CALLS'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    process.env.AGENT_NATIVE_TOOL_CALLS = 'enabled';
    const requests = new Map();
    const service = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const payload = JSON.parse(Buffer.concat(chunks));
            const history = requests.get(payload.model) || [];
            history.push(payload);
            requests.set(payload.model, history);
            const count = history.length;
            const isFallback = JSON.stringify(payload.messages).includes('本次工具能力不可用');
            const stalled = payload.model.includes('stalled');
            const final = isFallback || (!stalled && count >= 6);
            const answer = isFallback ? '工具参数暂未修复，可先梳理目标与步骤，再核对处理结果；本次未完成工具查询。' : '建议先梳理目标与步骤，再核对处理结果。';
            const input = !stalled && count === 5 ? { query: '模型目录', limit: 1 } : { query: 7, limit: '5', extra: true };
            if (payload.stream && !isFallback) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const delta = final ? { content: answer } : { tool_calls: [{ index: 0, id: `repair-${count}`, type: 'function', function: { name: 'tools.search', arguments: JSON.stringify(input) } }] };
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: final ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
                res.end('data: [DONE]\n\n');
            } else {
                res.writeHead(200, { 'content-type': 'application/json' });
                const content = isFallback ? answer : JSON.stringify(final ? { action: 'final', answer } : { action: 'tool', tool: 'tools.search', input });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
            }
        });
    });
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    try {
        for (const mode of ['json', 'native']) {
            for (const scenario of ['repaired', 'stalled']) {
                process.env.AGENT_STREAMING_TOOLS = mode === 'native' ? 'true' : 'false';
                const name = `input-${scenario}-${mode}-${process.pid}`;
                const model = await queryOne("INSERT INTO models (user_id,name,url,api_key,model_name,status,created_at,supports_tool_calls,tool_call_mode) VALUES (?,?,?,'',?,'active',NOW(),TRUE,'enabled') RETURNING id", [user.id, name, `http://127.0.0.1:${service.address().port}/v1`, name]);
                let run;
                try {
                    run = await createAgentRunFactory({ enqueueAgentRun() {} })({ user, modelId: model.id, goal: '解释任务处理流程，给出通用文字建议', maxSteps: 9,
                        toolAllowlist: ['models.list'], taskContract: { acceptance: { requiredPhrases: ['梳理目标与步骤'] } }, metadata: { autoPersonalSkill: false }, retryLimit: 0 });
                    await runAgent(run.id, user);
                    const row = await queryOne('SELECT status,error_message,final_answer,usage_stats,metadata FROM agent_runs WHERE id = ?', [run.id]);
                    const steps = await query("SELECT output,status FROM agent_steps WHERE run_id = ? AND type = 'tool' ORDER BY step_index", [run.id]);
                    const history = requests.get(name);
                    assert.ok(steps.length >= 4, `${mode}/${scenario}: ${row.error_message}`);
                    assert.match(row.final_answer, /梳理目标与步骤/);
                    assert.ok(['completed', 'completed_with_errors', 'partial', 'needs_input'].includes(row.status), `${mode}/${scenario}: ${row.status}: ${row.error_message}`);
                    const failures = steps.filter(step => JSON.stringify(step.output).includes('TOOL_INPUT_INVALID'));
                    assert.equal(failures.length, scenario === 'repaired' ? 4 : 6);
                    const feedback = JSON.stringify(history[1].messages);
                    assert.match(feedback, /TOOL_INPUT_INVALID/);
                    assert.match(feedback, /inputSchema/);
                    assert.match(feedback, /executed[^\n]{0,20}false/);
                    const usage = typeof row.usage_stats === 'string' ? JSON.parse(row.usage_stats) : row.usage_stats;
                    assert.equal(usage.counts.consecutive_errors, 0);
                    if (scenario === 'repaired') {
                        assert.ok(steps.some(step => step.status !== 'error'));
                        assert.equal(history.length, 6);
                    } else {
                        assert.equal(history.length, 7);
                        assert.equal(row.status, 'partial');
                        assert.match(row.final_answer, /未完成工具查询/);
                    }
                } finally {
                    if (run) await execute('DELETE FROM agent_runs WHERE id = ?', [run.id]);
                    await execute('DELETE FROM models WHERE id = ?', [model.id]);
                }
            }
        }
    } finally {
        for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
        service.closeAllConnections?.();
        await new Promise(resolve => service.close(resolve));
    }
});
