const { looksLikeCorruptTitle } = require('../agent-validators');
const { getAgentRunTitle, isPreviewAgentRun } = require('./metadata');

function createAgentNotificationFactory({ db, getTimestamp, publishUserEvent }) {
    return function createAgentNotification(userId, runId, type, title, body = '') {
        if (!userId || !title) return null;
        const run = runId
            ? db.prepare('SELECT title, goal, metadata FROM agent_runs WHERE id = ?').get(runId)
            : null;
        if (run && isPreviewAgentRun(run)) return null;
        const fallbackTitle = run ? getAgentRunTitle(run) : '?????';
        const safeTitle = looksLikeCorruptTitle(title) ? fallbackTitle : String(title || '').trim();
        const safeBody = looksLikeCorruptTitle(body) ? fallbackTitle : String(body || '').trim();
        const info = db.prepare(`
            INSERT INTO agent_notifications (user_id, run_id, type, title, body, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'unread', ?)
        `).run(
            userId,
            runId || null,
            String(type || 'info').slice(0, 40),
            safeTitle.slice(0, 160),
            safeBody.slice(0, 1000),
            getTimestamp()
        );
        const notification = db.prepare('SELECT * FROM agent_notifications WHERE id = ?').get(info.lastInsertRowid);
        publishUserEvent(userId, 'agent.notification', { notification });
        return notification;
    };
}

module.exports = { createAgentNotificationFactory };
