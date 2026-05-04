/* 管理员运营统计路由 Admin Stats Routes */
const express = require('express');
const path = require('path');
const { db } = require('../db');
const { asyncHandler } = require('../http');

function createAdminStatsRouter({
    authMiddleware,
    adminMiddleware,
    logAction,
    escapeCsvCell,
    getCachedDirSize
}) {
    const router = express.Router();

    router.get('/usage', authMiddleware, asyncHandler(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        const query = `
            SELECT u.username, u.nickname, m.name as model_name,
                   COUNT(msg.id) as msg_count,
                   SUM(msg.token_count) as total_tokens,
                   MAX(msg.created_at) as last_active
            FROM messages msg
            JOIN users u ON msg.user_id = u.id
            LEFT JOIN models m ON msg.model_id = m.id
            ${isAdmin ? '' : 'WHERE msg.user_id = ?'}
            GROUP BY u.id, msg.model_id
            ORDER BY last_active DESC
        `;
        const stats = isAdmin ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
        res.json(stats);
    }));

    router.get('/trend', authMiddleware, asyncHandler(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        const query = `
            SELECT date(created_at) as day, SUM(token_count) as tokens
            FROM messages
            WHERE created_at >= date('now', '+8 hours', '-30 days')
            ${isAdmin ? '' : 'AND user_id = ?'}
            GROUP BY day
            ORDER BY day
        `;
        const trend = isAdmin ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
        res.json(trend);
    }));

    router.get('/report', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const { unit, username, days = 30 } = req.query;
        let conditions = ["m.created_at >= date('now', '+8 hours', '-' || ? || ' days')"];
        let params = [parseInt(days, 10) || 30];

        if (unit) {
            conditions.push("u.unit = ?");
            params.push(unit);
        }
        if (username) {
            conditions.push("u.username LIKE ?");
            params.push(`%${username}%`);
        }

        const whereClause = 'WHERE ' + conditions.join(' AND ');

        const trend = db.prepare(`
            SELECT date(m.created_at) as day, SUM(m.token_count) as tokens
            FROM messages m JOIN users u ON m.user_id = u.id
            ${whereClause}
            GROUP BY day ORDER BY day
        `).all(...params);

        const byUser = db.prepare(`
            SELECT u.username, u.nickname, SUM(m.token_count) as tokens
            FROM messages m JOIN users u ON m.user_id = u.id
            ${whereClause}
            GROUP BY u.id ORDER BY tokens DESC LIMIT 10
        `).all(...params);

        const byUnit = db.prepare(`
            SELECT COALESCE(u.unit, '未分配') as unit, SUM(m.token_count) as tokens
            FROM messages m JOIN users u ON m.user_id = u.id
            ${whereClause}
            GROUP BY COALESCE(u.unit, '未分配') ORDER BY tokens DESC
        `).all(...params);

        // Filter out options for select dropdowns
        const units = db.prepare("SELECT DISTINCT unit FROM users WHERE unit IS NOT NULL AND unit != ''").all().map(r => r.unit);

        res.json({ trend, byUser, byUnit, units });
    }));

    router.get('/ops-summary', authMiddleware, asyncHandler(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        if (isAdmin) {
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
                auditToday: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE date(timestamp) = date('now', '+8 hours')").get().count,
                isPersonal: false
            };
            res.json(summary);
        } else {
            const summary = {
                sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(req.user.id).count,
                messages: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(req.user.id).count,
                attachments: db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE user_id = ?').get(req.user.id).count,
                models: db.prepare("SELECT COUNT(*) AS count FROM models WHERE user_id IS NULL OR user_id = ?").get(req.user.id).count,
                tokens: db.prepare('SELECT COALESCE(SUM(token_count), 0) AS total FROM messages WHERE user_id = ?').get(req.user.id).total,
                isPersonal: true
            };
            res.json(summary);
        }
    }));

    router.get('/details', authMiddleware, asyncHandler(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const offset = (page - 1) * limit;

        const query = `
            SELECT m.id, m.created_at, u.username, u.nickname, md.name as model_name,
                   m.role, m.token_count
            FROM messages m
            JOIN users u ON m.user_id = u.id
            LEFT JOIN models md ON m.model_id = md.id
            ${isAdmin ? '' : 'WHERE m.user_id = ?'}
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
        `;
        const details = isAdmin ? db.prepare(query).all(limit, offset) : db.prepare(query).all(req.user.id, limit, offset);

        const countQuery = `SELECT COUNT(*) as count FROM messages ${isAdmin ? '' : 'WHERE user_id = ?'}`;
        const total = isAdmin ? db.prepare(countQuery).get().count : db.prepare(countQuery).get(req.user.id).count;
        res.json({ data: details, total });
    }));

    router.get('/details/export', authMiddleware, asyncHandler(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        const query = `
            SELECT m.created_at, u.username, u.nickname, md.name as model_name, m.role, m.token_count
            FROM messages m
            JOIN users u ON m.user_id = u.id
            LEFT JOIN models md ON m.model_id = md.id
            ${isAdmin ? '' : 'WHERE m.user_id = ?'}
            ORDER BY m.created_at DESC LIMIT 10000
        `;
        const details = isAdmin ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
        let csv = '\uFEFF时间,用户名,显示名,模型,角色,消耗Token\n';
        details.forEach(d => {
            csv += [d.created_at, d.username, d.nickname || '', d.model_name || '未知', d.role === 'user' ? '提问' : '回答', d.token_count].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出用量明细', `导出 ${details.length} 条明细`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=usage_details.csv');
        res.send(csv);
    }));


    return router;
}

module.exports = { createAdminStatsRouter };
