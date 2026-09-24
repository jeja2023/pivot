'use strict';

/** 演示文稿受控导出与交付渲染服务。 */
const crypto = require('crypto');
const { query, queryOne } = require('../../db/client');
const { assertTenantContext } = require('../agent-tenant-context');
const { getAgentArtifactForUser } = require('../agent-artifacts');
const { buildCasRef, incrementRefCount, putBuffer } = require('../agent-artifact-cas');
const { recordDeliveryEvent } = require('../agent-artifact-delivery');
const { canonicalJson } = require('../canonical-json');
const { computePresentationDigest, normalizePresentation } = require('./presentation-schema');
const { runPresentationValidation } = require('./presentation-validation');
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

function normalizeExportOptions(options = {}) {
    return {
        slideIndex: Number.isInteger(Number(options.slideIndex)) ? Number(options.slideIndex) : 0,
        aspectRatio: ['16:9', '4:3'].includes(String(options.aspectRatio || '')) ? String(options.aspectRatio) : '',
        includeNotes: options.includeNotes !== false,
        includePageNumbers: options.includePageNumbers !== false,
        showSourceRefs: options.showSourceRefs !== false,
        imageQuality: ['standard', 'high'].includes(String(options.imageQuality || '')) ? String(options.imageQuality) : 'standard',
        fontStrategy: ['embed', 'fallback'].includes(String(options.fontStrategy || '')) ? String(options.fontStrategy) : 'embed'
    };
}

function exportRendererVersion(format, options = {}) {
    const renderOptions = format === 'pptx'
        ? { includeNotes: options.includeNotes !== false }
        : format === 'png'
            ? { imageQuality: options.imageQuality || 'standard', slideIndex: Number(options.slideIndex || 0) }
            : {};
    const optionDigest = crypto.createHash('sha256').update(canonicalJson(renderOptions)).digest('hex').slice(0, 8);
    return `${PRESENTATION_RENDERER_VERSION}.${optionDigest}`;
}

