const express = require('express');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');
const { isAdmin, isSuperAdmin } = require('../permissions');

const ANNOUNCEMENT_TYPES = new Set(['system', 'security', 'knowledge', 'normal']);
const ANNOUNCEMENT_PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const ANNOUNCEMENT_TARGETS = new Set(['all', 'unit', 'role', 'users']);
const ANNOUNCEMENT_STATUSES = new Set(['draft', 'published', 'archived']);

const splitTargetValue = (value) => String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

const normalizeList = (value) => {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    return splitTargetValue(value);
};

const normalizeDate = (value) => {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return text.replace('T', ' ').slice(0, 19);
    return text.slice(0, 19);
};

const normalizeAnnouncementPayload = (body = {}, fallback = {}) => {
    const title = String(body.title ?? fallback.title ?? '').trim().slice(0, 120);
    const content = String(body.content ?? fallback.content ?? '').trim().slice(0, 12000);
    const type = ANNOUNCEMENT_TYPES.has(body.type) ? body.type : (ANNOUNCEMENT_TYPES.has(fallback.type) ? fallback.type : 'system');
    const priority = ANNOUNCEMENT_PRIORITIES.has(body.priority) ? body.priority : (ANNOUNCEMENT_PRIORITIES.has(fallback.priority) ? fallback.priority : 'normal');
    const targetType = ANNOUNCEMENT_TARGETS.has(body.targetType || body.target_type)
        ? (body.targetType || body.target_type)
        : (ANNOUNCEMENT_TARGETS.has(fallback.target_type) ? fallback.target_type : 'all');
    const rawTargetValue = body.targetValue ?? body.target_value ?? fallback.target_value ?? '';
    const targetValue = targetType === 'all' ? '' : normalizeList(rawTargetValue).join(',');
    const requireAck = body.requireAck ?? body.require_ack ?? fallback.require_ack ?? 0;
    const showOnLogin = body.showOnLogin ?? body.show_on_login ?? fallback.show_on_login ?? 0;
    const startsAt = body.startsAt !== undefined || body.starts_at !== undefined
        ? normalizeDate(body.startsAt ?? body.starts_at)
        : (fallback.starts_at || null);
    const endsAt = body.endsAt !== undefined || body.ends_at !== undefined
        ? normalizeDate(body.endsAt ?? body.ends_at)
        : (fallback.ends_at || null);
    const status = ANNOUNCEMENT_STATUSES.has(body.status) ? body.status : (ANNOUNCEMENT_STATUSES.has(fallback.status) ? fallback.status : 'draft');
    return {
        title,
        content,
        type,
        priority,
        targetType,
        targetValue,
        requireAck: requireAck === true || requireAck === 1 || requireAck === '1' ? 1 : 0,
        showOnLogin: showOnLogin === true || showOnLogin === 1 || showOnLogin === '1' ? 1 : 0,
        startsAt,
        endsAt,
        status
    };
};

const getAnnouncementAdminPermissions = (user) => ({
    canManageAll: isSuperAdmin(user),
    canCreate: isAdmin(user),
    canShowOnLogin: isSuperAdmin(user),
    allowedTargetTypes: isSuperAdmin(user) ? ['all', 'unit', 'role', 'users'] : ['unit'],
    defaultTargetType: isSuperAdmin(user) ? 'all' : 'unit',
    defaultTargetValue: isSuperAdmin(user) ? '' : String(user?.unit || '')
});

const enforceAnnouncementAdminScope = (req, res, payload, current = null) => {
    if (payload.showOnLogin && !isSuperAdmin(req.user)) {
        res.status(403).json({ error: '只有 admin 权限层级可以发布登录页公告' });
        return false;
    }
    if (payload.showOnLogin && payload.targetType !== 'all') {
        res.status(400).json({ error: '登录页公告必须面向全员投放' });
        return false;
    }
    if (isSuperAdmin(req.user)) return true;
    if (!req.user?.unit) {
        res.status(403).json({ error: '当前管理员未配置单位，无法发布单位公告' });
        return false;
    }
    if (current && Number(current.created_by) !== Number(req.user.id)) {
        res.status(403).json({ error: '仅可管理自己创建的公告' });
        return false;
    }
    const unitValues = splitTargetValue(payload.targetValue);
    if (payload.targetType !== 'unit' || unitValues.length !== 1 || unitValues[0] !== req.user.unit) {
        res.status(403).json({ error: '普通管理员仅可向自己的单位发布公告' });
        return false;
    }
    return true;
};

const mapAnnouncementRow = (row = {}) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    type: row.type || 'system',
    priority: row.priority || 'normal',
    targetType: row.target_type || 'all',
    targetValue: row.target_value || '',
    requireAck: Number(row.require_ack || 0) === 1,
    showOnLogin: Number(row.show_on_login || 0) === 1,
    startsAt: row.starts_at || '',
    endsAt: row.ends_at || '',
    status: row.status || 'draft',
    createdBy: row.created_by || null,
    createdByName: row.created_by_name || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    deletedAt: row.deleted_at || '',
    readAt: row.read_at || '',
    acknowledgedAt: row.acknowledged_at || '',
    dismissedAt: row.dismissed_at || ''
});

