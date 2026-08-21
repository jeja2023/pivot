/* 管理员用户管理路由 Admin User Management Routes */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const { query, queryOne, execute, transaction } = require('../db/client');
const { asyncHandler } = require('../http');
const { register, validatePassword } = require('../auth');
const {
    encodeAttachmentUrl,
    escapeCsvCell,
    parseCsvLine
} = require('../security');
const { getBeijingTimestamp } = require('../time');
const { getAuditActionFilterValues, localizeAuditLogRow } = require('../audit-actions');
const { flushAllWrites } = require('../services/db-write-queue');
const { buildComplianceAuditPackage } = require('../services/compliance-package');
const { archiveDeletedUsernameAsync } = require('../services/user-identity');
const {
    getPublicRegistrationSetting,
    setPublicRegistrationSetting
} = require('../services/registration-settings');
const {
    SUPER_ADMIN_USERNAME,
    getPermissionLabel,
    getPermissionTier,
    isSuperAdmin,
    normalizeRole,
    withPermissionFlags
} = require('../permissions');

async function revokeUserAutomation(userId, now, reason = '账号已被禁用或删除') {
    await execute(`
        UPDATE agent_schedules
        SET status = 'paused', next_run_at = NULL, dispatch_retry_at = NULL,
            claim_token = NULL, claim_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE user_id = ? AND deleted_at IS NULL
    `, [reason, now, userId]);
    await execute(`
        UPDATE agent_runs
        SET status = 'cancelled', error_message = ?, cancelled_at = ?, completed_at = ?,
            locked_by = NULL, lock_expires_at = NULL, updated_at = ?
        WHERE user_id = ? AND deleted_at IS NULL
          AND status IN ('queued', 'running', 'approval_required', 'awaiting_approval')
    `, [reason, now, now, now, userId]);
}

