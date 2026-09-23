'use strict';

/** 演示文稿受控导出与交付渲染服务。 */
const { query, queryOne } = require('../../db/client');
const { assertTenantContext } = require('../agent-tenant-context');
const { getAgentArtifactForUser } = require('../agent-artifacts');
const { buildCasRef, incrementRefCount, putBuffer } = require('../agent-artifact-cas');
const { recordDeliveryEvent } = require('../agent-artifact-delivery');
const { computePresentationDigest } = require('./presentation-schema');
const { PRESENTATION_RENDERER_VERSION, renderPresentation } = require('./presentation-renderer');

const EXPORT_FORMATS = new Set(['pptx', 'pdf', 'png']);

function publicError(message, status = 400, code = 'PRESENTATION_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function serializeJson(value) {
    return JSON.stringify(value);
}

function createExportService(deps) {
    const { getPresentationRow, assertPresentationOwnerOrAdmin, toPublicPresentation, resolvePresentationAssets } = deps;

    async function createPresentationExport(user, clientId, format, options = {}) {
        const normalizedFormat = String(format || '').toLowerCase();
        if (!EXPORT_FORMATS.has(normalizedFormat)) throw publicError('仅支持导出 PPTX、PDF 或 PNG。', 400, 'PRESENTATION_EXPORT_FORMAT_INVALID');
        const currentRow = await getPresentationRow(user, clientId, { includeContent: true });
        if (!currentRow) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
        assertPresentationOwnerOrAdmin(user, currentRow);
        const current = toPublicPresentation(currentRow, { includeContent: true });
        const tenant = await assertTenantContext(user);
        const artifact = await getAgentArtifactForUser(current.artifactId, user);
        if (!artifact) throw publicError('演示文稿产物不存在或无权导出。', 404, 'PRESENTATION_ARTIFACT_NOT_FOUND');
        const irDigest = computePresentationDigest(current.content);
        const existing = await queryOne(`
            SELECT * FROM agent_artifact_renditions
            WHERE tenant_id = ? AND artifact_id = ? AND ir_digest = ? AND format = ? AND renderer_version = ? AND status = 'ready'
        `, [tenant.tenantId, artifact.id, irDigest, normalizedFormat, PRESENTATION_RENDERER_VERSION]);
        if (existing) return { rendition: existing, reused: true, validation: current.validation };
        const contentBuffer = Buffer.from(serializeJson(current.content), 'utf8');
        const irObject = await putBuffer({ buffer: contentBuffer, mimeType: 'application/json; charset=utf-8', tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'presentation_ir' });
        const assets = await resolvePresentationAssets(user, current.content, { presentationId: current.id });
        const rendered = await renderPresentation(current.content, normalizedFormat, { slideIndex: options.slideIndex, assetResolver: async ref => assets.get(ref) || null });
        const output = await putBuffer({ buffer: rendered.buffer, mimeType: rendered.mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: `presentation_${normalizedFormat}` });
        const runId = `standalone-artifact:${artifact.id}`;
        const toolCallId = `presentation:${artifact.id}:v${current.version}:${normalizedFormat}`;
        const rendition = await queryOne(`
            INSERT INTO agent_artifact_renditions
                (tenant_id, artifact_id, run_id, tool_call_id, created_by, ir_ref, ir_digest, format, renderer_version, content_digest, mime_type, byte_size, storage_ref, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NOW())
            ON CONFLICT (tenant_id, artifact_id, ir_digest, format, renderer_version) DO UPDATE SET status = 'ready', failure_reason = NULL
            RETURNING *
        `, [tenant.tenantId, artifact.id, runId, toolCallId, user.id, buildCasRef(irObject.objectId), irDigest, normalizedFormat, PRESENTATION_RENDERER_VERSION, output.contentDigest, output.mimeType, output.byteSize, buildCasRef(output.objectId)]);
        await incrementRefCount(irObject.objectId, 1);
        await incrementRefCount(output.objectId, 1);
        await queryOne(`
            INSERT INTO presentation_exports (presentation_id, version, rendition_id, format, renderer_version, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'ready', ?, NOW(), NOW())
            ON CONFLICT (presentation_id, version, format, renderer_version) DO UPDATE SET rendition_id = EXCLUDED.rendition_id, status = 'ready', updated_at = NOW()
            RETURNING *
        `, [currentRow.id, current.version, rendition.id, normalizedFormat, PRESENTATION_RENDERER_VERSION, user.id]);
        const validationDecision = current.validation?.status === 'blocked'
            ? `用户在 ${Number(current.validation?.summary?.blocking || 0)} 个阻断级版式问题仍存在时发起导出。`
            : current.validation?.status === 'warning'
                ? `用户在 ${Number(current.validation?.summary?.warnings || 0)} 个建议修复项仍存在时发起导出。`
                : '';
        await recordDeliveryEvent({
            tenantId: tenant.tenantId, renditionId: rendition.id, runId, toolCallId, actorType: 'user', actorId: String(user.id),
            eventType: 'presentation_render', pathHint: `${current.title}.${normalizedFormat}`, contentDigest: output.contentDigest,
            decisionReason: validationDecision
        });
        return { rendition, reused: false, validation: current.validation, durationMs: rendered.durationMs };
    }

    async function listPresentationExports(user, clientId) {
        const current = await getPresentationRow(user, clientId, { includeContent: false });
        if (!current) return null;
        const rows = await query(`
            SELECT e.*, r.content_digest, r.mime_type, r.byte_size
            FROM presentation_exports e LEFT JOIN agent_artifact_renditions r ON r.id = e.rendition_id
            WHERE e.presentation_id = ? ORDER BY e.updated_at DESC
        `, [current.id]);
        return rows.map(row => ({ id: Number(row.id), renditionId: Number(row.rendition_id), version: Number(row.version), format: row.format, status: row.status, rendererVersion: row.renderer_version, contentDigest: row.content_digest || '', mimeType: row.mime_type || '', byteSize: Number(row.byte_size || 0), createdAt: row.created_at, updatedAt: row.updated_at }));
    }

    return {
        createPresentationExport,
        listPresentationExports
    };
}

module.exports = {
    createExportService
};
