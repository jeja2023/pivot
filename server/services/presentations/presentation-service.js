'use strict';

/** 演示文稿、模板、素材、版本和受控导出的业务服务。 */
const crypto = require('crypto');
const { query, queryOne, execute, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { assertTenantContext } = require('../agent-tenant-context');
const { createStandaloneArtifact, getAgentArtifactForUser } = require('../agent-artifacts');
const { buildCasRef, incrementRefCount, parseCasRef, putBuffer, readBuffer, statObject } = require('../agent-artifact-cas');
const { recordDeliveryEvent } = require('../agent-artifact-delivery');
const { isAdmin } = require('../../permissions');
const { readTypedEnv } = require('../../config/env-registry');
const { getBuiltInTemplate, listBuiltInTemplates } = require('./presentation-templates');
const {
    collectPresentationAssetRefs,
    computePresentationDigest,
    defaultPresentation,
    normalizePresentation,
} = require('./presentation-schema');
const { PRESENTATION_RENDERER_VERSION, renderPresentation } = require('./presentation-renderer');
const { runPresentationValidation } = require('./presentation-validation');

const MAX_TITLE_LENGTH = 160;
const MAX_TEMPLATE_NAME_LENGTH = 120;
const MAX_TEMPLATE_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = readTypedEnv('PIVOT_PRESENTATION_ASSET_MAX_BYTES');
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const EXPORT_FORMATS = new Set(['pptx', 'pdf', 'png']);

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
        deletedAt: row.deleted_at || null
    };
    if (includeContent) {
        output.content = parseJson(row.content_json, null);
        output.validation = parseJson(row.validation_json, { status: 'unknown', issues: [] });
    }
    return output;
}