function preparePresentationForExport(content, options = {}) {
    const source = normalizePresentation(content);
    const next = JSON.parse(JSON.stringify(source));
    const targetRatio = options.aspectRatio || source.aspectRatio;
    const targetSize = targetRatio === '4:3' ? { width: 960, height: 720 } : { width: 1280, height: 720 };
    if (targetRatio !== source.aspectRatio) {
        const scaleX = targetSize.width / source.width; const scaleY = targetSize.height / source.height;
        next.aspectRatio = targetRatio;
        next.slides.forEach(slide => slide.elements.forEach(element => {
            element.x = Math.max(0, Math.min(targetSize.width, Math.round(element.x * scaleX)));
            element.y = Math.max(0, Math.min(targetSize.height, Math.round(element.y * scaleY)));
            element.width = Math.max(1, Math.min(targetSize.width - element.x, Math.round(element.width * scaleX)));
            element.height = Math.max(1, Math.min(targetSize.height - element.y, Math.round(element.height * scaleY)));
        }));
    }
    if (!options.includePageNumbers) next.slides.forEach(slide => { slide.elements = slide.elements.filter(element => element.id !== 'pivotBrand_page'); });
    if (options.fontStrategy === 'fallback') {
        next.theme.fonts = { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' }; next.theme.fontAssets = { heading: '', body: '' };
        next.slides.forEach(slide => slide.elements.forEach(element => { if (element.type === 'text') element.style.fontFamily = element.style.fontSize >= 24 ? 'Microsoft YaHei' : 'Microsoft YaHei'; }));
    }
    if (options.showSourceRefs) {
        const sourceTitle = new Map(next.sources.map(source => [source.id, source.title]));
        next.slides.forEach(slide => {
            const refs = [...new Set([...slide.sourceRefs, ...slide.elements.flatMap(element => element.sourceRefs || [])])].filter(ref => sourceTitle.has(ref));
            if (!refs.length || slide.elements.some(element => element.id === 'pivotExport_sources')) return;
            const width = targetSize.width; const height = targetSize.height;
            slide.elements.push({ id: 'pivotExport_sources', type: 'text', x: 48, y: height - 30, width: width - 96, height: 18, rotation: 0, zIndex: 999, locked: true, visible: true, sourceRefs: refs, content: { text: '来源：' + refs.map(ref => sourceTitle.get(ref)).join('；') }, style: { fontFamily: 'Microsoft YaHei', fontSize: 9, fontWeight: 400, color: '#64748B', align: 'left', verticalAlign: 'middle', lineHeight: 1.1, italic: false, underline: false, bullet: false, padding: 0 } });
        });
    }
    return normalizePresentation(next);
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
        const normalizedOptions = normalizeExportOptions(options);
        const exportContent = preparePresentationForExport(current.content, normalizedOptions);
        const exportValidation = runPresentationValidation(exportContent);
        const irDigest = computePresentationDigest(exportContent);
        // PPTX 备注、PNG 页码与清晰度不会改变文稿 IR，需通过确定性渲染配置区分缓存。
        const rendererVersion = exportRendererVersion(normalizedFormat, normalizedOptions);
        const existing = await queryOne(`
            SELECT * FROM agent_artifact_renditions
            WHERE tenant_id = ? AND artifact_id = ? AND ir_digest = ? AND format = ? AND renderer_version = ? AND status = 'ready'
        `, [tenant.tenantId, artifact.id, irDigest, normalizedFormat, rendererVersion]);
        if (existing) return { rendition: existing, reused: true, validation: exportValidation };
        const contentBuffer = Buffer.from(serializeJson(exportContent), 'utf8');
        const irObject = await putBuffer({ buffer: contentBuffer, mimeType: 'application/json; charset=utf-8', tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'presentation_ir' });
        const assets = await resolvePresentationAssets(user, exportContent, { presentationId: current.id });
        const rendered = await renderPresentation(exportContent, normalizedFormat, { ...normalizedOptions, assetResolver: async ref => assets.get(ref) || null });
        const output = await putBuffer({ buffer: rendered.buffer, mimeType: rendered.mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: `presentation_${normalizedFormat}` });
        const runId = `standalone-artifact:${artifact.id}`;
        const toolCallId = `presentation:${artifact.id}:v${current.version}:${normalizedFormat}`;
        const rendition = await queryOne(`
            INSERT INTO agent_artifact_renditions
                (tenant_id, artifact_id, run_id, tool_call_id, created_by, ir_ref, ir_digest, format, renderer_version, content_digest, mime_type, byte_size, storage_ref, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NOW())
            ON CONFLICT (tenant_id, artifact_id, ir_digest, format, renderer_version) DO UPDATE SET status = 'ready', failure_reason = NULL
            RETURNING *
        `, [tenant.tenantId, artifact.id, runId, toolCallId, user.id, buildCasRef(irObject.objectId), irDigest, normalizedFormat, rendererVersion, output.contentDigest, output.mimeType, output.byteSize, buildCasRef(output.objectId)]);
        await incrementRefCount(irObject.objectId, 1);
        await incrementRefCount(output.objectId, 1);
        await queryOne(`
            INSERT INTO presentation_exports (presentation_id, version, rendition_id, format, renderer_version, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'ready', ?, NOW(), NOW())
            ON CONFLICT (presentation_id, version, format, renderer_version) DO UPDATE SET rendition_id = EXCLUDED.rendition_id, status = 'ready', updated_at = NOW()
            RETURNING *
        `, [currentRow.id, current.version, rendition.id, normalizedFormat, rendererVersion, user.id]);
        const validationDecision = exportValidation.status === 'blocked'
            ? `用户在 ${Number(exportValidation.summary?.blocking || 0)} 个阻断级版式问题仍存在时发起导出。`
            : exportValidation.status === 'warning'
                ? `用户在 ${Number(exportValidation.summary?.warnings || 0)} 个建议修复项仍存在时发起导出。`
                : '';
        await recordDeliveryEvent({
            tenantId: tenant.tenantId, renditionId: rendition.id, runId, toolCallId, actorType: 'user', actorId: String(user.id),
            eventType: 'presentation_render', pathHint: `${current.title}.${normalizedFormat}`, contentDigest: output.contentDigest,
            decisionReason: validationDecision
        });
        return { rendition, reused: false, validation: exportValidation, durationMs: rendered.durationMs };
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
    createExportService,
    exportRendererVersion,
    normalizeExportOptions,
    preparePresentationForExport
};