const isTargetedToUser = (row, user) => {
    const targetType = row.target_type || 'all';
    if (targetType === 'all') return true;
    const values = splitTargetValue(row.target_value).map(item => item.toLowerCase());
    if (targetType === 'role') return values.includes(String(user.role || 'user').toLowerCase());
    if (targetType === 'unit') return values.includes(String(user.unit || '').toLowerCase());
    if (targetType === 'users') {
        return values.includes(String(user.id)) || values.includes(String(user.username || '').toLowerCase());
    }
    return false;
};

const isVisibleAfterUserDismiss = (row) => {
    return !row.dismissed_at || (Number(row.require_ack || 0) === 1 && !row.acknowledged_at);
};

const getActiveAnnouncementRows = () => {
    return db.prepare(`
        SELECT a.*, ar.read_at, ar.acknowledged_at, ar.dismissed_at
        FROM announcements a
        LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = ?
        WHERE a.deleted_at IS NULL
          AND a.status = 'published'
          AND (a.starts_at IS NULL OR a.starts_at <= ?)
          AND (a.ends_at IS NULL OR a.ends_at >= ?)
        ORDER BY
          CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          a.created_at DESC,
          a.id DESC
    `);
};

const getPublicAnnouncementRows = () => {
    return db.prepare(`
        SELECT a.*
        FROM announcements a
        WHERE a.deleted_at IS NULL
          AND a.status = 'published'
          AND a.show_on_login = 1
          AND a.target_type = 'all'
          AND (a.starts_at IS NULL OR a.starts_at <= ?)
          AND (a.ends_at IS NULL OR a.ends_at >= ?)
        ORDER BY
          CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          a.created_at DESC,
          a.id DESC
        LIMIT 5
    `);
};

