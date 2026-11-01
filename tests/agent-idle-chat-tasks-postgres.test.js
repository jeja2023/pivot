'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { query, queryOne, execute } = require('../server/db/client');
const { expireIdleChatTasks } = require('../server/services/agent-idle-chat-tasks');

test('只结束无待处理副作用的过期会话等待，保留结果并排除近期、审批及非会话任务', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const session = `idle-session-${suffix}`;
    await execute('INSERT INTO sessions (id,user_id,title,created_at) VALUES (?,?,?,NOW())', [session, user.id, '等待测试']);
    const ids = ['old', 'recent', 'approval', 'other', 'effect', 'noanswer', 'message', 'paused'].map(label => `${label}-${suffix}`);
    const metadata = JSON.stringify({ chatBridge: { userMessageId: 1 } });
    try {
        for (const [index, id] of ids.entries()) {
            await execute(`INSERT INTO agent_runs (id,user_id,session_id,title,goal,status,metadata,final_answer,error_message,created_at,updated_at)
                VALUES (?,?,?,'测试','测试',?,?::jsonb,?,'原始缺口',NOW(),NOW() - (? * INTERVAL '1 day'))`,
            [id, user.id, session, index === 2 ? 'approval_required' : 'needs_input', index === 3 ? '{}' : metadata, index === 5 ? '' : '已保留结果', index === 1 ? 1 : 9]);
        }
        await execute("UPDATE agent_runs SET error_message = '智能体运行已由用户暂停，可从安全检查点续跑。' WHERE id = ?", [ids[7]]);
        const transaction = await queryOne("INSERT INTO agent_task_transactions (id,run_id,user_id,status) VALUES (gen_random_uuid(),?,?,'needs_input') RETURNING id", [ids[4], user.id]);
        await execute("INSERT INTO agent_task_effects (id,transaction_id,run_id,effect_type,commit_mode,status,idempotency_key) VALUES (gen_random_uuid(),?,?,'test','manual','planned','key')", [transaction.id, ids[4]]);
        await execute("INSERT INTO agent_control_messages (message_id,user_id,to_run_id,status,payload_hash) VALUES (?,?,?,'pending','hash')", [`message-${suffix}`, user.id, ids[6]]);
        const calls = [];
        const deps = { query, publishAgentRunEvent: async id => calls.push(`publish:${id}`), recordAgentEvent: async event => calls.push(`event:${event.runId}`), finalizeTerminalRun: async id => calls.push(`finalize:${id}`) };
        const totals = await Promise.all([expireIdleChatTasks(deps), expireIdleChatTasks(deps)]);
        assert.equal(totals.reduce((a, b) => a + b, 0), 2);
        const rows = await query('SELECT id,status,final_answer,error_message,metadata,completed_at FROM agent_runs WHERE id = ANY(?::text[])', [ids]);
        const old = rows.find(row => row.id === ids[0]);
        assert.equal(old.status, 'partial');
        assert.equal(old.final_answer, '已保留结果');
        assert.match(old.error_message, /等待补充信息/);
        assert.equal(old.metadata.chatInputPreviousError, '原始缺口');
        assert.ok(old.completed_at);
        assert.equal(rows.find(row => row.id === ids[5]).status, 'error');
        for (const id of ids.filter((_, index) => ![0, 5].includes(index))) assert.notEqual(rows.find(row => row.id === id).status, 'partial', id);
        assert.equal(calls.filter(item => item === `finalize:${ids[0]}`).length, 1);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ANY(?::text[])', [ids]);
        await execute('DELETE FROM sessions WHERE id = ?', [session]);
    }
});
