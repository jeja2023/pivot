'use strict';

/** 演示文稿远程投屏与控制会话业务服务。 */
const crypto = require('crypto');
const { queryOne } = require('../../db/client');
const { assertTenantContext } = require('../agent-tenant-context');
const { buildCasRef, parseCasRef, readBuffer } = require('../agent-artifact-cas');
const { isAdmin } = require('../../permissions');
const { collectPresentationAssetRefs, normalizePresentation } = require('./presentation-schema');
const { publishPresentationRealtime } = require('./presentation-realtime');

function publicError(message, status = 400, code = 'PRESENTATION_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function parseJson(value, fallback = null) {
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function remoteTokenHash(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function remotePublicContent(content) {
    const checked = normalizePresentation(content);
    const slides = checked.slides.map(slide => ({
        id: slide.id, index: slide.index, type: slide.type, layoutId: slide.layoutId,
        background: slide.background, transition: slide.transition,
        elements: slide.elements.map(element => { const copy = { ...element }; delete copy.sourceRefs; return copy; })
    }));
    return { title: checked.title, aspectRatio: checked.aspectRatio, width: checked.width, height: checked.height, theme: checked.theme, slides };
}

function createRemoteService(deps) {
    const { getPresentationRow, assertPresentationOwnerOrAdmin } = deps;

    async function createPresentationRemoteSession(user, clientId, options = {}) {
        const current = await getPresentationRow(user, clientId, { includeContent: true });
        assertPresentationOwnerOrAdmin(user, current);
        const tenant = await assertTenantContext(user);
        const token = crypto.randomBytes(32).toString('base64url');
        const id = 'remote_' + crypto.randomUUID().replace(/-/g, '');
        const ttlMinutes = Math.max(5, Math.min(Number.parseInt(options.ttlMinutes || options.ttl_minutes, 10) || 60, 24 * 60));
        const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
        const row = await queryOne(`
            INSERT INTO presentation_remote_sessions (id, tenant_id, presentation_id, owner_user_id, token_hash, current_slide_index, status, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, 'active', ?, NOW(), NOW()) RETURNING *
        `, [id, tenant.tenantId, current.id, user.id, remoteTokenHash(token), expiresAt]);
        return { id: row.id, token, expiresAt: row.expires_at, currentSlideIndex: Number(row.current_slide_index || 0), presentationId: current.client_id };
    }

    async function setPresentationRemoteSlide(user, sessionId, slideIndex) {
        const tenant = await assertTenantContext(user);
        const index = Math.max(0, Math.min(Number.parseInt(slideIndex, 10) || 0, 99));
        const row = await queryOne(`
            UPDATE presentation_remote_sessions rs SET current_slide_index = ?, updated_at = NOW()
            FROM presentation_documents d
            WHERE rs.presentation_id = d.id AND rs.id = ? AND rs.tenant_id = ? AND rs.status = 'active' AND rs.expires_at > NOW()
              AND (rs.owner_user_id = ? OR ? = true) RETURNING rs.*, d.client_id
        `, [index, sessionId, tenant.tenantId, user.id, isAdmin(user)]);
        if (!row) throw publicError('远程演示会话不存在、已过期或无权控制。', 404, 'PRESENTATION_REMOTE_SESSION_NOT_FOUND');
        publishPresentationRealtime(row.presentation_id, 'presentation.remote', { presentationId: row.client_id, sessionId: row.id, currentSlideIndex: Number(row.current_slide_index || 0), changedBy: user.id }).catch(() => {});
        return { id: row.id, currentSlideIndex: Number(row.current_slide_index || 0) };
    }

    async function closePresentationRemoteSession(user, sessionId) {
        const tenant = await assertTenantContext(user);
        const row = await queryOne(`
            UPDATE presentation_remote_sessions SET status = 'closed', closed_at = NOW(), updated_at = NOW()
            WHERE id = ? AND tenant_id = ? AND status = 'active' AND (owner_user_id = ? OR ? = true) RETURNING *
        `, [sessionId, tenant.tenantId, user.id, isAdmin(user)]);
        if (!row) throw publicError('远程演示会话不存在或无权关闭。', 404, 'PRESENTATION_REMOTE_SESSION_NOT_FOUND');
        return { id: row.id, status: 'closed' };
    }

    async function getPresentationRemoteState(token) {
        const hash = remoteTokenHash(token);
        const row = await queryOne(`
            SELECT rs.*, d.client_id, d.title, d.current_version, v.content_json
            FROM presentation_remote_sessions rs
            JOIN presentation_documents d ON d.id = rs.presentation_id AND d.deleted_at IS NULL
            JOIN presentation_versions v ON v.presentation_id = d.id AND v.version = d.current_version
            WHERE rs.token_hash = ? AND rs.status = 'active' AND rs.expires_at > NOW()
            LIMIT 1
        `, [hash]);
        if (!row) return null;
        const content = parseJson(row.content_json, null);
        if (!content) return null;
        return {
            presentationId: row.client_id,
            title: row.title,
            version: Number(row.current_version || 0),
            currentSlideIndex: Math.max(0, Math.min(Number(row.current_slide_index || 0), Math.max(0, content.slides.length - 1))),
            expiresAt: row.expires_at,
            content: remotePublicContent(content)
        };
    }

    async function getPresentationRemoteAsset(token, ref) {
        const hash = remoteTokenHash(token);
        const objectId = parseCasRef(ref);
        if (!objectId) return null;
        const row = await queryOne(`
            SELECT rs.tenant_id, v.content_json, a.object_id, a.mime_type, a.filename
            FROM presentation_remote_sessions rs
            JOIN presentation_documents d ON d.id = rs.presentation_id AND d.deleted_at IS NULL
            JOIN presentation_versions v ON v.presentation_id = d.id AND v.version = d.current_version
            JOIN presentation_assets a ON a.object_id = ? AND a.tenant_id = rs.tenant_id AND a.deleted_at IS NULL
            WHERE rs.token_hash = ? AND rs.status = 'active' AND rs.expires_at > NOW() LIMIT 1
        `, [objectId, hash]);
        if (!row || !collectPresentationAssetRefs(parseJson(row.content_json, {})).includes(buildCasRef(objectId))) return null;
        const loaded = await readBuffer({ objectId: row.object_id, tenantId: row.tenant_id, tenantScoped: true });
        return { buffer: loaded.buffer, mimeType: row.mime_type, filename: row.filename };
    }

    return {
        createPresentationRemoteSession,
        setPresentationRemoteSlide,
        closePresentationRemoteSession,
        getPresentationRemoteState,
        getPresentationRemoteAsset
    };
}

module.exports = {
    remoteTokenHash,
    remotePublicContent,
    createRemoteService
};
