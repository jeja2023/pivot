'use strict';

/** 演示文稿、模板、素材、版本和受控导出的业务服务。 */
const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const { query, queryOne, execute, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { assertTenantContext } = require('../agent-tenant-context');
const { createStandaloneArtifact, getAgentArtifactForUser } = require('../agent-artifacts');
const { buildCasRef, incrementRefCount, parseCasRef, putBuffer, readBuffer, statObject } = require('../agent-artifact-cas');
const { isAdmin } = require('../../permissions');
const { getBuiltInTemplate, listBuiltInTemplates } = require('./presentation-templates');
const {
    collectPresentationAssetRefs,
    computePresentationDigest,
    defaultPresentation,
    normalizePresentation,
} = require('./presentation-schema');
const { runPresentationValidation } = require('./presentation-validation');
const { publishPresentationRealtime } = require('./presentation-realtime');
const { createCollabService } = require('./presentation-collab-service');
const { createRemoteService } = require('./presentation-remote-service');
const { createExportService } = require('./presentation-export-service');
const { createPresentationTemplateService } = require('./presentation-template-service');
const { createPresentationAssetService } = require('./presentation-asset-service');

const MAX_TITLE_LENGTH = 160;

function publicError(message, status = 400, code = 'PRESENTATION_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function normalizeClientId(value) {
    const id = String(value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) throw publicError('演示文稿标识无效。', 400, 'PRESENTATION_ID_INVALID');
    return id;
}

function newClientId() {
    return `ppt_${crypto.randomUUID().replace(/-/g, '')}`;
}

function normalizeTitle(value) {
    const title = String(value || '').trim().replace(/\s+/g, ' ');
    return (title || '未命名演示文稿').slice(0, MAX_TITLE_LENGTH);
}

function normalizeTags(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/[，,]/);
    return [...new Set(raw.map(item => String(item || '').trim().replace(/\s+/g, ' ').slice(0, 32)).filter(Boolean))].slice(0, 12);
}

function normalizeDepartmentName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

function normalizeAssetScope(value) {
    return ['private', 'organization', 'department'].includes(String(value || '')) ? String(value) : 'private';
}

function assetAccessClause(user) {
    return { sql: "(owner_user_id = ? OR scope = 'organization' OR (scope = 'department' AND department_name = ?))", params: [user.id, normalizeDepartmentName(user.unit)] };
}


