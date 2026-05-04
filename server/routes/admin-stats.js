/* 管理员运营统计路由 Admin Stats Routes */
const express = require('express');
const path = require('path');
const db = require('../db');
const { asyncHandler } = require('../http');

function createAdminStatsRouter({
    authMiddleware,
    adminMiddleware,
    logAction,
    escapeCsvCell,
    getCachedDirSize
}) {
    const router = express.Router();

    router.get('/admin/stats/usage', authMiddleware, adminMiddleware, (req, res) => {
        const stats = db.prepare(`
            SELECT u.username, u.nickname, m.name as model_name,
                   COUNT(msg.id) as msg_count,
                   SUM(msg.token_count) as total_tokens,
                   MAX(msg.created_at) as last_active
            FROM messages msg
            JOIN users u ON msg.user_id = u.id
            LEFT JOIN models m ON msg.model_id = m.id
            GROUP BY u.id, msg.model_id
            ORDER BY last_active DESC
        `).all();
        res.json(stats);
    });

    router.get('/admin/stats/trend', authMiddleware, adminMiddleware, (req, res) => {
        const trend = db.prepare(`
            SELECT date(created_at) as day, SUM(token_count) as tokens
            FROM messages
            WHERE created_at >= date('now', '+8 hours', '-30 days')
            GROUP BY day
            ORDER BY day
        `).all();
        res.json(trend);
    });

    router.get('/admin/ops/summary', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const uploadDir = path.resolve(__dirname, '../../uploads');
        const dataDir = path.resolve(__dirname, '../../data');
        const summary = {
            users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
            activeUsers: db.prepare("SELECT COUNT(*) AS count FROM users WHERE status != 'disabled'").get().count,
            sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
            messages: db.prepare('SELECT COUNT(*) AS count FROM messages').get().count,
            attachments: db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count,
            models: db.prepare('SELECT COUNT(*) AS count FROM models').get().count,
            tokens: db.prepare('SELECT COALESCE(SUM(token_count), 0) AS total FROM messages').get().total,
            uploadsSize: await getCachedDirSize(uploadDir),
            dataSize: await getCachedDirSize(dataDir),
            auditToday: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE date(timestamp) = date('now', '+8 hours')").get().count
        };
        res.json(summary);
    }));

    router.get('/admin/stats/details', authMiddleware, adminMiddleware, (req, res) => {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const offset = (page - 1) * limit;

        const details = db.prepare(`
            SELECT m.id, m.created_at, u.username, u.nickname, md.name as model_name,
                   m.role, m.token_count
            FROM messages m
            JOIN users u ON m.user_id = u.id
            LEFT JOIN models md ON m.model_id = md.id
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
        `).all(limit, offset);

        const total = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
        res.json({ data: details, total });
    });

    router.get('/admin/stats/details/export', authMiddleware, adminMiddleware, (req, res) => {
        const details = db.prepare(`
            SELECT m.created_at, u.username, u.nickname, md.name as model_name, m.role, m.token_count
            FROM messages m
            JOIN users u ON m.user_id = u.id
            LEFT JOIN models md ON m.model_id = md.id
            ORDER BY m.created_at DESC
        `).all();
        let csv = '\uFEFF时间,用户名,显示名,模型,角色,消耗Token\n';
        details.forEach(d => {
            csv += [d.created_at, d.username, d.nickname || '', d.model_name || '未知', d.role === 'user' ? '提问' : '回答', d.token_count].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出用量明细', `导出 ${details.length} 条明细`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=usage_details.csv');
        res.send(csv);
    });

    return router;
}

module.exports = { createAdminStatsRouter };
