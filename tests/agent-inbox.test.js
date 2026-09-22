const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { listAgentInbox } = require('../server/services/agent-inbox');

test('收件箱只展示一次工作流完成通知，兼容隐藏历史镜像事件', async () => {
    const suffix = crypto.randomBytes(6).toString('hex');
    const user = await queryOne(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', '收件箱去重测试', 'QA', 'user', 'active', NOW() AT TIME ZONE 'Asia/Shanghai')
        RETURNING id
    `, [`agent_inbox_dedupe_${suffix}`]);
    const userId = Number(user.id);
    try {
        const runId = `workflow-run-${suffix}`;
        await execute(`
            INSERT INTO agent_runs (id, user_id, goal, run_mode, status, created_at, updated_at)
            VALUES (?, ?, '收件箱测试', 'dag', 'completed', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai')
        `, [runId, userId]);
        const notification = await queryOne(`
            INSERT INTO agent_notifications (user_id, run_id, type, title, body, status, created_at)
            VALUES (?, ?, 'completed', '工作流运行已完成', '月度汇总工作流', 'unread', NOW() AT TIME ZONE 'Asia/Shanghai')
            RETURNING id
        `, [userId, runId]);
        await execute(`
            INSERT INTO agent_inbox_events (user_id, event_key, event_type, source_run_id, source_id, title, body, status, created_at, updated_at)
            VALUES (?, ?, 'notification.completed', ?, ?, '工作流运行已完成', '月度汇总工作流', 'unread', NOW() AT TIME ZONE 'Asia/Shanghai', NOW() AT TIME ZONE 'Asia/Shanghai')
        `, [userId, `notification:${notification.id}`, runId, String(notification.id)]);

        const inbox = await listAgentInbox({ id: userId }, { limit: 20 });
        assert.equal(inbox.data.filter(item => item.sourceType === 'notification').length, 1);
        assert.equal(inbox.data.filter(item => item.sourceType === 'event').length, 0);
        assert.equal(inbox.unread, 1);
    } finally {
        await execute('DELETE FROM users WHERE id = ?', [userId]);
    }
});

test('运行通知不再额外镜像为通用收件箱事件', () => {
    const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', 'server', 'services', 'agent-runtime', 'notifications.js'), 'utf8');
    assert.doesNotMatch(source, /createInboxEvent/);
    assert.doesNotMatch(source, /eventKey:\s*`notification:/);
});