function toPublicTemplate(row, { includeDefinition = false } = {}) {
    if (!row) return null;
    const definition = parseJson(row.definition_json, {});
    const output = {
        id: String(row.client_id),
        name: String(row.name),
        description: String(row.description || ''),
        version: Number(row.version || 1),
        ownerType: String(row.owner_type || 'user'),
        status: String(row.status || 'draft'),
        scope: String(row.scope || 'private'),
        aspectRatio: String(row.aspect_ratio || '16:9'),
        tags: parseJson(row.tags_json, []),
        snapshotDigest: String(row.snapshot_digest || ''),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
    if (includeDefinition) output.definition = definition;
    return output;
}

function systemTemplateToPublic(template) {
    return {
        id: template.id,
        name: template.name,
        description: template.description,
        version: template.version,
        ownerType: template.ownerType,
        status: template.status,
        scope: 'system',
        aspectRatio: template.aspectRatio,
        tags: [...template.tags],
        snapshotDigest: template.snapshotDigest,
        definition: { theme: template.theme, layouts: template.layouts }
    };
}

async function resolveTemplateForUser(user, templateId, { includeDefinition = true } = {}) {
    const id = String(templateId || 'business-blue').trim() || 'business-blue';
    const builtIn = getBuiltInTemplate(id);
    if (builtIn) return systemTemplateToPublic(builtIn);
    const tenant = await assertTenantContext(user);
    const row = await queryOne(`
        SELECT * FROM presentation_templates
        WHERE client_id = ? AND tenant_id = ? AND deleted_at IS NULL
          AND (owner_user_id = ? OR scope = 'organization' OR (scope = 'published' AND status = 'published'))
        LIMIT 1
    `, [id, tenant.tenantId, user.id]);
    return row ? toPublicTemplate(row, { includeDefinition }) : null;
}

async function listPresentationTemplates(user, options = {}) {
    const tenant = await assertTenantContext(user);
    const includeDrafts = options.includeDrafts === true;
    const rows = await query(`
        SELECT * FROM presentation_templates
        WHERE tenant_id = ? AND deleted_at IS NULL
          AND (owner_user_id = ? OR scope = 'organization' OR (scope = 'published' AND status = 'published'))
          ${includeDrafts && isAdmin(user) ? '' : "AND status = 'published'"}
        ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END, updated_at DESC, id DESC
    `, [tenant.tenantId, user.id]);
    return [...listBuiltInTemplates().map(systemTemplateToPublic), ...rows.map(row => toPublicTemplate(row, { includeDefinition: false }))];
}

function normalizeTemplateDefinition(body = {}) {
    const template = body.definition && typeof body.definition === 'object' ? body.definition : body;
    const theme = template.theme && typeof template.theme === 'object' ? template.theme : {};
    // 利用演示文稿校验器统一归一化主题，避免模板和文稿对颜色/字体有两套语义。
    const normalized = normalizePresentation(defaultPresentation({
        title: '模板校验',
        template: { id: 'template-check', version: 1, snapshotDigest: '' },
        aspectRatio: body.aspectRatio || template.aspectRatio || '16:9'
    }));
    const withTheme = normalizePresentation({ ...normalized, theme: { ...normalized.theme, ...theme, colors: { ...normalized.theme.colors, ...(theme.colors || {}) }, fonts: { ...normalized.theme.fonts, ...(theme.fonts || {}) } } });
    const layouts = Array.isArray(template.layouts) ? template.layouts.slice(0, 30).map(layout => ({
        id: normalizeClientId(layout?.id),
        name: String(layout?.name || '').trim().slice(0, 120) || '未命名布局',
        category: String(layout?.category || '内容').trim().slice(0, 60),
        slots: Array.isArray(layout?.slots) ? layout.slots.slice(0, 20).map(slot => String(slot).trim().slice(0, 64)).filter(Boolean) : []
    })) : [];
    if (!layouts.length) throw publicError('模板至少需要一个布局。', 400, 'PRESENTATION_TEMPLATE_LAYOUT_REQUIRED');
    return { theme: withTheme.theme, layouts };
}

async function createPresentationTemplate(user, body = {}) {
    if (!isAdmin(user)) throw publicError('只有管理员可以创建组织模板。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    const clientId = body.id ? normalizeClientId(body.id) : `template_${crypto.randomUUID().replace(/-/g, '')}`;
    const name = normalizeTitle(body.name || '未命名模板').slice(0, MAX_TEMPLATE_NAME_LENGTH);
    const description = String(body.description || '').trim().slice(0, 500);
    const definition = normalizeTemplateDefinition(body);
    const scope = ['private', 'organization', 'published'].includes(String(body.scope)) ? String(body.scope) : 'organization';
    const status = body.publish === true ? 'published' : 'draft';
    const tags = Array.isArray(body.tags) ? body.tags.slice(0, 12).map(tag => String(tag).trim().slice(0, 32)).filter(Boolean) : [];
    const snapshotDigest = crypto.createHash('sha256').update(JSON.stringify({ name, definition, scope, version: 1 })).digest('hex');
    const row = await queryOne(`
        INSERT INTO presentation_templates
            (tenant_id, owner_user_id, client_id, name, description, owner_type, status, scope, aspect_ratio, tags_json, definition_json, snapshot_digest, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
        RETURNING *
    `, [tenant.tenantId, user.id, clientId, name, description, status, scope, body.aspectRatio === '4:3' ? '4:3' : '16:9', serializeJson(tags), serializeJson(definition), snapshotDigest]);
    return toPublicTemplate(row, { includeDefinition: true });
}

async function updatePresentationTemplate(user, templateId, body = {}) {
    if (!isAdmin(user)) throw publicError('只有管理员可以维护组织模板。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    const existing = await queryOne('SELECT * FROM presentation_templates WHERE client_id = ? AND tenant_id = ? AND deleted_at IS NULL', [normalizeClientId(templateId), tenant.tenantId]);
    if (!existing) throw publicError('模板不存在或无权访问。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    const name = body.name === undefined ? existing.name : normalizeTitle(body.name).slice(0, MAX_TEMPLATE_NAME_LENGTH);
    const description = body.description === undefined ? existing.description : String(body.description || '').trim().slice(0, 500);
    const definition = body.definition || body.theme || body.layouts ? normalizeTemplateDefinition({ ...body, aspectRatio: body.aspectRatio || existing.aspect_ratio }) : parseJson(existing.definition_json, {});
    const version = Number(existing.version) + 1;
    const scope = body.scope === undefined ? existing.scope : (['private', 'organization', 'published'].includes(String(body.scope)) ? String(body.scope) : existing.scope);
    const status = body.status === undefined ? existing.status : (['draft', 'published', 'unpublished'].includes(String(body.status)) ? String(body.status) : existing.status);
    const tags = body.tags === undefined ? parseJson(existing.tags_json, []) : (Array.isArray(body.tags) ? body.tags.slice(0, 12).map(tag => String(tag).trim().slice(0, 32)).filter(Boolean) : []);
    const snapshotDigest = crypto.createHash('sha256').update(JSON.stringify({ name, description, definition, scope, version })).digest('hex');
    const row = await queryOne(`
        UPDATE presentation_templates
        SET name = ?, description = ?, status = ?, scope = ?, tags_json = ?, definition_json = ?, snapshot_digest = ?, version = ?, updated_at = NOW()
        WHERE id = ?
        RETURNING *
    `, [name, description, status, scope, serializeJson(tags), serializeJson(definition), snapshotDigest, version, existing.id]);
    return toPublicTemplate(row, { includeDefinition: true });
}

function normalizeTemplatePackage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw publicError('模板包格式无效。', 400, 'PRESENTATION_TEMPLATE_PACKAGE_INVALID');
    if (String(value.kind || '') !== 'pivot-presentation-template' || String(value.schemaVersion || '') !== '1.0') {
        throw publicError('模板包不是受支持的 Pivot 演示文稿模板格式。', 400, 'PRESENTATION_TEMPLATE_PACKAGE_INVALID');
    }
    const template = value.template;
    if (!template || typeof template !== 'object' || Array.isArray(template)) throw publicError('模板包缺少模板定义。', 400, 'PRESENTATION_TEMPLATE_PACKAGE_INVALID');
    return {
        name: normalizeTitle(template.name || '导入模板').slice(0, MAX_TEMPLATE_NAME_LENGTH),
        description: String(template.description || '').trim().slice(0, 500),
        aspectRatio: template.aspectRatio === '4:3' ? '4:3' : '16:9',
        tags: Array.isArray(template.tags) ? template.tags.slice(0, 12).map(tag => String(tag).trim().slice(0, 32)).filter(Boolean) : [],
        definition: normalizeTemplateDefinition({ definition: template.definition, aspectRatio: template.aspectRatio })
    };
}

async function importPresentationTemplate(user, buffer, options = {}) {
    if (!isAdmin(user)) throw publicError('只有管理员可以导入组织模板。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_TEMPLATE_PACKAGE_BYTES) {
        throw publicError('模板包为空或超过大小上限。', 413, 'PRESENTATION_TEMPLATE_PACKAGE_TOO_LARGE');
    }
    let parsed;
    try { parsed = JSON.parse(buffer.toString('utf8')); } catch (_) { throw publicError('模板包不是有效 JSON。', 400, 'PRESENTATION_TEMPLATE_PACKAGE_INVALID'); }
    const normalized = normalizeTemplatePackage(parsed);
    return await createPresentationTemplate(user, { ...normalized, scope: options.scope || 'organization', publish: options.publish !== false });
}

async function exportPresentationTemplate(user, templateId) {
    const template = await resolveTemplateForUser(user, templateId, { includeDefinition: true });
    if (!template?.definition) throw publicError('模板不存在或无权访问。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    return {
        schemaVersion: '1.0',
        kind: 'pivot-presentation-template',
        exportedAt: getBeijingTimestamp(),
        template: {
            id: template.id,
            name: template.name,
            description: template.description,
            aspectRatio: template.aspectRatio,
            tags: template.tags,
            version: template.version,
            snapshotDigest: template.snapshotDigest,
            definition: template.definition
        }
    };
}

async function listPresentations(user, options = {}) {
    const tenant = await assertTenantContext(user);
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 100));
    const rows = await query(`
        SELECT * FROM presentation_documents
        WHERE tenant_id = ? AND owner_user_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
    `, [tenant.tenantId, user.id, limit]);
    return rows.map(row => toPublicPresentation(row));
}

async function getPresentationRow(user, clientId, { includeContent = false } = {}) {
    const tenant = await assertTenantContext(user);
    const row = await queryOne(`
        SELECT d.*, v.content_json, v.validation_json
        FROM presentation_documents d
        LEFT JOIN presentation_versions v ON v.presentation_id = d.id AND v.version = d.current_version
        WHERE d.tenant_id = ? AND d.owner_user_id = ? AND d.client_id = ? AND d.deleted_at IS NULL
    `, [tenant.tenantId, user.id, normalizeClientId(clientId)]);
    return includeContent ? row : row && { ...row, content_json: undefined, validation_json: undefined };
}

async function getPresentation(user, clientId) {
    const row = await getPresentationRow(user, clientId, { includeContent: true });
    return row ? toPublicPresentation(row, { includeContent: true }) : null;
}

async function createPresentation(user, body = {}) {
    const tenant = await assertTenantContext(user);
    const clientId = body.id ? normalizeClientId(body.id) : newClientId();
    const title = normalizeTitle(body.title);
    const template = await resolveTemplateForUser(user, body.templateId || body.template?.id || 'business-blue');
    if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    const content = body.content ? normalizePresentation({ ...body.content, presentationId: clientId, title, template: { id: template.id, version: template.version, snapshotDigest: template.snapshotDigest }, theme: body.content.theme || template.definition.theme }) : defaultPresentation({ presentationId: clientId, title, template, aspectRatio: body.aspectRatio || template.aspectRatio });
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
            (tenant_id, owner_user_id, client_id, artifact_id, title, status, aspect_ratio, template_id, template_version, template_digest, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, NOW(), NOW())
        RETURNING *
    `, [tenant.tenantId, user.id, clientId, artifact.id, title, content.aspectRatio, template.id, template.version, template.snapshotDigest]);
    await execute(`
        INSERT INTO presentation_versions (presentation_id, version, artifact_version_id, content_json, content_digest, validation_json, note, created_by, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, NOW())
    `, [row.id, artifact.current_version_id || null, serializeJson(content), computePresentationDigest(content), serializeJson(validation), '创建演示文稿', user.id]);
    return await getPresentation(user, clientId);
}

async function savePresentationContent(user, clientId, body = {}) {
    const current = await getPresentationRow(user, clientId, { includeContent: true });
    if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    const baseVersion = Number.parseInt(body.baseVersion, 10);
    if (!Number.isSafeInteger(baseVersion) || baseVersion !== Number(current.current_version)) {
        throw publicError('文稿已被新版本更新，请刷新后合并修改。', 409, 'PRESENTATION_VERSION_CONFLICT');
    }
    const title = body.title === undefined ? current.title : normalizeTitle(body.title);
    let templateId = current.template_id;
    let templateVersion = current.template_version;
    let templateDigest = current.template_digest;
    if (body.templateId !== undefined && String(body.templateId).trim() !== String(current.template_id)) {
        const template = await resolveTemplateForUser(user, body.templateId);
        if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
        templateId = template.id;
        templateVersion = template.version;
        templateDigest = template.snapshotDigest;
    }
    const content = normalizePresentation({ ...(body.content || {}), presentationId: current.client_id, title, template: { id: templateId, version: templateVersion, snapshotDigest: templateDigest } });
    await assertPresentationAssetOwnership(user, content);
    const validation = runPresentationValidation(content);
    const contentJson = serializeJson(content);
    const existingJson = String(current.content_json || '');
    if (existingJson === contentJson && title === current.title) return toPublicPresentation(current, { includeContent: true });
    const artifact = await createStandaloneArtifact(user, {
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
            SET title = ?, current_version = ?, status = ?, template_id = ?, template_version = ?, template_digest = ?, aspect_ratio = ?, updated_at = NOW()
            WHERE id = ? AND current_version = ? AND deleted_at IS NULL
            RETURNING *
        `, [title, nextVersion, validation.status === 'blocked' ? 'needs_attention' : 'draft', templateId, templateVersion, templateDigest, content.aspectRatio, current.id, baseVersion]);
        if (!document) throw publicError('文稿已被新版本更新，请刷新后合并修改。', 409, 'PRESENTATION_VERSION_CONFLICT');
        await trx.execute(`
            INSERT INTO presentation_versions (presentation_id, version, artifact_version_id, content_json, content_digest, validation_json, note, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [current.id, nextVersion, artifact.current_version_id || null, contentJson, computePresentationDigest(content), serializeJson(validation), String(body.note || '保存演示文稿').trim().slice(0, 500), user.id]);
        return document;
    });
    return { ...toPublicPresentation(updated), content, validation };
}

async function updatePresentationMetadata(user, clientId, body = {}) {
    const current = await getPresentationRow(user, clientId, { includeContent: false });
    if (!current) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    const title = body.title === undefined ? current.title : normalizeTitle(body.title);
    const status = body.status === undefined ? current.status : (['draft', 'needs_attention', 'ready', 'archived'].includes(String(body.status)) ? String(body.status) : current.status);
    let templateId = current.template_id;
    let templateVersion = current.template_version;
    let templateDigest = current.template_digest;
    let aspectRatio = current.aspect_ratio;
    if (body.templateId !== undefined) {
        const template = await resolveTemplateForUser(user, body.templateId);
        if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
        templateId = template.id;
        templateVersion = template.version;
        templateDigest = template.snapshotDigest;
        aspectRatio = template.aspectRatio;
    }
    const row = await queryOne('UPDATE presentation_documents SET title = ?, status = ?, template_id = ?, template_version = ?, template_digest = ?, aspect_ratio = ?, updated_at = NOW() WHERE id = ? RETURNING *', [title, status, templateId, templateVersion, templateDigest, aspectRatio, current.id]);
    return toPublicPresentation(row);
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

async function uploadPresentationAsset(user, file) {
    if (!file?.buffer || !Buffer.isBuffer(file.buffer)) throw publicError('请选择图片素材。', 400, 'PRESENTATION_ASSET_REQUIRED');
    if (file.buffer.length > MAX_ASSET_BYTES) throw publicError('图片素材超过大小上限。', 413, 'PRESENTATION_ASSET_TOO_LARGE');
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw publicError('仅支持 PNG、JPG、WebP 或 GIF 图片。', 400, 'PRESENTATION_ASSET_TYPE_INVALID');
    const tenant = await assertTenantContext(user);
    const stored = await putBuffer({ buffer: file.buffer, mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'presentation_asset', retentionDays: 365 });
    await incrementRefCount(stored.objectId, 1);
    const row = await queryOne(`
        INSERT INTO presentation_assets (tenant_id, owner_user_id, object_id, filename, mime_type, byte_size, content_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        ON CONFLICT (tenant_id, owner_user_id, object_id) DO UPDATE SET filename = EXCLUDED.filename
        RETURNING *
    `, [tenant.tenantId, user.id, stored.objectId, String(file.originalname || '图片素材').replace(/[\\/]/g, '_').slice(0, 240), mimeType, stored.byteSize, stored.contentDigest]);
    return { id: Number(row.id), ref: buildCasRef(stored.objectId), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), contentDigest: row.content_digest, createdAt: row.created_at };
}

async function getPresentationAsset(user, assetId) {
    const tenant = await assertTenantContext(user);
    const row = await queryOne('SELECT * FROM presentation_assets WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND deleted_at IS NULL', [Number.parseInt(assetId, 10), tenant.tenantId, user.id]);
    if (!row) return null;
    const loaded = await readBuffer({ objectId: row.object_id, tenantId: tenant.tenantId, userId: user.id });
    return { asset: { id: Number(row.id), ref: buildCasRef(row.object_id), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size) }, buffer: loaded.buffer };
}

async function getPresentationAssetByRef(user, ref) {
    const objectId = parseCasRef(ref);
    if (!objectId) return null;
    const tenant = await assertTenantContext(user);
    const row = await queryOne('SELECT * FROM presentation_assets WHERE object_id = ? AND tenant_id = ? AND owner_user_id = ? AND deleted_at IS NULL', [objectId, tenant.tenantId, user.id]);
    if (!row) return null;
    const loaded = await readBuffer({ objectId: row.object_id, tenantId: tenant.tenantId, userId: user.id });
    return { asset: { id: Number(row.id), ref: buildCasRef(row.object_id), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size) }, buffer: loaded.buffer };
}

async function resolvePresentationAssets(user, content) {
    const tenant = await assertTenantContext(user);
    const assets = new Map();
    for (const ref of collectPresentationAssetRefs(content)) {
        const objectId = parseCasRef(ref);
        const asset = objectId ? await queryOne(`
            SELECT object_id FROM presentation_assets
            WHERE tenant_id = ? AND owner_user_id = ? AND object_id = ? AND deleted_at IS NULL
        `, [tenant.tenantId, user.id, objectId]) : null;
        const object = asset ? await statObject({ objectId: asset.object_id, tenantId: tenant.tenantId }) : null;
        if (!object) throw publicError('演示文稿引用的素材不存在或无权访问。', 403, 'PRESENTATION_ASSET_FORBIDDEN');
        const loaded = await readBuffer({ objectId: asset.object_id, tenantId: tenant.tenantId, userId: user.id });
        assets.set(ref, { buffer: loaded.buffer, mimeType: loaded.object.mime_type });
    }
    return assets;
}

/** 保存前只校验素材归属，不读取二进制内容，避免不可信 IR 留下跨账号 CAS 引用。 */
async function assertPresentationAssetOwnership(user, content) {
    const tenant = await assertTenantContext(user);
    for (const ref of collectPresentationAssetRefs(content)) {
        const objectId = parseCasRef(ref);
        const asset = objectId ? await queryOne(`
            SELECT 1 AS allowed FROM presentation_assets
            WHERE tenant_id = ? AND owner_user_id = ? AND object_id = ? AND deleted_at IS NULL
        `, [tenant.tenantId, user.id, objectId]) : null;
        if (!asset) throw publicError('演示文稿引用了不存在或无权访问的素材。', 403, 'PRESENTATION_ASSET_FORBIDDEN');
    }
}

async function createPresentationExport(user, clientId, format, options = {}) {
    const normalizedFormat = String(format || '').toLowerCase();
    if (!EXPORT_FORMATS.has(normalizedFormat)) throw publicError('仅支持导出 PPTX、PDF 或 PNG。', 400, 'PRESENTATION_EXPORT_FORMAT_INVALID');
    const currentRow = await getPresentationRow(user, clientId, { includeContent: true });
    if (!currentRow) throw publicError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
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
    const assets = await resolvePresentationAssets(user, current.content);
    const rendered = await renderPresentation(current.content, normalizedFormat, { slideIndex: options.slideIndex, assetResolver: async ref => assets.get(ref) || null });
    const output = await putBuffer({ buffer: rendered.buffer, mimeType: rendered.mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: `presentation_${normalizedFormat}` });
    const runId = `standalone-artifact:${artifact.id}`;
    // agent_artifact_renditions.tool_call_id 为 VARCHAR(64)。业务主键可为 UUID，
    // 这里用 Artifact 数字 ID 维持可审计、稳定且长度受控的用户操作标识。
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

module.exports = {
    createPresentation,
    createPresentationExport,
    createPresentationTemplate,
    deletePresentation,
    duplicatePresentation,
    exportPresentationTemplate,
    getPresentation,
    getPresentationAsset,
    getPresentationAssetByRef,
    getPresentationVersion,
    listPresentationExports,
    listPresentationTemplates,
    listPresentationVersions,
    listPresentations,
    importPresentationTemplate,
    normalizeTemplatePackage,
    rollbackPresentation,
    savePresentationContent,
    updatePresentationMetadata,
    updatePresentationTemplate,
    uploadPresentationAsset
};