function parseJson(value, fallback = null) {
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function serializeJson(value) {
    return JSON.stringify(value);
}

function toPublicPresentation(row, { includeContent = false } = {}) {
    if (!row) return null;
    const output = {
        id: String(row.client_id),
        title: String(row.title || '未命名演示文稿'),
        status: String(row.status || 'draft'),
        aspectRatio: String(row.aspect_ratio || '16:9'),
        template: {
            id: String(row.template_id || 'business-blue'),
            version: Number(row.template_version || 1),
            snapshotDigest: String(row.template_digest || '')
        },
        artifactId: row.artifact_id ? Number(row.artifact_id) : null,
        version: Number(row.current_version || 1),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at || null,
        coverAssetRef: String(row.cover_asset_ref || ''),
        tags: parseJson(row.tags_json, []),
        ownerName: String(row.owner_nickname || row.owner_username || ''),
        favorite: row.favorite === true || row.favorite === 'true' || Number(row.favorite || 0) === 1,
        isOwner: row.is_owner === undefined ? true : (row.is_owner === true || row.is_owner === 'true' || Number(row.is_owner || 0) === 1),
        collaboratorRole: row.collaborator_role || null
    };
    if (includeContent) {
        output.content = parseJson(row.content_json, null);
        output.validation = parseJson(row.validation_json, { status: 'unknown', issues: [] });
    }
    return output;
}

const templateService = createPresentationTemplateService({
    crypto,
    path,
    Worker,
    query,
    queryOne,
    execute,
    getBeijingTimestamp,
    assertTenantContext,
    buildCasRef,
    incrementRefCount,
    parseCasRef,
    putBuffer,
    readBuffer,
    isAdmin,
    getBuiltInTemplate,
    listBuiltInTemplates,
    collectPresentationAssetRefs,
    defaultPresentation,
    normalizePresentation,
    publicError,
    normalizeClientId,
    normalizeTitle,
    normalizeTags,
    normalizeDepartmentName,
    normalizeAssetScope,
    assetAccessClause,
    parseJson,
    serializeJson,
    findPresentationAssetForUser: (...args) => assetService.findPresentationAssetForUser(...args),
    uploadPresentationAsset: (...args) => assetService.uploadPresentationAsset(...args)
});
const {
    applyTemplateBrandControls,
    applyTemplateLayoutLayers,
    createPresentationTemplate,
    updatePresentationTemplate,
    submitPresentationTemplateForReview,
    reviewPresentationTemplate,
    exportPresentationTemplate,
    getPresentationTemplateStatistics,
    getPresentationTemplateSource,
    reparsePresentationTemplateSource,
    importPresentationTemplateFile,
    createPresentationTemplateImportJob,
    getPresentationTemplateImportJob,
    runPresentationTemplateImportJob,
    cancelPresentationTemplateImportJob,
    previewPresentationTemplateFile,
    parsePptxTemplateInWorker,
    normalizeTemplatePackage,
    normalizeTemplateDefinition,
    resolveTemplateForUser,
    resolveTemplateVersionForUser,
    listPresentationTemplates
} = templateService;
async function listPresentations(user, options = {}) {
    const tenant = await assertTenantContext(user);
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 100));
    const search = String(options.search || '').trim().slice(0, 160);
    const templateId = String(options.templateId || options.template_id || '').trim().slice(0, 96);
    const status = ['draft', 'needs_attention', 'ready', 'archived'].includes(String(options.status)) ? String(options.status) : '';
    const tag = String(options.tag || '').trim().slice(0, 32);
    const createdBy = String(options.createdBy || options.created_by || '').trim().slice(0, 120);
    const updatedFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(options.updatedFrom || options.updated_from || '')) ? String(options.updatedFrom || options.updated_from) : '';
    const updatedTo = /^\d{4}-\d{2}-\d{2}$/.test(String(options.updatedTo || options.updated_to || '')) ? String(options.updatedTo || options.updated_to) : '';
    const favoriteOnly = options.favorite === true || String(options.favorite || '') === 'true';
    const conditions = ['d.tenant_id = ?', 'd.deleted_at IS NULL', '(d.owner_user_id = ? OR pc.user_id IS NOT NULL)'];
    const params = [tenant.tenantId, user.id];
    if (search) { const escaped = search.replace(/[\\%_]/g, char => '\\' + char); const like = '%' + escaped + '%'; conditions.push('(d.title ILIKE ? OR pv.content_json ILIKE ?)'); params.push(like, like); }
    if (templateId) { conditions.push('d.template_id = ?'); params.push(templateId); }
    if (status) { conditions.push('d.status = ?'); params.push(status); }
    if (tag) { const escaped = tag.replace(/[\\%_]/g, char => '\\' + char); conditions.push("d.tags_json LIKE ? ESCAPE '\\'"); params.push('%' + escaped + '%'); }
    if (createdBy) { const escaped = createdBy.replace(/[\\%_]/g, char => '\\' + char); conditions.push("(owner.username ILIKE ? ESCAPE '\\' OR COALESCE(owner.nickname, '') ILIKE ? ESCAPE '\\')"); params.push('%' + escaped + '%', '%' + escaped + '%'); }
    if (updatedFrom) { conditions.push('d.updated_at >= ?::date'); params.push(updatedFrom); }
    if (updatedTo) { conditions.push("d.updated_at < (?::date + INTERVAL '1 day')"); params.push(updatedTo); }
    if (favoriteOnly) conditions.push('pf.presentation_id IS NOT NULL');
    const rows = await query(`
        SELECT d.*, owner.username AS owner_username, owner.nickname AS owner_nickname, pc.role AS collaborator_role, (d.owner_user_id = ?) AS is_owner,
               CASE WHEN pf.presentation_id IS NULL THEN false ELSE true END AS favorite
        FROM presentation_documents d
        LEFT JOIN users owner ON owner.id = d.owner_user_id
        LEFT JOIN presentation_versions pv ON pv.presentation_id = d.id AND pv.version = d.current_version
        LEFT JOIN presentation_collaborators pc ON pc.presentation_id = d.id AND pc.user_id = ?
        LEFT JOIN presentation_document_favorites pf ON pf.presentation_id = d.id AND pf.tenant_id = d.tenant_id AND pf.user_id = ?
        WHERE ${conditions.join(' AND ')}
        ORDER BY CASE WHEN pf.presentation_id IS NULL THEN 1 ELSE 0 END, d.updated_at DESC, d.id DESC
        LIMIT ?
    `, [user.id, user.id, user.id, ...params, limit]);
    return rows.map(row => toPublicPresentation(row));
}

