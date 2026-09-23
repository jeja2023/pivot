'use strict';

/** 演示文稿评论批注与协作者管理业务服务。 */
const { query, queryOne, execute } = require('../../db/client');
const { assertTenantContext } = require('../agent-tenant-context');
const { isAdmin } = require('../../permissions');
const { publishPresentationRealtime } = require('./presentation-realtime');
const { publishUserEvent } = require('../realtime-events');

function publicError(message, status = 400, code = 'PRESENTATION_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function createCollabService(deps) {
    const { getPresentationRow, assertPresentationCommenter, assertPresentationEditor } = deps;

    async function listPresentationComments(user, clientId, options = {}) {
        const current = await getPresentationRow(user, clientId, { includeContent: false });
        if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
        const slideId = options.slideId !== undefined ? String(options.slideId).trim() : null;
        const status = ['open', 'resolved'].includes(String(options.status)) ? String(options.status) : null;

        const conditions = ['c.presentation_id = ?', 'c.deleted_at IS NULL'];
        const params = [current.id];

        if (slideId !== null && slideId !== '') {
            conditions.push('c.slide_id = ?');
            params.push(slideId);
        }
        if (status) {
            conditions.push('c.status = ?');
            params.push(status);
        }

        const rows = await query(`
            SELECT c.*,
                   COALESCE(NULLIF(u.nickname, ''), u.username) AS user_name,
                   u.username,
                   COALESCE(NULLIF(ru.nickname, ''), ru.username) AS resolved_by_name
            FROM presentation_comments c
            LEFT JOIN users u ON u.id = c.user_id
            LEFT JOIN users ru ON ru.id = c.resolved_by
            WHERE ${conditions.join(' AND ')}
            ORDER BY c.created_at ASC, c.id ASC
        `, params);

        const roots = [];
        const replyMap = new Map();
        rows.forEach(r => {
            const item = {
                id: Number(r.id),
                presentationId: current.client_id,
                slideId: r.slide_id,
                elementId: r.element_id || null,
                userId: Number(r.user_id),
                userName: r.user_name || '用户',
                username: r.username || '',
                content: r.content,
                status: r.status,
                parentId: r.parent_id ? Number(r.parent_id) : null,
                resolvedBy: r.resolved_by ? Number(r.resolved_by) : null,
                resolvedByName: r.resolved_by_name || null,
                resolvedAt: r.resolved_at,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                replies: []
            };
            if (item.parentId) {
                const list = replyMap.get(item.parentId) || [];
                list.push(item);
                replyMap.set(item.parentId, list);
            } else {
                roots.push(item);
            }
        });

        roots.forEach(root => {
            root.replies = replyMap.get(root.id) || [];
        });

        return { comments: roots, total: rows.length };
    }

    async function createPresentationComment(user, clientId, body = {}) {
        const current = await getPresentationRow(user, clientId, { includeContent: false });
        if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
        assertPresentationCommenter(user, current);
        const content = String(body.content || '').trim();
        if (!content) throw publicError('评论内容不能为空。', 400, 'PRESENTATION_COMMENT_EMPTY');
        if (content.length > 2000) throw publicError('评论内容不能超过 2000 个字符。', 400, 'PRESENTATION_COMMENT_TOO_LONG');

        const slideId = String(body.slideId || '').trim().slice(0, 64);
        const elementId = body.elementId ? String(body.elementId).trim().slice(0, 64) : null;
        const parentId = body.parentId ? Number.parseInt(body.parentId, 10) : null;

        if (parentId) {
            const parent = await queryOne('SELECT id, presentation_id FROM presentation_comments WHERE id = ? AND presentation_id = ? AND deleted_at IS NULL', [parentId, current.id]);
            if (!parent) throw publicError('回复的评论不存在。', 404, 'PRESENTATION_COMMENT_PARENT_NOT_FOUND');
        }

        const tenant = await assertTenantContext(user);
        const row = await queryOne(`
            INSERT INTO presentation_comments
                (tenant_id, presentation_id, slide_id, element_id, user_id, parent_id, content, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NOW(), NOW())
            RETURNING *
        `, [tenant.tenantId, current.id, slideId, elementId, user.id, parentId, content]);

        publishPresentationRealtime(current.id, 'presentation.comments', { presentationId: current.client_id, changedBy: user.id }).catch(() => {});
        return {
            id: Number(row.id),
            presentationId: current.client_id,
            slideId: row.slide_id,
            elementId: row.element_id,
            userId: Number(row.user_id),
            userName: user.nickname || user.username || '我',
            username: user.username,
            content: row.content,
            status: row.status,
            parentId: row.parent_id ? Number(row.parent_id) : null,
            resolvedBy: null,
            resolvedByName: null,
            resolvedAt: null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            replies: []
        };
    }

    async function resolvePresentationComment(user, clientId, commentId) {
        const current = await getPresentationRow(user, clientId, { includeContent: false });
        if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
        assertPresentationEditor(user, current);
        const id = Number.parseInt(commentId, 10);
        const comment = await queryOne('SELECT * FROM presentation_comments WHERE id = ? AND presentation_id = ? AND deleted_at IS NULL', [id, current.id]);
        if (!comment) throw publicError('评论不存在。', 404, 'PRESENTATION_COMMENT_NOT_FOUND');

        const nextStatus = comment.status === 'open' ? 'resolved' : 'open';
        const resolvedBy = nextStatus === 'resolved' ? user.id : null;

        const row = await queryOne(`
            UPDATE presentation_comments
            SET status = ?, resolved_by = ?, resolved_at = ${nextStatus === 'resolved' ? 'NOW()' : 'NULL'}, updated_at = NOW()
            WHERE id = ?
            RETURNING *
        `, [nextStatus, resolvedBy, id]);

        publishPresentationRealtime(current.id, 'presentation.comments', { presentationId: current.client_id, changedBy: user.id }).catch(() => {});
        return {
            id: Number(row.id),
            status: row.status,
            resolvedBy: row.resolved_by ? Number(row.resolved_by) : null,
            resolvedAt: row.resolved_at
        };
    }

    async function deletePresentationComment(user, clientId, commentId) {
        const current = await getPresentationRow(user, clientId, { includeContent: false });
        if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
        const id = Number.parseInt(commentId, 10);
        const comment = await queryOne('SELECT * FROM presentation_comments WHERE id = ? AND presentation_id = ? AND deleted_at IS NULL', [id, current.id]);
        if (!comment) throw publicError('评论不存在。', 404, 'PRESENTATION_COMMENT_NOT_FOUND');
        if (Number(comment.user_id) !== Number(user.id) && Number(current.owner_user_id) !== Number(user.id) && !isAdmin(user)) {
            throw publicError('无权删除该评论。', 403, 'PRESENTATION_COMMENT_FORBIDDEN');
        }

        await execute('UPDATE presentation_comments SET deleted_at = NOW() WHERE id = ? OR parent_id = ?', [id, id]);
        publishPresentationRealtime(current.id, 'presentation.comments', { presentationId: current.client_id, changedBy: user.id }).catch(() => {});
        return { success: true, id };
    }

    async function listPresentationCollaborators(user, clientId) {
        const current = await getPresentationRow(user, clientId, { includeContent: false });
        if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
        const owner = await queryOne('SELECT id, username, nickname FROM users WHERE id = ?', [current.owner_user_id]);
        const rows = await query(`
            SELECT pc.*, COALESCE(NULLIF(u.nickname, ''), u.username) AS user_name, u.username
            FROM presentation_collaborators pc
            JOIN users u ON u.id = pc.user_id
            WHERE pc.presentation_id = ?
            ORDER BY pc.created_at ASC
        `, [current.id]);
        return {
            owner: {
                userId: Number(owner?.id || current.owner_user_id),
                userName: owner?.nickname || owner?.username || '所有人',
                username: owner?.username || ''
            },
            collaborators: rows.map(r => ({
                id: Number(r.id),
                userId: Number(r.user_id),
                userName: r.user_name || '协作者',
                username: r.username || '',
                role: r.role,
                createdAt: r.created_at
            }))
        };
    }

    async function addPresentationCollaborator(user, clientId, body = {}) {
        const current = await getPresentationRow(user, clientId, { includeContent: false });
        if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
        if (Number(current.owner_user_id) !== Number(user.id) && !isAdmin(user)) {
            throw publicError('只有文稿所有者或管理员可以添加协作者。', 403, 'PRESENTATION_COLLABORATOR_ADMIN_REQUIRED');
        }
        const usernameOrId = String(body.username || body.userId || '').trim();
        if (!usernameOrId) throw publicError('必须指定协作者用户名或用户 ID。', 400, 'PRESENTATION_COLLABORATOR_REQUIRED');

        const targetUser = await queryOne(`
            SELECT id, username, nickname FROM users
            WHERE username = ? OR id = ?
        `, [usernameOrId, /^\d+$/.test(usernameOrId) ? Number(usernameOrId) : -1]);
        if (!targetUser) throw publicError('用户不存在。', 404, 'USER_NOT_FOUND');
        if (Number(targetUser.id) === Number(current.owner_user_id)) {
            throw publicError('文稿所有者无需作为协作者添加。', 400, 'PRESENTATION_COLLABORATOR_IS_OWNER');
        }

        const role = ['editor', 'viewer', 'commenter'].includes(String(body.role)) ? String(body.role) : 'editor';
        const tenant = await assertTenantContext(user);

        const row = await queryOne(`
            INSERT INTO presentation_collaborators (tenant_id, presentation_id, user_id, role, invited_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NOW(), NOW())
            ON CONFLICT (presentation_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
            RETURNING *
        `, [tenant.tenantId, current.id, targetUser.id, role, user.id]);

        publishPresentationRealtime(current.id, 'presentation.collaborators', { presentationId: current.client_id, changedBy: user.id }).catch(() => {});
        return {
            id: Number(row.id),
            userId: Number(targetUser.id),
            userName: targetUser.nickname || targetUser.username,
            username: targetUser.username,
            role: row.role,
            createdAt: row.created_at
        };
    }

    async function removePresentationCollaborator(user, clientId, collaboratorUserId) {
        const current = await getPresentationRow(user, clientId, { includeContent: false });
        if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
        const targetUserId = Number(collaboratorUserId);
        if (Number(current.owner_user_id) !== Number(user.id) && Number(user.id) !== targetUserId && !isAdmin(user)) {
            throw publicError('无权移除该协作者。', 403, 'PRESENTATION_COLLABORATOR_FORBIDDEN');
        }
        await execute('DELETE FROM presentation_collaborators WHERE presentation_id = ? AND user_id = ?', [current.id, targetUserId]);
        publishUserEvent(targetUserId, 'presentation.access_revoked', { presentationId: current.client_id, changedBy: user.id });
        publishPresentationRealtime(current.id, 'presentation.collaborators', { presentationId: current.client_id, changedBy: user.id }).catch(() => {});
        return { success: true, userId: targetUserId };
    }

    return {
        listPresentationComments,
        createPresentationComment,
        resolvePresentationComment,
        deletePresentationComment,
        listPresentationCollaborators,
        addPresentationCollaborator,
        removePresentationCollaborator
    };
}

module.exports = {
    createCollabService
};
