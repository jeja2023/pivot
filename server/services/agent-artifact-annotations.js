'use strict';

const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { getAgentArtifactForUser } = require('./agent-artifacts');

function annotationError(message, code = 'AGENT_ARTIFACT_ANNOTATION_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeTarget(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const target = {
        location: String(source.location || source.path || source.selector || '').trim().slice(0, 500),
        page: Number.isSafeInteger(Number(source.page)) && Number(source.page) > 0 ? Number(source.page) : null,
        sheet: String(source.sheet || '').trim().slice(0, 120),
        slide: Number.isSafeInteger(Number(source.slide)) && Number(source.slide) > 0 ? Number(source.slide) : null,
        selector: String(source.selector || '').trim().slice(0, 500)
    };
    if (!target.location && !target.page && !target.sheet && !target.slide && !target.selector) {
        throw annotationError('批注需要指定页面、幻灯片、工作表、段落或其他修改位置。');
    }
    return target;
}

function serializeAnnotation(row = {}) {
    return {
        id: Number(row.id),
        artifactId: Number(row.artifact_id),
        artifactVersionId: row.artifact_version_id ? Number(row.artifact_version_id) : null,
        target: parseJson(row.target, {}),
        note: row.note || '',
        status: row.status || 'open',
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        resolvedAt: row.resolved_at || null
    };
}

async function listAgentArtifactAnnotations(artifactId, user, options = {}) {
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) return null;
    const status = ['open', 'resolved', 'all'].includes(String(options.status || '')) ? String(options.status) : 'all';
    const rows = await query(`
        SELECT * FROM agent_artifact_annotations
        WHERE artifact_id = ?${status === 'all' ? '' : ' AND status = ?'}
        ORDER BY status = 'open' DESC, created_at DESC, id DESC
        LIMIT ?
    `, status === 'all'
        ? [artifact.id, Math.max(1, Math.min(Number(options.limit) || 100, 500))]
        : [artifact.id, status, Math.max(1, Math.min(Number(options.limit) || 100, 500))]);
    return { artifact, annotations: rows.map(serializeAnnotation) };
}

async function createAgentArtifactAnnotation(artifactId, user, input = {}) {
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) return null;
    const note = String(input.note || input.comment || '').trim().slice(0, 4000);
    if (!note) throw annotationError('请填写需要修改或核对的内容。');
    const target = normalizeTarget(input.target || input);
    const requestedVersion = Number.parseInt(input.artifactVersionId || input.artifact_version_id, 10);
    const versionId = Number.isSafeInteger(requestedVersion) && requestedVersion > 0
        ? requestedVersion : artifact.current_version_id || null;
    if (versionId) {
        const version = await queryOne('SELECT id FROM agent_artifact_versions WHERE id = ? AND artifact_id = ?', [versionId, artifact.id]);
        if (!version) throw annotationError('批注指定的产物版本不存在。', 'AGENT_ARTIFACT_VERSION_NOT_FOUND', 404);
    }
    const now = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO agent_artifact_annotations (
            artifact_id, artifact_version_id, user_id, target, note, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
        RETURNING *
    `, [artifact.id, versionId, user.id, JSON.stringify(target), note, now, now]);
    return serializeAnnotation(row);
}

async function updateAgentArtifactAnnotation(artifactId, annotationId, user, input = {}) {
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) return null;
    const status = ['open', 'resolved'].includes(String(input.status || '')) ? String(input.status) : null;
    if (!status) throw annotationError('批注状态只能是 open 或 resolved。');
    const row = await queryOne(`
        UPDATE agent_artifact_annotations
        SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN ?::timestamptz ELSE NULL END, updated_at = ?::timestamptz
        WHERE id = ? AND artifact_id = ? AND user_id = ?
        RETURNING *
    `, [status, status, getBeijingTimestamp(), getBeijingTimestamp(), Number(annotationId), artifact.id, user.id]);
    return row ? serializeAnnotation(row) : null;
}

module.exports = {
    createAgentArtifactAnnotation,
    listAgentArtifactAnnotations,
    updateAgentArtifactAnnotation
};