async function setPresentationFavorite(user, clientId, favorite = true) {
    const current = await getPresentationRow(user, clientId, { includeContent: false });
    if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    const tenant = await assertTenantContext(user);
    if (favorite) {
        await execute(`
            INSERT INTO presentation_document_favorites (tenant_id, presentation_id, user_id, created_at)
            VALUES (?, ?, ?, NOW())
            ON CONFLICT (tenant_id, presentation_id, user_id) DO NOTHING
        `, [tenant.tenantId, current.id, user.id]);
    } else {
        await execute('DELETE FROM presentation_document_favorites WHERE tenant_id = ? AND presentation_id = ? AND user_id = ?', [tenant.tenantId, current.id, user.id]);
    }
    return { presentationId: current.client_id, favorite: Boolean(favorite) };
}

async function getPresentationRow(user, clientId, { includeContent = false } = {}) {
    const tenant = await assertTenantContext(user);
    const idStr = String(clientId || '').trim();
    const isArtifactId = /^\d+$/.test(idStr);
    const row = await queryOne(`
        SELECT d.*, v.content_json, v.validation_json,
               (d.owner_user_id = ?) AS is_owner,
               COALESCE((SELECT pc.role FROM presentation_collaborators pc WHERE pc.presentation_id = d.id AND pc.user_id = ? LIMIT 1), '') AS collaborator_role
        FROM presentation_documents d
        LEFT JOIN presentation_versions v ON v.presentation_id = d.id AND v.version = d.current_version
        WHERE d.tenant_id = ?
          AND (d.client_id = ? OR (d.artifact_id = ? AND ? = true))
          AND (d.owner_user_id = ? OR EXISTS (
              SELECT 1 FROM presentation_collaborators pc WHERE pc.presentation_id = d.id AND pc.user_id = ?
          ))
          AND d.deleted_at IS NULL
    `, [user.id, user.id, tenant.tenantId, idStr, isArtifactId ? Number(idStr) : -1, isArtifactId, user.id, user.id]);
    return includeContent ? row : row && { ...row, content_json: undefined, validation_json: undefined };
}

function assertPresentationEditor(user, current) {
    if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    if (isAdmin(user) || Number(current.owner_user_id) === Number(user.id) || String(current.collaborator_role) === 'editor') return;
    throw publicError('当前协作角色仅允许查看或评论，不能修改演示文稿。', 403, 'PRESENTATION_EDIT_FORBIDDEN');
}

function assertPresentationOwnerOrAdmin(user, current) {
    if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    if (isAdmin(user) || Number(current.owner_user_id) === Number(user.id)) return;
    throw publicError('只有文稿所有者或管理员可以导出共享演示文稿。', 403, 'PRESENTATION_EXPORT_FORBIDDEN');
}

function assertPresentationCommenter(user, current) {
    if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    if (isAdmin(user) || Number(current.owner_user_id) === Number(user.id) || ['editor', 'commenter'].includes(String(current.collaborator_role))) return;
    throw publicError('当前协作角色仅允许查看，不能发表评论。', 403, 'PRESENTATION_COMMENT_FORBIDDEN');
}

