/* 管理员用户管理路由 Admin User Management Routes */
const bcrypt = require('bcryptjs');
const express = require('express');
const fs = require('fs');
const db = require('../db');
const { register, validatePassword } = require('../auth');
const {
    escapeCsvCell,
    parseCsvLine,
    removeAttachmentFiles
} = require('../security');
const { getBeijingTimestamp } = require('../time');

function createAdminUsersRouter({
    authMiddleware,
    adminMiddleware,
    upload,
    logAction
}) {
    const router = express.Router();

    router.get('/admin/users', authMiddleware, adminMiddleware, (req, res) => {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const offset = (page - 1) * limit;
        const users = db.prepare('SELECT id, username, nickname, unit, role, status, created_at FROM users ORDER BY id ASC LIMIT ? OFFSET ?').all(limit, offset);
        const total = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        res.json({ data: users, total });
    });

    router.post('/admin/users', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const { username, password, nickname, unit, role } = req.body;
            const user = register(username, password, nickname, unit, role);
            logAction(req, '创建用户', `创建账号: ${user.username}，角色: ${user.role}`);
            res.json({ success: true, user });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.put('/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
        const targetUserId = parseInt(req.params.id, 10);
        const { nickname, unit, role, status } = req.body;
        const safeRole = role === 'admin' ? 'admin' : 'user';
        const safeStatus = status === 'disabled' ? 'disabled' : 'active';
        if (targetUserId === req.user.id && (safeRole !== 'admin' || safeStatus === 'disabled')) {
            return res.status(400).json({ error: '不能降低或禁用自己的管理员权限' });
        }
        const info = db.prepare('UPDATE users SET nickname = ?, unit = ?, role = ?, status = ? WHERE id = ?')
          .run(nickname, unit, safeRole, safeStatus, targetUserId);
        if (info.changes === 0) return res.status(404).json({ error: '用户不存在' });
        logAction(req, '修改用户', `用户ID: ${targetUserId}，角色: ${safeRole}，状态: ${safeStatus}`);
        res.json({ success: true });
    });

    router.post('/admin/users/:id/password', authMiddleware, adminMiddleware, (req, res) => {
        const targetUserId = parseInt(req.params.id, 10);
        try {
            const { password } = req.body;
            validatePassword(password);
            const hash = bcrypt.hashSync(password, 10);
            const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, targetUserId);
            if (info.changes === 0) return res.status(404).json({ error: '用户不存在' });
            logAction(req, '重置密码', `用户ID: ${targetUserId}`);
            res.json({ success: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/admin/logs/export', authMiddleware, adminMiddleware, (req, res) => {
        const logs = db.prepare('SELECT al.*, u.username FROM audit_logs al LEFT JOIN users u ON al.user_id = u.id ORDER BY al.timestamp DESC').all();
        let csv = '\uFEFF序号,时间,用户,IP,操作,详情\n';
        logs.forEach((l, i) => {
            csv += [i + 1, l.timestamp, l.username || '系统', l.ip_address || '-', l.action, l.details || ''].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出审计日志', `导出 ${logs.length} 条日志`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=audit_logs.csv');
        res.send(csv);
    });

    router.get('/admin/users/export', authMiddleware, adminMiddleware, (req, res) => {
        const users = db.prepare('SELECT * FROM users').all();
        let csv = '\uFEFFID,用户名,显示名,单位,角色,状态,创建时间\n';
        users.forEach(u => {
            csv += [u.id, u.username, u.nickname || '', u.unit || '', u.role, u.status || 'active', u.created_at].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出用户', `导出 ${users.length} 名用户`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
        res.send(csv);
    });

    router.post('/admin/users/import', authMiddleware, adminMiddleware, upload.single('file'), (req, res) => {
        if (!req.file) return res.status(400).json({ error: '请选择 CSV 文件' });
        const content = fs.readFileSync(req.file.path, 'utf-8');
        const lines = content.split('\n').slice(1);
        let count = 0;
        let skipped = 0;
        const defaultPassword = process.env.DEFAULT_IMPORTED_PASSWORD || 'ChangeMe123';
        const hash = bcrypt.hashSync(defaultPassword, 10);

        lines.forEach(line => {
            const cleanLine = line.trim();
            if (!cleanLine) return;
            const parts = parseCsvLine(cleanLine);
            const hasIdColumn = /^\d+$/.test(parts[0] || '');
            const username = hasIdColumn ? parts[1] : parts[0];
            const nickname = hasIdColumn ? parts[2] : parts[1];
            const unit = hasIdColumn ? parts[3] : parts[2];
            const role = hasIdColumn ? parts[4] : parts[3];
            const status = hasIdColumn ? parts[5] : parts[4];
            if (username) {
                try {
                    db.prepare('INSERT INTO users (username, nickname, unit, role, status, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                      .run(username, nickname || username, unit || '', role === 'admin' ? 'admin' : 'user', status === 'disabled' ? 'disabled' : 'active', hash, getBeijingTimestamp());
                    count++;
                } catch (e) {
                    skipped++;
                }
            }
        });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        logAction(req, '导入用户', `成功导入 ${count} 名用户，跳过 ${skipped} 行`);
        res.json({ success: true, count, skipped });
    });

    router.get('/admin/logs', authMiddleware, adminMiddleware, (req, res) => {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const offset = (page - 1) * limit;
        const logs = db.prepare(`
            SELECT l.*, u.username
            FROM audit_logs l
            LEFT JOIN users u ON l.user_id = u.id
            ORDER BY l.timestamp DESC
            LIMIT ? OFFSET ?
        `).all(limit, offset);
        const total = db.prepare('SELECT COUNT(*) as count FROM audit_logs').get().count;
        res.json({ data: logs, total });
    });

    router.delete('/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
        const targetUserId = parseInt(req.params.id, 10);
        if (targetUserId === req.user.id) return res.status(400).json({ error: '不能删除自己' });
        const targetUser = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(targetUserId);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });
        if (targetUser.role === 'admin') {
            const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status != 'disabled'").get().count;
            if (adminCount <= 1) return res.status(400).json({ error: '不能删除最后一个可用管理员' });
        }
        const deleteUser = db.transaction(() => {
            const attachments = db.prepare('SELECT file_path FROM attachments WHERE user_id = ?').all(targetUserId);
            const docs = db.prepare('SELECT id FROM knowledge_docs WHERE user_id = ?').all(targetUserId);
            docs.forEach(doc => db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(doc.id));
            db.prepare('DELETE FROM knowledge_docs WHERE user_id = ?').run(targetUserId);
            db.prepare('DELETE FROM attachments WHERE user_id = ?').run(targetUserId);
            db.prepare('DELETE FROM messages WHERE user_id = ?').run(targetUserId);
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
            db.prepare('DELETE FROM models WHERE user_id = ?').run(targetUserId);
            db.prepare('DELETE FROM audit_logs WHERE user_id = ?').run(targetUserId);
            const info = db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);
            removeAttachmentFiles(attachments);
            return info;
        });
        deleteUser();
        logAction(req, '删除用户', `删除账号: ${targetUser.username} (ID: ${targetUserId})`);
        res.json({ success: true });
    });

    return router;
}

module.exports = { createAdminUsersRouter };
