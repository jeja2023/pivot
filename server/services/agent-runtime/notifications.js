const { queryOne } = require('../../db/client');
const { looksLikeCorruptTitle } = require('../agent-validators');
const { getAgentRunTitle, isPreviewAgentRun } = require('./metadata');

function createAgentNotificationFactory({ getTimestamp, publishUserEvent, deliverNotification, createInboxEvent }) {
    return async function createAgentNotification(userId, runId, type, title, body = '') {
        if (!userId || !title) return null;
        const run = runId
            ? await queryOne('SELECT title, goal, metadata FROM agent_runs WHERE id = ?', [runId])
            : null;
        if (run && isPreviewAgentRun(run)) return null;
        const fallbackTitle = run ? getAgentRunTitle(run) : '任务通知';
        const safeTitle = looksLikeCorruptTitle(title) ? fallbackTitle : String(title || '').trim();
        const safeBody = looksLikeCorruptTitle(body) ? fallbackTitle : String(body || '').trim();
        const row = await queryOne(`
            INSERT INTO agent_notifications (user_id, run_id, type, title, body, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'unread', ?)
            RETURNING id
        `, [
            userId,
            runId || null,
            String(type || 'info').slice(0, 40),
            safeTitle.slice(0, 160),
            safeBody.slice(0, 1000),
            getTimestamp()
        ]);
        const notification = await queryOne('SELECT * FROM agent_notifications WHERE id = ?', [row?.id]);
        if (notification) {
            publishUserEvent(userId, 'agent.notification', { notification });
            try { await createInboxEvent?.({ id: userId }, { eventKey: `notification:${notification.id}`, eventType: `notification.${notification.type || 'info'}`, sourceId: notification.id, runId: notification.run_id, title: notification.title, body: notification.body || '', risk: ['approval', 'error'].includes(notification.type) ? 'high' : 'low' }); } catch (_) {}
            try { await deliverNotification?.(userId, notification); } catch (_) {}
        }
        return notification;
    };
}

module.exports = { createAgentNotificationFactory };