async function getPresentation(user, clientId) {
    const row = await getPresentationRow(user, clientId, { includeContent: true });
    if (!row) return null;
    const presentation = toPublicPresentation(row, { includeContent: true });
    const template = await resolveTemplateVersionForUser(user, presentation.template.id, presentation.template.version, { historical: true });
    if (template?.definition) {
        presentation.templateDefinition = template.definition;
        presentation.templateSourceFormat = template.sourceFormat || template.definition?.importMetadata?.sourceFormat || 'pivot';
        presentation.templateImportReport = template.importReport || [];
    }
    return presentation;
}

function plainTextFromArtifact(content) {
    return String(content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60000);
}

function presentationFromArtifactText({ title, template, text, artifactId }) {
    const chunks = text.split(/(?=s*(?:#{1,3}\s+|[一二三四五六七八九十]+[、.]))/).map(item => item.trim()).filter(Boolean);
    const pages = (chunks.length ? chunks : [text]).slice(0, 20).map((chunk, index) => ({
        id: 'slide_artifact_' + (index + 1), index, type: index === 0 ? 'cover' : 'content', layoutId: index === 0 ? 'cover' : 'title-content', sectionId: '',
        background: { fill: template.definition.theme.colors.background || '#FFFFFF', imageAssetRef: '', opacity: 1 },
        elements: index === 0 ? [
            { id: 'title', type: 'text', x: 100, y: 190, width: 1080, height: 110, rotation: 0, zIndex: 10, locked: false, visible: true, sourceRefs: ['artifact_source'], content: { text: title }, style: { fontFamily: template.definition.theme.fonts.heading, fontSize: 40, fontWeight: 700, color: template.definition.theme.colors.text, align: 'center', verticalAlign: 'middle', lineHeight: 1.2, italic: false, underline: false, bullet: false, padding: 0 } },
            { id: 'body', type: 'text', x: 160, y: 350, width: 960, height: 180, rotation: 0, zIndex: 9, locked: false, visible: true, sourceRefs: ['artifact_source'], content: { text: chunk.slice(0, 500) }, style: { fontFamily: template.definition.theme.fonts.body, fontSize: 18, fontWeight: 400, color: template.definition.theme.colors.text, align: 'center', verticalAlign: 'middle', lineHeight: 1.35, italic: false, underline: false, bullet: false, padding: 0 } }
        ] : [
            { id: 'title', type: 'text', x: 80, y: 58, width: 1120, height: 72, rotation: 0, zIndex: 10, locked: false, visible: true, sourceRefs: ['artifact_source'], content: { text: chunk.slice(0, 40) }, style: { fontFamily: template.definition.theme.fonts.heading, fontSize: 30, fontWeight: 700, color: template.definition.theme.colors.text, align: 'left', verticalAlign: 'middle', lineHeight: 1.2, italic: false, underline: false, bullet: false, padding: 0 } },
            { id: 'body', type: 'text', x: 100, y: 165, width: 1040, height: 430, rotation: 0, zIndex: 9, locked: false, visible: true, sourceRefs: ['artifact_source'], content: { text: chunk.slice(0, 2400) }, style: { fontFamily: template.definition.theme.fonts.body, fontSize: 20, fontWeight: 400, color: template.definition.theme.colors.text, align: 'left', verticalAlign: 'top', lineHeight: 1.35, italic: false, underline: false, bullet: false, padding: 0 } }
        ], speakerNotes: '', sourceRefs: ['artifact_source']
    }));
    return { title, aspectRatio: template.aspectRatio, template: { id: template.id, version: template.version, snapshotDigest: template.snapshotDigest }, theme: template.definition.theme, slides: pages, sources: [{ id: 'artifact_source', title: '智能体产物 ' + artifactId, type: 'agent_artifact', locator: String(artifactId), digest: '' }], metadata: { aiGenerated: false, language: 'zh-CN' } };
}

async function createPresentationFromArtifact(user, artifactId, body = {}) {
    const artifact = await getAgentArtifactForUser(Number.parseInt(artifactId, 10), user);
    if (!artifact) throw publicError('智能体产物不存在或无权访问。', 404, 'PRESENTATION_ARTIFACT_NOT_FOUND');
    const requestedVersion = body.templateVersion || body.template_version;
    const template = requestedVersion ? await resolveTemplateVersionForUser(user, body.templateId || 'business-blue', requestedVersion) : await resolveTemplateForUser(user, body.templateId || 'business-blue');
    if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    const title = normalizeTitle(body.title || artifact.title || '智能体产物演示文稿'); const text = plainTextFromArtifact(artifact.content);
    if (!text) throw publicError('智能体产物没有可转换的文本内容。', 422, 'PRESENTATION_ARTIFACT_EMPTY');
    const content = presentationFromArtifactText({ title, template, text, artifactId: artifact.id });
    return await createPresentation(user, { title, templateId: template.id, templateVersion: template.version, content, tags: normalizeTags(body.tags || ['Agent产物']) });
}

async function createPresentation(user, body = {}) {
    const tenant = await assertTenantContext(user);
    const clientId = body.id ? normalizeClientId(body.id) : newClientId();
    const title = normalizeTitle(body.title);
    const requestedTemplateId = body.templateId || body.template?.id || 'business-blue';
    const requestedTemplateVersion = body.templateVersion || body.template_version || body.template?.version;
    const template = requestedTemplateVersion ? await resolveTemplateVersionForUser(user, requestedTemplateId, requestedTemplateVersion) : await resolveTemplateForUser(user, requestedTemplateId);
    if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    let content = body.content ? normalizePresentation({ ...body.content, presentationId: clientId, title, template: { id: template.id, version: template.version, snapshotDigest: template.snapshotDigest }, theme: body.content.theme || template.definition.theme }) : defaultPresentation({ presentationId: clientId, title, template, aspectRatio: body.aspectRatio || template.aspectRatio });
    content = applyTemplateLayoutLayers(content, template, { reflow: true });
    content = applyTemplateBrandControls(content, template);
    await assertPresentationAssetOwnership(user, content);
    const validation = runPresentationValidation(content);
    const artifact = await createStandaloneArtifact(user, {
        type: 'presentation',
        title,
        content: serializeJson(content),
        preserveWhitespace: true,
        note: '创建演示文稿源稿'
    });
    const row = await queryOne(`
        INSERT INTO presentation_documents
            (tenant_id, owner_user_id, client_id, artifact_id, title, status, aspect_ratio, template_id, template_version, template_digest, tags_json, cover_asset_ref, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
        RETURNING *
    `, [tenant.tenantId, user.id, clientId, artifact.id, title, content.aspectRatio, template.id, template.version, template.snapshotDigest, serializeJson(normalizeTags(body.tags)), String(content.metadata?.coverAssetRef || '')]);
    await execute(`
        INSERT INTO presentation_versions (presentation_id, version, artifact_version_id, content_json, content_digest, validation_json, note, created_by, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, NOW())
    `, [row.id, artifact.current_version_id || null, serializeJson(content), computePresentationDigest(content), serializeJson(validation), '创建演示文稿', user.id]);
    return await getPresentation(user, clientId);
}

async function savePresentationContent(user, clientId, body = {}) {
    const current = await getPresentationRow(user, clientId, { includeContent: true });
    if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    assertPresentationEditor(user, current);
    const baseVersion = Number.parseInt(body.baseVersion, 10);
    if (!Number.isSafeInteger(baseVersion) || baseVersion !== Number(current.current_version)) {
        throw publicError('文稿已被新版本更新，请刷新后合并修改。', 409, 'PRESENTATION_VERSION_CONFLICT');
    }
    const title = body.title === undefined ? current.title : normalizeTitle(body.title);
    let templateId = current.template_id;
    let templateVersion = current.template_version;
    let templateDigest = current.template_digest;
    if (body.templateId !== undefined && (String(body.templateId).trim() !== String(current.template_id) || Number(body.templateVersion || body.template_version || body.content?.template?.version || current.template_version) !== Number(current.template_version))) {
        const requestedVersion = body.templateVersion || body.template_version || body.content?.template?.version;
        const template = requestedVersion ? await resolveTemplateVersionForUser(user, body.templateId, requestedVersion) : await resolveTemplateForUser(user, body.templateId);
        if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
        templateId = template.id;
        templateVersion = template.version;
        templateDigest = template.snapshotDigest;
    }
    if (body.templateId === undefined && body.templateVersion !== undefined && Number(body.templateVersion) !== Number(current.template_version)) {
        const template = await resolveTemplateVersionForUser(user, templateId, body.templateVersion);
        if (!template) throw publicError('所选模板版本不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_VERSION_NOT_FOUND');
        templateVersion = template.version;
        templateDigest = template.snapshotDigest;
    }
    const activeTemplate = await resolveTemplateVersionForUser(user, templateId, templateVersion, { historical: true }) || await resolveTemplateForUser(user, templateId);
    if (!activeTemplate) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    let content = normalizePresentation({ ...(body.content || {}), presentationId: current.client_id, title, template: { id: templateId, version: templateVersion, snapshotDigest: templateDigest } });
    content = applyTemplateLayoutLayers(content, activeTemplate, { reflow: body.templateApplyMode === 'reflow' || body.template_apply_mode === 'reflow' });
    content = applyTemplateBrandControls(content, activeTemplate);
    const trustedAssetRefs = collectPresentationAssetRefs(parseJson(current.content_json, {}));
    await assertPresentationAssetOwnership(user, content, { trustedRefs: trustedAssetRefs });
    const validation = runPresentationValidation(content);
    const contentJson = serializeJson(content);
    const existingJson = String(current.content_json || '');
    if (existingJson === contentJson && title === current.title) return toPublicPresentation(current, { includeContent: true });
    // Artifact 物理归属始终保持文稿所有者；授权编辑者的实际操作者仍由
    // presentation_versions.created_by 与路由审计记录。这样既允许协作者保存，
    // 又不会把 Artifact 所有权或下载边界意外转移给协作者。
    const artifactOwner = Number(current.owner_user_id) === Number(user.id) ? user : { id: Number(current.owner_user_id) };
    const artifact = await createStandaloneArtifact(artifactOwner, {
        artifactId: current.artifact_id,
        type: 'presentation',
        title,
        content: contentJson,
        preserveWhitespace: true,
        note: String(body.note || '保存演示文稿').trim().slice(0, 500)
    });
    const nextVersion = baseVersion + 1;
    const updated = await transaction(async trx => {
        const document = await trx.queryOne(`
            UPDATE presentation_documents
            SET title = ?, cover_asset_ref = ?, current_version = ?, status = ?, template_id = ?, template_version = ?, template_digest = ?, aspect_ratio = ?, updated_at = NOW()
            WHERE id = ? AND current_version = ? AND deleted_at IS NULL
            RETURNING *
        `, [title, String(content.metadata?.coverAssetRef || ''), nextVersion, validation.status === 'blocked' ? 'needs_attention' : 'draft', templateId, templateVersion, templateDigest, content.aspectRatio, current.id, baseVersion]);
        if (!document) throw publicError('文稿已被新版本更新，请刷新后合并修改。', 409, 'PRESENTATION_VERSION_CONFLICT');
        await trx.execute(`
            INSERT INTO presentation_versions (presentation_id, version, artifact_version_id, content_json, content_digest, validation_json, note, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [current.id, nextVersion, artifact.current_version_id || null, contentJson, computePresentationDigest(content), serializeJson(validation), String(body.note || '保存演示文稿').trim().slice(0, 500), user.id]);
        return document;
    });
    const output = { ...toPublicPresentation(updated), content, validation };
    if (activeTemplate?.definition) {
        output.templateDefinition = activeTemplate.definition;
        output.templateSourceFormat = activeTemplate.sourceFormat || activeTemplate.definition?.importMetadata?.sourceFormat || 'pivot';
        output.templateImportReport = activeTemplate.importReport || [];
    }
    publishPresentationRealtime(current.id, 'presentation.updated', { presentationId: current.client_id, version: output.version, changedBy: user.id }).catch(() => {});
    return output;
}

async function updatePresentationMetadata(user, clientId, body = {}) {
    const current = await getPresentationRow(user, clientId, { includeContent: false });
    if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    assertPresentationEditor(user, current);
    const title = body.title === undefined ? current.title : normalizeTitle(body.title);
    const tags = body.tags === undefined ? normalizeTags(parseJson(current.tags_json, [])) : normalizeTags(body.tags);
    const status = body.status === undefined ? current.status : (['draft', 'needs_attention', 'ready', 'archived'].includes(String(body.status)) ? String(body.status) : current.status);
    let templateId = current.template_id;
    let templateVersion = current.template_version;
    let templateDigest = current.template_digest;
    let aspectRatio = current.aspect_ratio;
    if (body.templateId !== undefined) {
        const requestedVersion = body.templateVersion || body.template_version;
        const template = requestedVersion ? await resolveTemplateVersionForUser(user, body.templateId, requestedVersion) : await resolveTemplateForUser(user, body.templateId);
        if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
        templateId = template.id;
        templateVersion = template.version;
        templateDigest = template.snapshotDigest;
        aspectRatio = template.aspectRatio;
    }
    const row = await queryOne('UPDATE presentation_documents SET title = ?, tags_json = ?, status = ?, template_id = ?, template_version = ?, template_digest = ?, aspect_ratio = ?, updated_at = NOW() WHERE id = ? RETURNING *', [title, serializeJson(tags), status, templateId, templateVersion, templateDigest, aspectRatio, current.id]);
    const output = toPublicPresentation(row);
    publishPresentationRealtime(current.id, 'presentation.updated', { presentationId: current.client_id, version: output.version, changedBy: user.id, metadataOnly: true }).catch(() => {});
    return output;
}

async function deletePresentation(user, clientId) {
    const tenant = await assertTenantContext(user);
    return (await execute(`
        UPDATE presentation_documents SET deleted_at = NOW(), updated_at = NOW(), status = 'archived'
        WHERE tenant_id = ? AND owner_user_id = ? AND client_id = ? AND deleted_at IS NULL
    `, [tenant.tenantId, user.id, normalizeClientId(clientId)])) > 0;
}

async function duplicatePresentation(user, clientId, options = {}) {
    const current = await getPresentation(user, clientId);
    if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    return await createPresentation(user, {
        title: normalizeTitle(options.title || `${current.title}（副本）`),
        templateId: current.template.id,
        templateVersion: current.template.version,
        aspectRatio: current.aspectRatio,
        content: { ...current.content, slides: current.content.slides.map(slide => ({ ...slide, id: `slide_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}` })) }
    });
}

async function listPresentationVersions(user, clientId) {
    const current = await getPresentationRow(user, clientId, { includeContent: false });
    if (!current) return null;
    const rows = await query(`
        SELECT version, content_digest, validation_json, note, created_by, created_at
        FROM presentation_versions WHERE presentation_id = ? ORDER BY version DESC
    `, [current.id]);
    return rows.map(row => ({ version: Number(row.version), contentDigest: row.content_digest, validation: parseJson(row.validation_json, {}), note: row.note || '', createdBy: Number(row.created_by), createdAt: row.created_at }));
}

async function getPresentationVersion(user, clientId, version) {
    const current = await getPresentationRow(user, clientId, { includeContent: false });
    if (!current) return null;
    const row = await queryOne('SELECT * FROM presentation_versions WHERE presentation_id = ? AND version = ?', [current.id, Number.parseInt(version, 10)]);
    if (!row) return null;
    return { version: Number(row.version), content: parseJson(row.content_json, null), validation: parseJson(row.validation_json, {}), note: row.note || '', createdAt: row.created_at };
}

async function rollbackPresentation(user, clientId, version, note = '') {
    const target = await getPresentationVersion(user, clientId, version);
    if (!target?.content) throw publicError('目标版本不存在。', 404, 'PRESENTATION_VERSION_NOT_FOUND');
    const current = await getPresentation(user, clientId);
    return await savePresentationContent(user, clientId, { baseVersion: current.version, title: current.title, content: target.content, note: String(note || `恢复版本 ${target.version}`).slice(0, 500) });
}

const assetService = createPresentationAssetService({
    publicError,
    normalizeDepartmentName,
    normalizeAssetScope,
    assetAccessClause,
    parseJson,
    assertTenantContext,
    query,
    queryOne,
    readBuffer,
    statObject,
    putBuffer,
    incrementRefCount,
    buildCasRef,
    parseCasRef,
    getPresentationRow,
    collectPresentationAssetRefs
});
const {
    inferPresentationAssetType,
    uploadPresentationAsset,
    publishPresentationAsset,
    listPresentationAssets,
    getPresentationAsset,
    getPresentationAssetByRef,
    resolvePresentationAssets,
    assertPresentationAssetOwnership
} = assetService;
const collabService = createCollabService({
    getPresentationRow,
    assertPresentationCommenter,
    assertPresentationEditor
});

const remoteService = createRemoteService({
    getPresentationRow,
    assertPresentationOwnerOrAdmin
});

const exportService = createExportService({
    getPresentationRow,
    assertPresentationOwnerOrAdmin,
    toPublicPresentation,
    resolvePresentationAssets
});

const {
    listPresentationComments,
    createPresentationComment,
    resolvePresentationComment,
    deletePresentationComment,
    listPresentationCollaborators,
    listCollaboratorCandidates,
    addPresentationCollaborator,
    removePresentationCollaborator
} = collabService;

const {
    createPresentationRemoteSession,
    setPresentationRemoteSlide,
    closePresentationRemoteSession,
    getPresentationRemoteState,
    getPresentationRemoteAsset
} = remoteService;

const {
    createPresentationExport,
    listPresentationExports
} = exportService;

module.exports = {
    addPresentationCollaborator,
    applyTemplateBrandControls,
    createPresentation,
    createPresentationFromArtifact,
    presentationFromArtifactText,
    createPresentationRemoteSession,
    setPresentationRemoteSlide,
    closePresentationRemoteSession,
    getPresentationRemoteState,
    getPresentationRemoteAsset,
    setPresentationFavorite,
    createPresentationComment,
    createPresentationExport,
    createPresentationTemplate,
    submitPresentationTemplateForReview,
    reviewPresentationTemplate,
    deletePresentation,
    deletePresentationComment,
    duplicatePresentation,
    exportPresentationTemplate,
    getPresentation,
    getPresentationTemplateStatistics,
    getPresentationTemplateSource,
    reparsePresentationTemplateSource,
    getPresentationAsset,
    listPresentationAssets,
    publishPresentationAsset,
    inferPresentationAssetType,
    getPresentationAssetByRef,
    getPresentationVersion,
    listPresentationCollaborators,
    listCollaboratorCandidates,
    listPresentationComments,
    listPresentationExports,
    listPresentationTemplates,
    listPresentationVersions,
    listPresentations,
    importPresentationTemplateFile,
    createPresentationTemplateImportJob,
    getPresentationTemplateImportJob,
    runPresentationTemplateImportJob,
    cancelPresentationTemplateImportJob,
    previewPresentationTemplateFile,
    parsePptxTemplateInWorker,
    normalizeTemplatePackage,
    normalizeTemplateDefinition,
    removePresentationCollaborator,
    applyTemplateLayoutLayers,
    resolveTemplateForUser,
    resolveTemplateVersionForUser,
    resolvePresentationComment,
    rollbackPresentation,
    savePresentationContent,
    updatePresentationMetadata,
    updatePresentationTemplate,
    uploadPresentationAsset
};