function createAdminUsersRouter({
    authMiddleware,
    adminMiddleware,
    upload,
    logAction
}) {
    const router = express.Router();
    const requireSuperAdmin = (req, res) => {
        if (isSuperAdmin(req.user)) return true;
        res.status(403).json({ error: '仅 admin 权限层级可执行该操作' });
        return false;
    };

    router.get('/admin/users', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const offset = (page - 1) * limit;
        const includeDeleted = req.query.includeDeleted === 'true' && isSuperAdmin(req.user);
        const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
        const users = (await query(`
            SELECT id, COALESCE(NULLIF(deleted_username, ''), username) AS username,
                   nickname, unit, role, status, deleted_at, created_at, last_login_at
            FROM users
            ${where}
            ORDER BY id ASC LIMIT ? OFFSET ?
        `, [limit, offset])).map(withPermissionFlags);
        const totalRow = await queryOne(`SELECT COUNT(*) as count FROM users ${where}`);
        const total = Number(totalRow?.count || 0);
        res.json({
            data: users,
            total,
            isSuperAdmin: isSuperAdmin(req.user),
            permissionTier: getPermissionTier(req.user),
            permissionLabel: getPermissionLabel(req.user),
            allowPublicRegistration: getPublicRegistrationSetting()
        });
    }));

    router.put('/admin/users/registration', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        if (!isSuperAdmin(req.user)) {
            return res.status(403).json({ error: '只有 admin 权限层级可以修改开放注册设置' });
        }
        const enabled = req.body?.allowPublicRegistration === true;
        const allowPublicRegistration = setPublicRegistrationSetting(enabled, req.user.id);
        logAction(req, '修改开放注册设置', allowPublicRegistration ? '已开启开放注册' : '已关闭开放注册');
        res.json({ success: true, allowPublicRegistration });
    }));

    router.post('/admin/users', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const { username, password, nickname, unit, role } = req.body;
        if (role === 'admin' && !isSuperAdmin(req.user)) {
            return res.status(403).json({ error: '只有 admin 权限层级可以创建 manager 账号' });
        }
        try {
            const user = await register(username, password, nickname, unit, role);
            logAction(req, '创建用户', `创建账号: ${user.username}，角色: ${user.role}`);
            res.json({ success: true, user });
        } catch (e) {
            if (e.status === 400) return res.status(400).json({ error: e.message });
            throw e;
        }
    }));

    router.put('/admin/users/:id', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const targetUserId = parseInt(req.params.id, 10);
        const { nickname, unit, role, status } = req.body;
        const safeRole = normalizeRole(role);
        const safeStatus = status === 'disabled' ? 'disabled' : 'active';

        const targetUser = await queryOne('SELECT username, role, deleted_at FROM users WHERE id = ?', [targetUserId]);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });
        if (targetUser.deleted_at) return res.status(400).json({ error: '用户已删除，不能修改' });
        if (!isSuperAdmin(req.user) && (targetUser.role === 'admin' || safeRole === 'admin')) {
            return res.status(403).json({ error: '只有 admin 权限层级可以修改 manager 账号或授予 manager 权限' });
        }

        if (targetUser.username === SUPER_ADMIN_USERNAME && (safeRole !== 'admin' || safeStatus === 'disabled')) {
            return res.status(400).json({ error: '不能降低或禁用内置 admin 账号权限' });
        }
        if (targetUserId === req.user.id && (safeRole !== 'admin' || safeStatus === 'disabled')) {
            return res.status(400).json({ error: '不能降低或禁用自己的管理员权限' });
        }
        const now = getBeijingTimestamp();
        const changed = await execute(
            'UPDATE users SET nickname = ?, unit = ?, role = ?, status = ? WHERE id = ?',
            [nickname, unit, safeRole, safeStatus, targetUserId]
        );
        if (safeStatus === 'disabled' && changed > 0) await revokeUserAutomation(targetUserId, now);
        if (changed === 0) return res.status(404).json({ error: '用户不存在' });
        logAction(req, '修改用户', `用户ID: ${targetUserId}，角色: ${safeRole}，状态: ${safeStatus}`);
        res.json({ success: true });
    }));

    router.post('/admin/users/:id/password', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const targetUserId = parseInt(req.params.id, 10);
        const { password } = req.body;
        const targetUser = await queryOne('SELECT username, role, deleted_at FROM users WHERE id = ?', [targetUserId]);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });
        if (targetUser.deleted_at) return res.status(400).json({ error: '用户已删除，不能重置密码' });
        if (targetUser.username === SUPER_ADMIN_USERNAME) return res.status(400).json({ error: '内置 admin 账号密码不可由其他用户重置' });
        if (!isSuperAdmin(req.user) && targetUser.role === 'admin') return res.status(403).json({ error: '只有 admin 权限层级可以重置 manager 密码' });
        try {
            validatePassword(password);
        } catch (e) {
            if (e.status === 400) return res.status(400).json({ error: e.message });
            throw e;
        }
        const hash = bcrypt.hashSync(password, 10);
        await transaction(async () => {
            await execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, targetUserId]);
            await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [targetUserId]);
        });
        logAction(req, '重置密码', `用户ID: ${targetUserId}`);
        res.json({ success: true });
    }));

    router.get('/admin/logs/export', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        await flushAllWrites().catch(() => {});
        const { username, action, details, ip, start, end } = req.query;
        let conditions = [];
        let params = [];
        if (username) { conditions.push("COALESCE(NULLIF(u.deleted_username, ''), u.username) ILIKE ?"); params.push(`%${username}%`); }
        if (action) {
            const actionValues = getAuditActionFilterValues(action);
            const placeholders = actionValues.map(() => '?').join(', ');
            conditions.push(`(al.action ILIKE ? ${actionValues.length > 0 ? `OR al.action IN (${placeholders})` : ''})`);
            params.push(`%${action}%`, ...actionValues);
        }
        if (details) { conditions.push("al.details ILIKE ?"); params.push(`%${details}%`); }
        if (ip) { conditions.push("al.ip_address ILIKE ?"); params.push(`%${ip}%`); }
        if (start) { conditions.push("al.timestamp >= ?"); params.push(start + ' 00:00:00'); }
        if (end) { conditions.push("al.timestamp <= ?"); params.push(end + ' 23:59:59'); }

        const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const logs = await query(`
            SELECT al.*, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname
            FROM audit_logs al
            LEFT JOIN users u ON al.user_id = u.id
            ${whereClause}
            ORDER BY al.timestamp DESC NULLS LAST, al.id DESC
            LIMIT 10000
        `, params);

        let csv = '\uFEFF序号,时间,用户,显示名,IP,操作,详情\n';
        logs.map(localizeAuditLogRow).forEach((l, i) => {
            csv += [i + 1, l.timestamp, l.username || '系统', l.nickname || (l.username ? '' : '系统'), l.ip_address || '-', l.action, l.details || ''].map(escapeCsvCell).join(',') + '\n';
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
        const packageBuffer = await buildComplianceAuditPackage({
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
        const users = await query(`
            SELECT id, COALESCE(NULLIF(deleted_username, ''), username) AS username,
                   nickname, unit, role, status, deleted_at, created_at
            FROM users
            ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
            LIMIT 10000
        `);
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
        const sessions = await query(`
            SELECT s.*,
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count,
                   (SELECT COUNT(*) FROM attachments a WHERE a.session_id = s.id) AS attachment_count
            FROM sessions s
            WHERE s.user_id = ? ${deletedFilter}
            ORDER BY COALESCE(s.updated_at, s.created_at) DESC
            LIMIT 1000
        `, [targetUserId]);
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

        const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM messages m ${where}`, params);
        const total = Number(totalRow?.count || 0);

        const userMessages = await query(`
            SELECT m.*, s.title AS session_title, md.name AS model_name
            FROM messages m
            LEFT JOIN sessions s ON s.id = m.session_id
            LEFT JOIN models md ON md.id = m.model_id
            ${where}
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        // 逐条并行查询对应的 assistant 消息
        const records = await Promise.all(userMessages.map(async message => {
            const assistant = await queryOne(`
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
            `, [targetUserId, message.session_id, message.id]);
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
        }));

        res.json({ data: records, total, page, limit });
    }));

    router.get('/admin/users/:id/attachments', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        if (!requireSuperAdmin(req, res)) return;
        const targetUserId = parseInt(req.params.id, 10);
        const includeDeleted = req.query.includeDeleted === 'true';
        const deletedFilter = includeDeleted ? '' : 'AND a.deleted_at IS NULL';
        const attachments = (await query(`
            SELECT a.*, s.title AS session_title
            FROM attachments a
            LEFT JOIN sessions s ON s.id = a.session_id
            WHERE a.user_id = ? ${deletedFilter}
            ORDER BY a.created_at DESC
            LIMIT 1000
        `, [targetUserId])).map(item => ({
            ...item,
            url: encodeAttachmentUrl(item.file_path, item.access_token)
        }));
        res.json({ data: attachments });
    }));

    router.post('/admin/users/import', authMiddleware, adminMiddleware, upload.single('file'), asyncHandler(async (req, res) => {
        if (!req.file) return res.status(400).json({ error: '请选择 CSV 文件' });
        const content = fs.readFileSync(req.file.path, 'utf-8');
        const lines = content.split('\n').slice(1);
        let count = 0;
        let skipped = 0;
        const skippedRows = [];
        const usernamePattern = /^[a-zA-Z0-9_.-]{3,32}$/;

        for (const [index, line] of lines.entries()) {
            const cleanLine = line.trim();
            if (!cleanLine) continue;
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

            // 跳过表头行
            if (!username || username === 'username' || username === '用户名') continue;

            const cleanUsername = String(username).trim();
            if (!usernamePattern.test(cleanUsername)) {
                skipped++;
                skippedRows.push({ line: index + 2, username: cleanUsername, reason: '用户名需为 3-32 位字母、数字、点、下划线或短横线' });
                continue;
            }

            let userHash;
            if (password) {
                try {
                    validatePassword(String(password));
                } catch (e) {
                    skipped++;
                    skippedRows.push({ line: index + 2, username: cleanUsername, reason: '密码强度不足：至少 8 位且同时包含字母和数字' });
                    continue;
                }
                userHash = bcrypt.hashSync(String(password), 10);
            } else {
                const randomPassword = `Pv${crypto.randomBytes(12).toString('hex')}9`;
                userHash = bcrypt.hashSync(randomPassword, 10);
            }

            try {
                await execute(
                    'INSERT INTO users (username, nickname, unit, role, status, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [cleanUsername, nickname || cleanUsername, unit || '', (role === 'admin' && isSuperAdmin(req.user)) ? 'admin' : 'user', status === 'disabled' ? 'disabled' : 'active', userHash, getBeijingTimestamp()]
                );
                count++;
            } catch (e) {
                skipped++;
                skippedRows.push({ line: index + 2, username: cleanUsername, reason: '插入失败（可能用户名已存在）' });
            }
        }

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        logAction(req, '导入用户', `成功导入 ${count} 名用户，跳过 ${skipped} 行`);
        res.json({ success: true, count, skipped, skippedRows });
    }));

    router.get('/admin/logs', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        await flushAllWrites().catch(() => {});
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const offset = (page - 1) * limit;

        const { username, action, details, ip, start, end } = req.query;
        let conditions = [];
        let params = [];

        if (username) {
            conditions.push("COALESCE(NULLIF(u.deleted_username, ''), u.username) ILIKE ?");
            params.push(`%${username}%`);
        }
        if (action) {
            const actionValues = getAuditActionFilterValues(action);
            const placeholders = actionValues.map(() => '?').join(', ');
            conditions.push(`(l.action ILIKE ? ${actionValues.length > 0 ? `OR l.action IN (${placeholders})` : ''})`);
            params.push(`%${action}%`, ...actionValues);
        }
        if (details) {
            conditions.push("l.details ILIKE ?");
            params.push(`%${details}%`);
        }
        if (ip) {
            conditions.push("l.ip_address ILIKE ?");
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

        const logs = await query(`
            SELECT l.*, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname
            FROM audit_logs l
            LEFT JOIN users u ON l.user_id = u.id
            ${whereClause}
            ORDER BY l.timestamp DESC NULLS LAST, l.id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const totalRow = await queryOne(`
            SELECT COUNT(*) as count
            FROM audit_logs l
            LEFT JOIN users u ON l.user_id = u.id
            ${whereClause}
        `, params);
        const total = Number(totalRow?.count || 0);

        res.json({ data: logs.map(localizeAuditLogRow), total });
    }));

    router.delete('/admin/users/:id', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const targetUserId = parseInt(req.params.id, 10);
        if (targetUserId === req.user.id) return res.status(400).json({ error: '不能删除自己' });
        const targetUser = await queryOne('SELECT id, username, role, deleted_at FROM users WHERE id = ?', [targetUserId]);
        if (!targetUser) return res.status(404).json({ error: '用户不存在' });
        if (targetUser.deleted_at) return res.json({ success: true });
        if (targetUser.username === SUPER_ADMIN_USERNAME) return res.status(400).json({ error: '内置 admin 账号禁止删除' });
        if (targetUser.role === 'admin' && !isSuperAdmin(req.user)) {
            return res.status(403).json({ error: '只有 admin 权限层级可以删除 manager 账号' });
        }
        if (targetUser.role === 'admin') {
            const countRow = await queryOne("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status != 'disabled' AND deleted_at IS NULL");
            if (Number(countRow?.count || 0) <= 1) return res.status(400).json({ error: '系统必须保留至少一个可用管理员' });
        }

        const now = getBeijingTimestamp();
        await transaction(async () => {
            await revokeUserAutomation(targetUserId, now);
            await execute('DELETE FROM refresh_tokens WHERE user_id = ?', [targetUserId]);
            await execute("UPDATE api_keys SET status = 'disabled' WHERE user_id = ?", [targetUserId]);
            await execute('UPDATE sessions SET deleted_at = ?, deleted_by_user = 0 WHERE user_id = ? AND deleted_at IS NULL', [now, targetUserId]);
            await execute('UPDATE messages SET deleted_at = ?, deleted_by_user = 0 WHERE user_id = ? AND deleted_at IS NULL', [now, targetUserId]);
            await execute('UPDATE attachments SET deleted_at = ?, deleted_by_user = 0 WHERE user_id = ? AND deleted_at IS NULL', [now, targetUserId]);
            await execute('UPDATE knowledge_docs SET deleted_at = ?, deleted_by_user = 0, is_enabled = 0, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL', [now, now, targetUserId]);
            await execute("UPDATE users SET status = 'disabled', deleted_at = ?, deleted_by_admin = ? WHERE id = ? AND deleted_at IS NULL", [now, req.user.id, targetUserId]);
            await archiveDeletedUsernameAsync(targetUserId);
        });

        logAction(req, '删除用户', `删除账号: ${targetUser.username} (ID: ${targetUserId})`);
        res.json({ success: true });
    }));

    return router;
}

module.exports = { createAdminUsersRouter };