function createAnnouncementsRouter({
    authMiddleware,
    adminMiddleware,
    normalizePage,
    normalizeLimit,
    logAction
}) {
    const router = express.Router();

    router.get('/announcements/public', asyncHandler(async (_req, res) => {
        const now = getBeijingTimestamp();
        const rows = getPublicAnnouncementRows().all(now, now).map(mapAnnouncementRow);
        res.json({ data: rows });
    }));

    router.get('/announcements/active', authMiddleware, asyncHandler(async (req, res) => {
        const rows = getActiveAnnouncementRows().all(req.user.id, getBeijingTimestamp(), getBeijingTimestamp())
            .filter(row => isTargetedToUser(row, req.user))
            .filter(isVisibleAfterUserDismiss)
            .map(mapAnnouncementRow);
        res.json({
            data: rows,
            unreadCount: rows.filter(item => !item.readAt).length,
            requireAckCount: rows.filter(item => item.requireAck && !item.acknowledgedAt).length
        });
    }));

    const markUserState = (field) => asyncHandler(async (req, res) => {
        const announcementId = parseInt(req.params.id, 10);
        const row = db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').get(announcementId);
        if (!row) return res.status(404).json({ error: '公告不存在' });
        if (!isTargetedToUser(row, req.user)) return res.status(403).json({ error: '无权访问该公告' });
        const now = getBeijingTimestamp();
        if (field === 'read_at') {
            db.prepare(`
                INSERT INTO announcement_reads (announcement_id, user_id, read_at)
                VALUES (?, ?, ?)
                ON CONFLICT(announcement_id, user_id) DO UPDATE SET
                    read_at = COALESCE(announcement_reads.read_at, excluded.read_at)
            `).run(announcementId, req.user.id, now);
        } else {
            db.prepare(`
                INSERT INTO announcement_reads (announcement_id, user_id, read_at, ${field})
                VALUES (?, ?, ?, ?)
                ON CONFLICT(announcement_id, user_id) DO UPDATE SET
                    read_at = COALESCE(announcement_reads.read_at, excluded.read_at),
                    ${field} = excluded.${field}
            `).run(announcementId, req.user.id, now, now);
        }
        res.json({ success: true });
    });

    router.post('/announcements/:id/read', authMiddleware, markUserState('read_at'));
    router.post('/announcements/:id/ack', authMiddleware, markUserState('acknowledged_at'));
    router.post('/announcements/:id/dismiss', authMiddleware, markUserState('dismissed_at'));

    router.get('/admin/announcements', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const page = normalizePage(req.query.page);
        const limit = normalizeLimit(req.query.limit, 50);
        const offset = (page - 1) * limit;
        const status = ANNOUNCEMENT_STATUSES.has(req.query.status) ? req.query.status : '';
        const search = String(req.query.search || '').trim();
        const conditions = ['a.deleted_at IS NULL'];
        const params = [];
        if (!isSuperAdmin(req.user)) {
            conditions.push("a.created_by = ? AND a.target_type = 'unit' AND a.target_value = ?");
            params.push(req.user.id, String(req.user.unit || ''));
        }
        if (status) {
            conditions.push('a.status = ?');
            params.push(status);
        }
        if (search) {
            conditions.push('(a.title LIKE ? OR a.content LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }
        const where = `WHERE ${conditions.join(' AND ')}`;
        const data = db.prepare(`
            SELECT a.*, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS created_by_name,
                   (SELECT COUNT(*) FROM announcement_reads ar WHERE ar.announcement_id = a.id AND ar.read_at IS NOT NULL) AS read_count,
                   (SELECT COUNT(*) FROM announcement_reads ar WHERE ar.announcement_id = a.id AND ar.acknowledged_at IS NOT NULL) AS ack_count
            FROM announcements a
            LEFT JOIN users u ON u.id = a.created_by
            ${where}
            ORDER BY a.updated_at DESC, a.id DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset).map(row => ({
            ...mapAnnouncementRow(row),
            readCount: row.read_count || 0,
            ackCount: row.ack_count || 0,
            canEdit: isSuperAdmin(req.user) || Number(row.created_by) === Number(req.user.id),
            canDelete: isSuperAdmin(req.user) || Number(row.created_by) === Number(req.user.id)
        }));
        const total = db.prepare(`SELECT COUNT(*) AS count FROM announcements a ${where}`).get(...params).count;
        res.json({ data, total, page, limit, permissions: getAnnouncementAdminPermissions(req.user) });
    }));

    router.post('/admin/announcements', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const payload = normalizeAnnouncementPayload(req.body);
        if (!payload.title || !payload.content) return res.status(400).json({ error: '公告标题和内容不能为空' });
        if (payload.targetType !== 'all' && !payload.targetValue) return res.status(400).json({ error: '请填写公告投放范围' });
        if (!enforceAnnouncementAdminScope(req, res, payload)) return;
        const now = getBeijingTimestamp();
        const info = db.prepare(`
            INSERT INTO announcements
                (title, content, type, priority, target_type, target_value, require_ack, show_on_login, starts_at, ends_at, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            payload.title,
            payload.content,
            payload.type,
            payload.priority,
            payload.targetType,
            payload.targetValue,
            payload.requireAck,
            payload.showOnLogin,
            payload.startsAt,
            payload.endsAt,
            payload.status,
            req.user.id,
            now,
            now
        );
        logAction(req, '创建公告', `公告ID: ${info.lastInsertRowid}，标题: ${payload.title}，状态: ${payload.status}`);
        res.json({ success: true, id: info.lastInsertRowid });
    }));

    router.put('/admin/announcements/:id', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const current = db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').get(id);
        if (!current) return res.status(404).json({ error: '公告不存在' });
        const payload = normalizeAnnouncementPayload(req.body, current);
        if (!payload.title || !payload.content) return res.status(400).json({ error: '公告标题和内容不能为空' });
        if (payload.targetType !== 'all' && !payload.targetValue) return res.status(400).json({ error: '请填写公告投放范围' });
        if (!enforceAnnouncementAdminScope(req, res, payload, current)) return;
        const now = getBeijingTimestamp();
        db.prepare(`
            UPDATE announcements
            SET title = ?, content = ?, type = ?, priority = ?, target_type = ?, target_value = ?,
                require_ack = ?, show_on_login = ?, starts_at = ?, ends_at = ?, status = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
        `).run(
            payload.title,
            payload.content,
            payload.type,
            payload.priority,
            payload.targetType,
            payload.targetValue,
            payload.requireAck,
            payload.showOnLogin,
            payload.startsAt,
            payload.endsAt,
            payload.status,
            now,
            id
        );
        logAction(req, '修改公告', `公告ID: ${id}，标题: ${payload.title}，状态: ${payload.status}`);
        res.json({ success: true });
    }));

    router.delete('/admin/announcements/:id', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const row = db.prepare('SELECT title, created_by, target_type, target_value FROM announcements WHERE id = ? AND deleted_at IS NULL').get(id);
        if (!row) return res.status(404).json({ error: '公告不存在' });
        if (!enforceAnnouncementAdminScope(req, res, {
            targetType: row.target_type || 'all',
            targetValue: row.target_value || ''
        }, row)) return;
        db.prepare('UPDATE announcements SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
            .run(getBeijingTimestamp(), getBeijingTimestamp(), id);
        logAction(req, '删除公告', `公告ID: ${id}，标题: ${row.title}`);
        res.json({ success: true });
    }));

    return router;
}

module.exports = {
    createAnnouncementsRouter,
    isTargetedToUser,
    normalizeAnnouncementPayload,
    getAnnouncementAdminPermissions
};
