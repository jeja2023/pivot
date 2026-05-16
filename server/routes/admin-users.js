/* 管理员用户管理路由 Admin User Management Routes */
const bcrypt = require('bcryptjs');
const express = require('express');
const fs = require('fs');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const { register, validatePassword } = require('../auth');
const {
    escapeCsvCell,
    parseCsvLine
} = require('../security');
const { getBeijingTimestamp } = require('../time');
const { getAuditActionFilterValues, localizeAuditLogRow } = require('../audit-actions');
const { buildComplianceAuditPackage } = require('../services/compliance-package');

function createAdminUsersRouter({
    authMiddleware,
    adminMiddleware,
    upload,
    logAction
}) {
    const router = express.Router();
    const isSuperAdmin = (user) => user?.username === 'admin';
    const requireSuperAdmin = (req, res) => {
        if (isSuperAdmin(req.user)) return true;
        res.status(403).json({ error: '仅超级管理员 admin 可执行该操作' });
        return false;
    };

    router.get('/admin/users', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const offset = (page - 1) * limit;
        const includeDeleted = req.query.includeDeleted === 'true' && isSuperAdmin(req.user);
        const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
        const users = db.prepare(`
            SELECT id, username, nickname, unit, role, status, deleted_at, created_at, last_login_at
            FROM users
            ${where}
            ORDER BY id ASC LIMIT ? OFFSET ?
        `).all(limit, offset);
        const total = db.prepare(`SELECT COUNT(*) as count FROM users ${where}`).get().count;
        res.json({ data: users, total, isSuperAdmin: isSuperAdmin(req.user) });
    }));

    router.post('/admin/users', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const { username, password, nickname, unit, role } = req.body;
        if (role === 'admin' && !isSuperAdmin(req.user)) {
            return res.status(403).json({ error: '只有 admin 超级管理员可以创建管理员账号' });
        }
        const user = register(username, password, nickname, unit, role);
        logAction(req, '创建用户', `创建账号: ${user.username}，角色: ${user.role}`);
        res.json({ success: true, user });
    }));

    router.put('/admin/users/:id', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const targetUserId = parseInt(req.params.id, 10);
        const { nickname, unit, role, status } = req.body;
        const safeRole = role === 'admin' ? 'admin' : 'user';
        const safeStatus = status === 'disabled' ? 'disabled' : 'active';

        const targetUser = db.prepare('SELECT username, role, deleted_at FROM users WHERE id = ?').get(targetUserId);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });
        if (targetUser.deleted_at) return res.status(400).json({ error: '用户已删除，不能修改' });
        if (!isSuperAdmin(req.user) && (targetUser.role === 'admin' || safeRole === 'admin')) {
            return res.status(403).json({ error: '只有 admin 超级管理员可以修改管理员账号或授予管理员角色' });
        }
        
        if (targetUser.username === 'admin' && (safeRole !== 'admin' || safeStatus === 'disabled')) {
            return res.status(400).json({ error: '不能降低或禁用内置管理员权限' });
        }
        if (targetUserId === req.user.id && (safeRole !== 'admin' || safeStatus === 'disabled')) {
            return res.status(400).json({ error: '不能降低或禁用自己的管理员权限' });
        }
        const info = db.prepare('UPDATE users SET nickname = ?, unit = ?, role = ?, status = ? WHERE id = ?')
          .run(nickname, unit, safeRole, safeStatus, targetUserId);
        if (info.changes === 0) return res.status(404).json({ error: '用户不存在' });
        logAction(req, '修改用户', `用户ID: ${targetUserId}，角色: ${safeRole}，状态: ${safeStatus}`);
        res.json({ success: true });
    }));

    router.post('/admin/users/:id/password', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const targetUserId = parseInt(req.params.id, 10);
        const { password } = req.body;
        const targetUser = db.prepare('SELECT username, role, deleted_at FROM users WHERE id = ?').get(targetUserId);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });
        if (targetUser.deleted_at) return res.status(400).json({ error: '用户已删除，不能重置密码' });
        if (targetUser.username === 'admin') return res.status(400).json({ error: '内置管理员密码不可由其他用户重置' });
        if (!isSuperAdmin(req.user) && targetUser.role === 'admin') return res.status(403).json({ error: '只有 admin 超级管理员可以重置管理员密码' });
        validatePassword(password);
        const hash = bcrypt.hashSync(password, 10);
        const resetPasswordTx = db.transaction(() => {
            const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, targetUserId);
            db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(targetUserId);
            return info;
        });
        const info = resetPasswordTx();
        if (info.changes === 0) return res.status(404).json({ error: '用户不存在' });
        logAction(req, '重置密码', `用户ID: ${targetUserId}`);
        res.json({ success: true });
    }));

    router.get('/admin/logs/export', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const { username, action, details, ip, start, end } = req.query;
        let conditions = [];
        let params = [];
        if (username) { conditions.push("u.username LIKE ?"); params.push(`%${username}%`); }
        if (action) {
            const actionValues = getAuditActionFilterValues(action);
            conditions.push(`al.action IN (${actionValues.map(() => '?').join(', ')})`);
            params.push(...actionValues);
        }
        if (details) { conditions.push("al.details LIKE ?"); params.push(`%${details}%`); }
        if (ip) { conditions.push("al.ip_address LIKE ?"); params.push(`%${ip}%`); }
        if (start) { conditions.push("al.timestamp >= ?"); params.push(start + ' 00:00:00'); }
        if (end) { conditions.push("al.timestamp <= ?"); params.push(end + ' 23:59:59'); }
        
        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const logs = db.prepare(`
            SELECT al.*, u.username 
            FROM audit_logs al 
            LEFT JOIN users u ON al.user_id = u.id 
            ${whereClause}
            ORDER BY al.timestamp DESC 
            LIMIT 10000
        `).all(...params);
        
        let csv = '\uFEFF序号,时间,用户,IP,操作,详情\n';
        logs.map(localizeAuditLogRow).forEach((l, i) => {
            csv += [i + 1, l.timestamp, l.username || '系统', l.ip_address || '-', l.action, l.details || ''].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出审计日志', `导出 ${logs.length} 条日志${whereClause ? ' (已筛选)' : ''}`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=audit_logs.csv');
        res.send(csv);
    }));

    router.get('/admin/compliance/export', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const start = String(req.query.start || '').trim();
        const end = String(req.query.end || '').trim();
        const includeDeleted = req.query.includeDeleted === 'true' && isSuperAdmin(req.user);
        const packageBuffer = buildComplianceAuditPackage({
            db,
            escapeCsvCell,
            generatedAt: getBeijingTimestamp(),
            filters: { start, end, includeDeleted }
        });
        logAction(req, '导出合规审计包', `范围: ${start || '-'} ~ ${end || '-'}，包含删除: ${includeDeleted ? '是' : '否'}`);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename=pivot_compliance_audit.zip');
        res.send(packageBuffer);
    }));

    router.get('/admin/users/export', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const includeDeleted = req.query.includeDeleted === 'true' && isSuperAdmin(req.user);
        const users = db.prepare(`SELECT * FROM users ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} LIMIT 10000`).all();
        let csv = '\uFEFFID,用户名,显示名,单位,角色,状态,删除时间,创建时间\n';
        users.forEach(u => {
            csv += [u.id, u.username, u.nickname || '', u.unit || '', u.role, u.status || 'active', u.deleted_at || '', u.created_at].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出用户', `导出 ${users.length} 名用户`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
        res.send(csv);
    }));

    router.get('/admin/users/:id/sessions', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        const targetUserId = parseInt(req.params.id, 10);
        const includeDeleted = req.query.includeDeleted === 'true';
        const deletedFilter = includeDeleted ? '' : 'AND s.deleted_at IS NULL';
        const sessions = db.prepare(`
            SELECT s.*,
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count,
                   (SELECT COUNT(*) FROM attachments a WHERE a.session_id = s.id) AS attachment_count
            FROM sessions s
            WHERE s.user_id = ? ${deletedFilter}
            ORDER BY COALESCE(s.updated_at, s.created_at) DESC
            LIMIT 1000
        `).all(targetUserId);
        res.json({ data: sessions });
    }));

    router.get('/admin/users/:id/messages', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        const targetUserId = parseInt(req.params.id, 10);
        const sessionId = String(req.query.sessionId || '').trim();
        const includeDeleted = req.query.includeDeleted === 'true';
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
        const offset = (page - 1) * limit;
        let where = "WHERE m.user_id = ? AND m.role = 'user'";
        const params = [targetUserId];
        if (sessionId) {
            where += ' AND m.session_id = ?';
            params.push(sessionId);
        }
        if (!includeDeleted) where += ' AND m.deleted_at IS NULL';

        const total = db.prepare(`SELECT COUNT(*) AS count FROM messages m ${where}`).get(...params).count;
        const userMessages = db.prepare(`
            SELECT m.*, s.title AS session_title, md.name AS model_name
            FROM messages m
            LEFT JOIN sessions s ON s.id = m.session_id
            LEFT JOIN models md ON md.id = m.model_id
            ${where}
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        const assistantStmt = db.prepare(`
            SELECT m.content, m.token_count, m.deleted_at, md.name AS model_name
            FROM messages m
            LEFT JOIN models md ON md.id = m.model_id
            WHERE m.user_id = ?
              AND m.session_id = ?
              AND m.role = 'assistant'
              AND m.id > ?
              ${includeDeleted ? '' : 'AND m.deleted_at IS NULL'}
            ORDER BY m.id ASC
            LIMIT 1
        `);

        const records = userMessages.map(message => {
            const assistant = assistantStmt.get(targetUserId, message.session_id, message.id);
            return {
                id: message.id,
                session_id: message.session_id,
                session_title: message.session_title,
                model_name: message.model_name || assistant?.model_name || '',
                created_at: message.created_at,
                deleted_at: message.deleted_at || assistant?.deleted_at || '',
                user_content: message.content,
                assistant_content: assistant?.content || '',
                input_tokens: message.token_count || 0,
                output_tokens: assistant?.token_count || 0
            };
        });

        res.json({ data: records, total, page, limit });
    }));

    router.get('/admin/users/:id/attachments', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        const targetUserId = parseInt(req.params.id, 10);
        const includeDeleted = req.query.includeDeleted === 'true';
        const deletedFilter = includeDeleted ? '' : 'AND a.deleted_at IS NULL';
        const attachments = db.prepare(`
            SELECT a.*, s.title AS session_title,
                   '/' || replace(a.file_path, '\\', '/') || CASE WHEN a.access_token IS NOT NULL AND a.access_token != '' THEN '?token=' || a.access_token ELSE '' END AS url
            FROM attachments a
            LEFT JOIN sessions s ON s.id = a.session_id
            WHERE a.user_id = ? ${deletedFilter}
            ORDER BY a.created_at DESC
            LIMIT 1000
        `).all(targetUserId);
        res.json({ data: attachments });
    }));

    router.post('/admin/users/import', authMiddleware, adminMiddleware, upload.single('file'), asyncHandler(async (req, res) => {
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
            let username, password, nickname, unit, role, status;
            
            const hasIdColumn = /^\d+$/.test(parts[0] || '');
            if (hasIdColumn) {
                username = parts[1];
                nickname = parts[2];
                unit = parts[3];
                role = parts[4];
                status = parts[5];
            } else {
                username = parts[0];
                password = parts[1];
                nickname = parts[2];
                unit = parts[3];
                role = parts[4];
            }
            
            if (username && username !== 'username' && username !== '用户名') {
                try {
                    const userHash = password ? bcrypt.hashSync(String(password), 10) : hash;
                    db.prepare('INSERT INTO users (username, nickname, unit, role, status, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                      .run(username, nickname || username, unit || '', (role === 'admin' && isSuperAdmin(req.user)) ? 'admin' : 'user', status === 'disabled' ? 'disabled' : 'active', userHash, getBeijingTimestamp());
                    count++;
                } catch (e) {
                    skipped++;
                }
            }
        });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        logAction(req, '导入用户', `成功导入 ${count} 名用户，跳过 ${skipped} 行`);
        res.json({ success: true, count, skipped });
    }));

    router.get('/admin/logs', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const offset = (page - 1) * limit;
        
        const { username, action, details, ip, start, end } = req.query;
        let conditions = [];
        let params = [];
        
        if (username) {
            conditions.push("u.username LIKE ?");
            params.push(`%${username}%`);
        }
        if (action) {
            const actionValues = getAuditActionFilterValues(action);
            conditions.push(`l.action IN (${actionValues.map(() => '?').join(', ')})`);
            params.push(...actionValues);
        }
        if (details) {
            conditions.push("l.details LIKE ?");
            params.push(`%${details}%`);
        }
        if (ip) {
            conditions.push("l.ip_address LIKE ?");
            params.push(`%${ip}%`);
        }
        if (start) {
            conditions.push("l.timestamp >= ?");
            params.push(start + ' 00:00:00');
        }
        if (end) {
            conditions.push("l.timestamp <= ?");
            params.push(end + ' 23:59:59');
        }
        
        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        
        const logs = db.prepare(`
            SELECT l.*, u.username
            FROM audit_logs l
            LEFT JOIN users u ON l.user_id = u.id
            ${whereClause}
            ORDER BY l.timestamp DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);
        
        const total = db.prepare(`
            SELECT COUNT(*) as count 
            FROM audit_logs l 
            LEFT JOIN users u ON l.user_id = u.id
            ${whereClause}
        `).get(...params).count;
        
        res.json({ data: logs.map(localizeAuditLogRow), total });
    }));

    router.delete('/admin/users/:id', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const targetUserId = parseInt(req.params.id, 10);
        if (targetUserId === req.user.id) return res.status(400).json({ error: '不能删除自己' });
        const targetUser = db.prepare('SELECT id, username, role, deleted_at FROM users WHERE id = ?').get(targetUserId);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });
        if (targetUser.deleted_at) return res.json({ success: true });
        if (targetUser.username === 'admin') return res.status(400).json({ error: '内置管理员账号禁止删除' });
        if (targetUser.role === 'admin' && !isSuperAdmin(req.user)) {
            return res.status(403).json({ error: '只有 admin 超级管理员可以删除管理员账号' });
        }
        if (targetUser.role === 'admin') {
            const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status != 'disabled' AND deleted_at IS NULL").get().count;
            if (adminCount <= 1) return res.status(400).json({ error: '系统必须保留至少一个可用管理员' });
        }
        const deleteUserTx = db.transaction(() => {
            const now = getBeijingTimestamp();
            db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(targetUserId);
            db.prepare("UPDATE api_keys SET status = 'disabled' WHERE user_id = ?").run(targetUserId);
            db.prepare('UPDATE sessions SET deleted_at = ?, deleted_by_user = 0 WHERE user_id = ? AND deleted_at IS NULL').run(now, targetUserId);
            db.prepare('UPDATE messages SET deleted_at = ?, deleted_by_user = 0 WHERE user_id = ? AND deleted_at IS NULL').run(now, targetUserId);
            db.prepare('UPDATE attachments SET deleted_at = ?, deleted_by_user = 0 WHERE user_id = ? AND deleted_at IS NULL').run(now, targetUserId);
            db.prepare('UPDATE knowledge_docs SET deleted_at = ?, deleted_by_user = 0, is_enabled = 0, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL')
                .run(now, now, targetUserId);
            const info = db.prepare("UPDATE users SET status = 'disabled', deleted_at = ?, deleted_by_admin = ? WHERE id = ? AND deleted_at IS NULL")
                .run(now, req.user.id, targetUserId);
            return info;
        });
        deleteUserTx();
        logAction(req, '删除用户', `删除账号: ${targetUser.username} (ID: ${targetUserId})`);
        res.json({ success: true });
    }));

    return router;
}

module.exports = { createAdminUsersRouter };
