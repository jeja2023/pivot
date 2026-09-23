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
const { importPptxTemplatePackage } = require('./presentation-pptx-template-import');
const { isVbaFilename, isMacroEnabledPresentation, scanVbaSource } = require('./presentation-vba');
const {
    collectPresentationAssetRefs,
    computePresentationDigest,
    defaultPresentation,
    normalizePresentation,
} = require('./presentation-schema');
const { runPresentationValidation } = require('./presentation-validation');
const { publishPresentationRealtime } = require('./presentation-realtime');
const { createCollabService } = require('./presentation-collab-service');
const { createRemoteService, remoteTokenHash, remotePublicContent } = require('./presentation-remote-service');
const { createExportService } = require('./presentation-export-service');

const MAX_TITLE_LENGTH = 160;
const MAX_TEMPLATE_NAME_LENGTH = 120;
const MAX_TEMPLATE_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = readTypedEnv('PIVOT_PRESENTATION_ASSET_MAX_BYTES');
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const FONT_MIME_TYPES = new Set(['font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/font-sfnt', 'application/vnd.ms-fontobject']);
const AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac']);
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const ATTACHMENT_MIME_TYPES = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain', 'text/markdown', 'application/vnd.ms-powerpoint.presentation.macroenabled.12', 'application/vnd.ms-powerpoint.slideshow.macroenabled.12']);
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

function inferPresentationAssetType(file) {
    const mime = String(file?.mimetype || '').toLowerCase();
    const name = String(file?.originalname || '').toLowerCase();
    const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.alloc(0);
    const hasAscii = value => buffer.subarray(0, Buffer.byteLength(value)).toString('ascii') === value;
    const hasFtyp = buffer.subarray(4, 8).toString('ascii') === 'ftyp';
    const ttf = buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0 && buffer[3] === 0;
    const webm = buffer.length >= 4 && buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3;
    if (IMAGE_MIME_TYPES.has(mime)) return 'image';
    if (FONT_MIME_TYPES.has(mime) || (/\.(ttf|otf|woff2?)$/.test(name) && (hasAscii('wOFF') || hasAscii('wOF2') || hasAscii('OTTO') || ttf))) return 'font';
    if (AUDIO_MIME_TYPES.has(mime) || (/\.(mp3|wav|ogg|aac|m4a)$/.test(name) && (hasAscii('RIFF') || hasAscii('ID3') || hasAscii('OggS') || hasFtyp))) return 'audio';
    if (VIDEO_MIME_TYPES.has(mime) || (/\.(mp4|webm|mov)$/.test(name) && (webm || hasFtyp))) return 'video';
    const safeMacroSource = /\.(bas|vba)$/.test(name) && buffer.length > 0 && !buffer.subarray(0, Math.min(buffer.length, 1024)).includes(0);
    if (ATTACHMENT_MIME_TYPES.has(mime) || (/\.(pdf|docx|xlsx|txt|md|pptm|ppsm)$/.test(name) && (hasAscii('%PDF') || hasAscii('PK\x03\x04') || mime.startsWith('text/'))) || safeMacroSource) return 'attachment';
    return '';
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
        departmentName: String(row.department_name || ''),
        aspectRatio: String(row.aspect_ratio || '16:9'),
        tags: parseJson(row.tags_json, []),
        snapshotDigest: String(row.snapshot_digest || ''),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        submittedAt: row.submitted_at || null,
        reviewedBy: row.reviewed_by ? Number(row.reviewed_by) : null,
        reviewedAt: row.reviewed_at || null,
        reviewNote: String(row.review_note || '')
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
          AND (
              owner_user_id = ?
              OR (scope IN ('organization', 'published') AND status = 'published')
              OR (scope = 'department' AND status = 'published' AND department_name = ?)
          )
        LIMIT 1
    `, [id, tenant.tenantId, user.id, normalizeDepartmentName(user.unit)]);
    return row ? toPublicTemplate(row, { includeDefinition }) : null;
}

async function listPresentationTemplates(user, options = {}) {
    const tenant = await assertTenantContext(user);
    const includeReviewQueue = options.includeDrafts === true && isAdmin(user);
    const rows = await query(`
        SELECT * FROM presentation_templates
        WHERE tenant_id = ? AND deleted_at IS NULL
          AND (
              owner_user_id = ?
              OR (scope IN ('organization', 'published') AND status = 'published')
              OR (scope = 'department' AND status = 'published' AND department_name = ?)
              OR (? = true AND status IN ('draft', 'pending_review', 'unpublished'))
          )
        ORDER BY CASE WHEN status = 'pending_review' THEN 0 WHEN status = 'published' THEN 1 ELSE 2 END, updated_at DESC, id DESC
    `, [tenant.tenantId, user.id, normalizeDepartmentName(user.unit), includeReviewQueue]);
    return [...listBuiltInTemplates().map(systemTemplateToPublic), ...rows.map(row => toPublicTemplate(row, { includeDefinition: true }))];
}

function normalizeBrandControls(input = {}) {
    const controls = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const logoAssetRef = String(controls.logoAssetRef || controls.logo_asset_ref || '').trim();
    if (logoAssetRef && !parseCasRef(logoAssetRef)) throw publicError('品牌 Logo 必须引用受控素材。', 400, 'PRESENTATION_BRAND_LOGO_INVALID');
    return {
        footerText: String(controls.footerText || controls.footer_text || '').trim().slice(0, 160),
        logoAssetRef,
        lockBrandElements: controls.lockBrandElements === true || controls.lock_brand_elements === true,
        lockFonts: controls.lockFonts === true || controls.lock_fonts === true,
        showPageNumber: controls.showPageNumber === true || controls.show_page_number === true
    };
}

function applyTemplateBrandControls(content, template) {
    const controls = template?.definition?.brandControls || template?.brandControls || {};
    const hasExistingBrandElements = (content.slides || []).some(slide => (slide.elements || []).some(element => String(element.id || '').startsWith('pivotBrand_')));
    if (!controls.lockBrandElements && !controls.lockFonts && !hasExistingBrandElements) return content;
    const theme = template?.definition?.theme || content.theme || {};
    const slides = (content.slides || []).map((slide, slideIndex) => {
        let elements = (slide.elements || []).filter(element => !String(element.id || '').startsWith('pivotBrand_')).map(element => ({ ...element, style: element.style ? { ...element.style } : element.style }));
        if (controls.lockFonts) {
            elements = elements.map(element => element.type === 'text' ? { ...element, style: { ...element.style, fontFamily: Number(element.style?.fontSize || 0) >= 24 ? theme.fonts?.heading || element.style?.fontFamily : theme.fonts?.body || element.style?.fontFamily } } : element);
        }
        if (controls.lockBrandElements) {
            const textColor = theme.colors?.text || '#1F2937';
            const footerY = Math.max(664, Number(content.height || 720) - 48);
            if (controls.footerText) elements.push({ id: 'pivotBrand_footer', type: 'text', x: 64, y: footerY, width: 900, height: 24, rotation: 0, zIndex: 990, locked: true, visible: true, sourceRefs: [], content: { text: controls.footerText }, style: { fontFamily: theme.fonts?.body || 'Microsoft YaHei', fontSize: 10, fontWeight: 400, color: textColor, align: 'left', verticalAlign: 'middle', lineHeight: 1.2, italic: false, underline: false, bullet: false, padding: 0 } });
            if (controls.showPageNumber) elements.push({ id: 'pivotBrand_page', type: 'text', x: 1160, y: footerY, width: 56, height: 24, rotation: 0, zIndex: 991, locked: true, visible: true, sourceRefs: [], content: { text: String(slideIndex + 1) }, style: { fontFamily: theme.fonts?.body || 'Microsoft YaHei', fontSize: 10, fontWeight: 400, color: textColor, align: 'right', verticalAlign: 'middle', lineHeight: 1.2, italic: false, underline: false, bullet: false, padding: 0 } });
            if (controls.logoAssetRef) elements.push({ id: 'pivotBrand_logo', type: 'image', x: 1080, y: 28, width: 120, height: 48, rotation: 0, zIndex: 992, locked: true, visible: true, sourceRefs: [], assetRef: controls.logoAssetRef, fit: 'contain', opacity: 1, alt: '组织品牌 Logo' });
        }
        return { ...slide, elements };
    });
    return normalizePresentation({ ...content, theme: { ...content.theme, ...theme, colors: { ...(content.theme?.colors || {}), ...(theme.colors || {}) }, fonts: { ...(content.theme?.fonts || {}), ...(theme.fonts || {}) } }, slides });
}

async function assertBrandControlAssetAccess(user, definition) {
    const ref = String(definition?.brandControls?.logoAssetRef || '').trim();
    if (!ref) return;
    const objectId = parseCasRef(ref);
    const found = objectId ? await findPresentationAssetForUser(user, objectId) : null;
    if (!found?.row) throw publicError('品牌 Logo 素材不存在或无权访问。', 403, 'PRESENTATION_BRAND_LOGO_FORBIDDEN');
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
    const importMetadata = template.importMetadata && typeof template.importMetadata === 'object' ? { sourceFormat: String(template.importMetadata.sourceFormat || '').slice(0, 32), importedAt: String(template.importMetadata.importedAt || '').slice(0, 64), warningCount: Math.max(0, Math.min(Number(template.importMetadata.warningCount) || 0, 1000)) } : undefined;
    return { theme: withTheme.theme, layouts, brandControls: normalizeBrandControls(template.brandControls || body.brandControls), ...(importMetadata ? { importMetadata } : {}) };
}

async function createPresentationTemplate(user, body = {}) {
    if (!isAdmin(user)) throw publicError('只有管理员可以创建组织模板。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    const clientId = body.id ? normalizeClientId(body.id) : `template_${crypto.randomUUID().replace(/-/g, '')}`;
    const name = normalizeTitle(body.name || '未命名模板').slice(0, MAX_TEMPLATE_NAME_LENGTH);
    const description = String(body.description || '').trim().slice(0, 500);
    const definition = normalizeTemplateDefinition(body);
    await assertBrandControlAssetAccess(user, definition);
    const scope = ['private', 'organization', 'department', 'published'].includes(String(body.scope)) ? String(body.scope) : 'organization';
    const departmentName = scope === 'department' ? normalizeDepartmentName(body.departmentName || body.department_name || user.unit) : '';
    if (scope === 'department' && !departmentName) throw publicError('部门模板必须指定部门。', 400, 'PRESENTATION_TEMPLATE_DEPARTMENT_REQUIRED');
    const status = body.status === 'pending_review' || body.publish === true ? 'pending_review' : 'draft';
    const tags = Array.isArray(body.tags) ? body.tags.slice(0, 12).map(tag => String(tag).trim().slice(0, 32)).filter(Boolean) : [];
    const snapshotDigest = crypto.createHash('sha256').update(JSON.stringify({ name, definition, scope, version: 1 })).digest('hex');
    const row = await queryOne(`
        INSERT INTO presentation_templates
            (tenant_id, owner_user_id, client_id, name, description, owner_type, status, scope, department_name, aspect_ratio, tags_json, definition_json, snapshot_digest, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
        RETURNING *
    `, [tenant.tenantId, user.id, clientId, name, description, status, scope, departmentName, body.aspectRatio === '4:3' ? '4:3' : '16:9', serializeJson(tags), serializeJson(definition), snapshotDigest]);
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
    await assertBrandControlAssetAccess(user, definition);
    const version = Number(existing.version) + 1;
    const scope = body.scope === undefined ? existing.scope : (['private', 'organization', 'department', 'published'].includes(String(body.scope)) ? String(body.scope) : existing.scope);
    const departmentName = scope === 'department' ? normalizeDepartmentName(body.departmentName ?? body.department_name ?? existing.department_name ?? user.unit) : '';
    if (scope === 'department' && !departmentName) throw publicError('部门模板必须指定部门。', 400, 'PRESENTATION_TEMPLATE_DEPARTMENT_REQUIRED');
    if (body.status === 'published') throw publicError('模板必须经过审核接口发布。', 409, 'PRESENTATION_TEMPLATE_REVIEW_REQUIRED');
    const status = body.status === undefined ? (existing.status === 'published' && (body.definition || body.theme || body.layouts) ? 'draft' : existing.status) : (['draft', 'pending_review', 'unpublished'].includes(String(body.status)) ? String(body.status) : existing.status);
    const tags = body.tags === undefined ? parseJson(existing.tags_json, []) : (Array.isArray(body.tags) ? body.tags.slice(0, 12).map(tag => String(tag).trim().slice(0, 32)).filter(Boolean) : []);
    const snapshotDigest = crypto.createHash('sha256').update(JSON.stringify({ name, description, definition, scope, version })).digest('hex');
    const row = await queryOne(`
        UPDATE presentation_templates
        SET name = ?, description = ?, status = ?, scope = ?, department_name = ?, tags_json = ?, definition_json = ?, snapshot_digest = ?, version = ?, submitted_at = CASE WHEN ? = 'pending_review' THEN NOW() ELSE submitted_at END, updated_at = NOW()
        WHERE id = ?
        RETURNING *
    `, [name, description, status, scope, departmentName, serializeJson(tags), serializeJson(definition), snapshotDigest, version, status, existing.id]);
    return toPublicTemplate(row, { includeDefinition: true });
}

async function submitPresentationTemplateForReview(user, templateId) {
    if (!isAdmin(user)) throw publicError('只有管理员可以提交模板审核。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    const existing = await queryOne('SELECT * FROM presentation_templates WHERE client_id = ? AND tenant_id = ? AND deleted_at IS NULL', [normalizeClientId(templateId), tenant.tenantId]);
    if (!existing) throw publicError('模板不存在或无权访问。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    if (!['draft', 'unpublished'].includes(String(existing.status))) throw publicError('只有草稿或已下架模板可以提交审核。', 409, 'PRESENTATION_TEMPLATE_REVIEW_STATE_INVALID');
    const row = await queryOne("UPDATE presentation_templates SET status = 'pending_review', submitted_at = NOW(), review_note = '', updated_at = NOW() WHERE id = ? RETURNING *", [existing.id]);
    return toPublicTemplate(row, { includeDefinition: true });
}

async function reviewPresentationTemplate(user, templateId, body = {}) {
    if (!isAdmin(user)) throw publicError('只有管理员可以审核模板。', 403, 'PRESENTATION_TEMPLATE_REVIEW_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    const existing = await queryOne('SELECT * FROM presentation_templates WHERE client_id = ? AND tenant_id = ? AND deleted_at IS NULL', [normalizeClientId(templateId), tenant.tenantId]);
    if (!existing) throw publicError('模板不存在或无权访问。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    if (String(existing.status) !== 'pending_review') throw publicError('模板当前不在待审核状态。', 409, 'PRESENTATION_TEMPLATE_REVIEW_STATE_INVALID');
    const approved = body.approved === true || String(body.status || '').toLowerCase() === 'approved';
    const note = String(body.note || body.reviewNote || '').trim().slice(0, 2000);
    if (!note) throw publicError('审核说明不能为空。', 400, 'PRESENTATION_TEMPLATE_REVIEW_NOTE_REQUIRED');
    const nextStatus = approved ? 'published' : 'unpublished';
    const row = await queryOne('UPDATE presentation_templates SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_note = ?, updated_at = NOW() WHERE id = ? RETURNING *', [nextStatus, user.id, note, existing.id]);
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

async function importPresentationTemplateFile(user, buffer, options = {}) {
    const filename = String(options.filename || '').trim();
    const mimeType = String(options.mimeType || options.mimetype || '').toLowerCase();
    const isPptx = /\.pptx$/i.test(filename) || mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (!isPptx) return await importPresentationTemplate(user, buffer, options);
    const parsed = await importPptxTemplatePackage(buffer, { filename, name: options.name });
    const template = await createPresentationTemplate(user, {
        name: parsed.name,
        description: '从外部 PPTX 提取的受控主题模板。' + (parsed.warnings.length ? ' 导入时发现 ' + parsed.warnings.length + ' 项兼容性提示。' : ''),
        aspectRatio: parsed.aspectRatio,
        definition: parsed.definition,
        scope: options.scope || 'organization',
        publish: options.publish !== false
    });
    return { ...template, importWarnings: parsed.warnings, sourceFormat: 'pptx' };
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

async function getPresentationTemplateStatistics(user) {
    if (!isAdmin(user)) throw publicError('只有管理员可以查看模板统计。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    const templates = await query(`
        SELECT scope, status, COUNT(*)::BIGINT AS count
        FROM presentation_templates
        WHERE tenant_id = ? AND deleted_at IS NULL
        GROUP BY scope, status
        ORDER BY scope, status
    `, [tenant.tenantId]);
    const assets = await queryOne(`
        SELECT COUNT(*)::BIGINT AS count, COALESCE(SUM(byte_size), 0)::BIGINT AS bytes
        FROM presentation_assets
        WHERE tenant_id = ? AND deleted_at IS NULL
    `, [tenant.tenantId]);
    const usage = await query(`
        SELECT template_id, template_version, COUNT(*)::BIGINT AS document_count
        FROM presentation_documents
        WHERE tenant_id = ? AND deleted_at IS NULL
        GROUP BY template_id, template_version
        ORDER BY document_count DESC, template_id ASC
        LIMIT 20
    `, [tenant.tenantId]);
    return {
        templates: templates.map(item => ({ scope: item.scope, status: item.status, count: Number(item.count || 0) })),
        assets: { count: Number(assets?.count || 0), bytes: Number(assets?.bytes || 0) },
        usage: usage.map(item => ({ templateId: item.template_id, templateVersion: Number(item.template_version || 0), documentCount: Number(item.document_count || 0) }))
    };
}

async function listPresentations(user, options = {}) {
    const tenant = await assertTenantContext(user);
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 100));
    const search = String(options.search || '').trim().slice(0, 160);
    const templateId = String(options.templateId || options.template_id || '').trim().slice(0, 96);
    const status = ['draft', 'needs_attention', 'ready', 'archived'].includes(String(options.status)) ? String(options.status) : '';
    const tag = String(options.tag || '').trim().slice(0, 32);
    const favoriteOnly = options.favorite === true || String(options.favorite || '') === 'true';
    const conditions = ['d.tenant_id = ?', 'd.deleted_at IS NULL', '(d.owner_user_id = ? OR pc.user_id IS NOT NULL)'];
    const params = [tenant.tenantId, user.id];
    if (search) { const escaped = search.replace(/[%_\\]/g, char => '\\' + char); const like = '%' + escaped + '%'; conditions.push('(d.title ILIKE ? OR pv.content_json ILIKE ?)'); params.push(like, like); }
    if (templateId) { conditions.push('d.template_id = ?'); params.push(templateId); }
    if (status) { conditions.push('d.status = ?'); params.push(status); }
    if (tag) { conditions.push('d.tags_json LIKE ?'); params.push('%' + tag.replace(/[\%_]/g, '\$&') + '%'); }
    if (favoriteOnly) conditions.push('pf.presentation_id IS NOT NULL');
    const rows = await query(`
        SELECT d.*, pc.role AS collaborator_role, (d.owner_user_id = ?) AS is_owner,
               CASE WHEN pf.presentation_id IS NULL THEN false ELSE true END AS favorite
        FROM presentation_documents d
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
    return row ? toPublicPresentation(row, { includeContent: true }) : null;
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
    const template = await resolveTemplateForUser(user, body.templateId || 'business-blue');
    if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    const title = normalizeTitle(body.title || artifact.title || '智能体产物演示文稿'); const text = plainTextFromArtifact(artifact.content);
    if (!text) throw publicError('智能体产物没有可转换的文本内容。', 422, 'PRESENTATION_ARTIFACT_EMPTY');
    const content = presentationFromArtifactText({ title, template, text, artifactId: artifact.id });
    return await createPresentation(user, { title, templateId: template.id, content, tags: normalizeTags(body.tags || ['Agent产物']) });
}

async function createPresentation(user, body = {}) {
    const tenant = await assertTenantContext(user);
    const clientId = body.id ? normalizeClientId(body.id) : newClientId();
    const title = normalizeTitle(body.title);
    const template = await resolveTemplateForUser(user, body.templateId || body.template?.id || 'business-blue');
    if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    let content = body.content ? normalizePresentation({ ...body.content, presentationId: clientId, title, template: { id: template.id, version: template.version, snapshotDigest: template.snapshotDigest }, theme: body.content.theme || template.definition.theme }) : defaultPresentation({ presentationId: clientId, title, template, aspectRatio: body.aspectRatio || template.aspectRatio });
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
    if (body.templateId !== undefined && String(body.templateId).trim() !== String(current.template_id)) {
        const template = await resolveTemplateForUser(user, body.templateId);
        if (!template) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
        templateId = template.id;
        templateVersion = template.version;
        templateDigest = template.snapshotDigest;
    }
    const activeTemplate = await resolveTemplateForUser(user, templateId);
    if (!activeTemplate) throw publicError('所选模板不存在或无权使用。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    let content = normalizePresentation({ ...(body.content || {}), presentationId: current.client_id, title, template: { id: templateId, version: templateVersion, snapshotDigest: templateDigest } });
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
        const template = await resolveTemplateForUser(user, body.templateId);
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

async function uploadPresentationAsset(user, file, options = {}) {
    if (!file?.buffer || !Buffer.isBuffer(file.buffer)) throw publicError('请选择图片素材。', 400, 'PRESENTATION_ASSET_REQUIRED');
    const mimeType = String(file.mimetype || '').toLowerCase();
    const requestedType = String(options.assetType || options.asset_type || '').toLowerCase();
    const inferredType = inferPresentationAssetType(file);
    const assetType = requestedType || inferredType;
    if (!assetType || assetType !== inferredType) throw publicError('素材类型或 MIME 不受支持。', 400, 'PRESENTATION_ASSET_TYPE_INVALID');
    if (isVbaFilename(file.originalname)) { const scan = scanVbaSource(file.buffer, file.originalname); if (!scan.allowed) throw publicError('宏/VBA 静态扫描未通过：' + scan.warnings.join('；'), 400, scan.code || 'VBA_RISK_DETECTED'); }
    const maxBytes = assetType === 'video' ? 100 * 1024 * 1024 : assetType === 'audio' ? 30 * 1024 * 1024 : assetType === 'font' ? 25 * 1024 * 1024 : MAX_ASSET_BYTES;
    if (file.buffer.length > maxBytes) throw publicError('素材超过该类型允许的大小上限。', 413, 'PRESENTATION_ASSET_TOO_LARGE');
    const scope = normalizeAssetScope(options.scope);
    const departmentName = scope === 'department' ? normalizeDepartmentName(options.departmentName || options.department_name || user.unit) : '';
    if (scope !== 'private' && !isAdmin(user)) throw publicError('只有管理员可以上传组织或部门品牌素材。', 403, 'PRESENTATION_ASSET_SCOPE_FORBIDDEN');
    if (scope === 'department' && !departmentName) throw publicError('部门品牌素材必须指定部门。', 400, 'PRESENTATION_ASSET_DEPARTMENT_REQUIRED');
    const tenant = await assertTenantContext(user);
    const stored = await putBuffer({ buffer: file.buffer, mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'presentation_asset', retentionDays: 365 });
    await incrementRefCount(stored.objectId, 1);
    const row = await queryOne(`
        INSERT INTO presentation_assets (tenant_id, owner_user_id, object_id, filename, mime_type, byte_size, content_digest, asset_type, scope, department_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON CONFLICT (tenant_id, owner_user_id, object_id) DO UPDATE SET filename = EXCLUDED.filename, asset_type = EXCLUDED.asset_type, scope = EXCLUDED.scope, department_name = EXCLUDED.department_name
        RETURNING *
    `, [tenant.tenantId, user.id, stored.objectId, String(file.originalname || '图片素材').replace(/[\\/]/g, '_').slice(0, 240), mimeType, stored.byteSize, stored.contentDigest, assetType, scope, departmentName]);
    return { id: Number(row.id), ref: buildCasRef(stored.objectId), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), contentDigest: row.content_digest, assetType: row.asset_type || 'image', scope: row.scope, departmentName: row.department_name || '', createdAt: row.created_at };
}

async function findPresentationAssetForUser(user, objectId) {
    const tenant = await assertTenantContext(user);
    const access = assetAccessClause(user);
    const row = await queryOne(`
        SELECT * FROM presentation_assets
        WHERE object_id = ? AND tenant_id = ? AND deleted_at IS NULL AND ${access.sql}
        LIMIT 1
    `, [objectId, tenant.tenantId, ...access.params]);
    return { tenant, row };
}

async function publishPresentationAsset(user, ref, options = {}) {
    if (!isAdmin(user)) throw publicError('只有管理员可以发布品牌素材。', 403, 'PRESENTATION_ASSET_SCOPE_FORBIDDEN');
    const objectId = parseCasRef(ref);
    if (!objectId) throw publicError('品牌素材引用无效。', 400, 'PRESENTATION_ASSET_REF_INVALID');
    const scope = normalizeAssetScope(options.scope);
    if (scope === 'private') throw publicError('发布品牌素材时必须指定组织或部门范围。', 400, 'PRESENTATION_ASSET_SCOPE_REQUIRED');
    const departmentName = scope === 'department' ? normalizeDepartmentName(options.departmentName || options.department_name || user.unit) : '';
    if (scope === 'department' && !departmentName) throw publicError('部门品牌素材必须指定部门。', 400, 'PRESENTATION_ASSET_DEPARTMENT_REQUIRED');
    const tenant = await assertTenantContext(user);
    const row = await queryOne(`
        UPDATE presentation_assets
        SET scope = ?, department_name = ?
        WHERE tenant_id = ? AND owner_user_id = ? AND object_id = ? AND deleted_at IS NULL
        RETURNING *
    `, [scope, departmentName, tenant.tenantId, user.id, objectId]);
    if (!row) throw publicError('品牌素材不存在或无权发布。', 404, 'PRESENTATION_ASSET_NOT_FOUND');
    return { id: Number(row.id), ref: buildCasRef(row.object_id), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), assetType: row.asset_type || 'image', scope: row.scope, departmentName: row.department_name || '' };
}

async function findPresentationAssetForPresentation(user, objectId, presentationId = '') {
    const direct = await findPresentationAssetForUser(user, objectId);
    if (direct.row || !presentationId) return direct;
    const presentation = await getPresentationRow(user, presentationId, { includeContent: true });
    const trustedRefs = new Set(collectPresentationAssetRefs(parseJson(presentation?.content_json, {})));
    if (!presentation || !trustedRefs.has(buildCasRef(objectId))) return direct;
    const row = await queryOne('SELECT * FROM presentation_assets WHERE object_id = ? AND tenant_id = ? AND deleted_at IS NULL', [objectId, direct.tenant.tenantId]);
    return { ...direct, row };
}

async function listPresentationAssets(user, options = {}) {
    const tenant = await assertTenantContext(user);
    const access = assetAccessClause(user);
    const type = ['image', 'font', 'audio', 'video', 'attachment'].includes(String(options.type || options.assetType || '')) ? String(options.type || options.assetType) : '';
    const search = String(options.search || '').trim().slice(0, 120);
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 80, 200));
    const conditions = ['tenant_id = ?', 'deleted_at IS NULL', access.sql]; const params = [tenant.tenantId, ...access.params];
    if (type) { conditions.push('asset_type = ?'); params.push(type); }
    if (search) { conditions.push('filename ILIKE ?'); params.push('%' + search.replace(/[\%_]/g, '\async function getPresentationAsset(user, assetId) {') + '%'); }
    const rows = await query('SELECT * FROM presentation_assets WHERE ' + conditions.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT ?', [...params, limit]);
    return rows.map(row => ({ id: Number(row.id), ref: buildCasRef(row.object_id), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), assetType: row.asset_type || 'image', scope: row.scope, departmentName: row.department_name || '', createdAt: row.created_at }));
}

async function getPresentationAsset(user, assetId) {
    const tenant = await assertTenantContext(user);
    const access = assetAccessClause(user);
    const row = await queryOne(`
        SELECT * FROM presentation_assets
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND ${access.sql}
        LIMIT 1
    `, [Number.parseInt(assetId, 10), tenant.tenantId, ...access.params]);
    if (!row) return null;
    const loaded = await readBuffer({ objectId: row.object_id, tenantId: tenant.tenantId, tenantScoped: true });
    return { asset: { id: Number(row.id), ref: buildCasRef(row.object_id), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), scope: row.scope, departmentName: row.department_name || '' }, buffer: loaded.buffer };
}

async function getPresentationAssetByRef(user, ref, options = {}) {
    const objectId = parseCasRef(ref);
    if (!objectId) return null;
    const { tenant, row } = await findPresentationAssetForPresentation(user, objectId, options.presentationId || options.presentation_id);
    if (!row) return null;
    const loaded = await readBuffer({ objectId: row.object_id, tenantId: tenant.tenantId, tenantScoped: true });
    return { asset: { id: Number(row.id), ref: buildCasRef(row.object_id), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), scope: row.scope, departmentName: row.department_name || '' }, buffer: loaded.buffer };
}

async function resolvePresentationAssets(user, content, options = {}) {
    const tenant = await assertTenantContext(user);
    const assets = new Map();
    for (const ref of collectPresentationAssetRefs(content)) {
        const objectId = parseCasRef(ref);
        const { row: asset } = objectId ? await findPresentationAssetForPresentation(user, objectId, options.presentationId || options.presentation_id) : { row: null };
        const object = asset ? await statObject({ objectId: asset.object_id, tenantId: tenant.tenantId }) : null;
        if (!object) throw publicError('演示文稿引用的素材不存在或无权访问。', 403, 'PRESENTATION_ASSET_FORBIDDEN');
        const loaded = await readBuffer({ objectId: asset.object_id, tenantId: tenant.tenantId, tenantScoped: true });
        assets.set(ref, { buffer: loaded.buffer, mimeType: loaded.object.mime_type });
    }
    return assets;
}

/** 保存前只校验素材归属，不读取二进制内容，避免不可信 IR 留下跨账号 CAS 引用。 */
function expectedAssetTypes(content) {
    const expected = new Map();
    const add = (ref, type) => { if (ref) expected.set(ref, type); };
    (content.slides || []).forEach(slide => {
        add(slide.background?.imageAssetRef, 'image');
        (slide.elements || []).forEach(element => {
            if (element.type === 'image') add(element.assetRef, 'image');
            if (element.type === 'media') { add(element.assetRef, element.mediaType); add(element.posterAssetRef, 'image'); }
            if (element.type === 'attachment') add(element.assetRef, 'attachment');
        });
        add(content.theme?.fontAssets?.heading, 'font');
        add(content.theme?.fontAssets?.body, 'font');
        add(content.metadata?.coverAssetRef, 'image');
    });
    return expected;
}

/** 保存前校验素材归属和类型，防止不可信 IR 将任意 CAS 内容伪装成图片或媒体。 */
async function assertPresentationAssetOwnership(user, content, options = {}) {
    const tenant = await assertTenantContext(user);
    const trustedRefs = new Set(options.trustedRefs || []);
    for (const [ref, expectedType] of expectedAssetTypes(content)) {
        const objectId = parseCasRef(ref); const access = assetAccessClause(user);
        const asset = objectId ? (trustedRefs.has(ref) ? await queryOne('SELECT asset_type FROM presentation_assets WHERE tenant_id = ? AND object_id = ? AND deleted_at IS NULL', [tenant.tenantId, objectId]) : await queryOne(`
            SELECT asset_type FROM presentation_assets
            WHERE tenant_id = ? AND object_id = ? AND deleted_at IS NULL AND ${access.sql}
        `, [tenant.tenantId, objectId, ...access.params])) : null;
        if (!asset) throw publicError('演示文稿引用了不存在或无权访问的素材。', 403, 'PRESENTATION_ASSET_FORBIDDEN');
        if (String(asset.asset_type || 'image') !== expectedType) throw publicError('素材类型与页面元素不匹配。', 400, 'PRESENTATION_ASSET_TYPE_MISMATCH');
    }
}

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
    getPresentationAsset,
    listPresentationAssets,
    publishPresentationAsset,
    inferPresentationAssetType,
    getPresentationAssetByRef,
    getPresentationVersion,
    listPresentationCollaborators,
    listPresentationComments,
    listPresentationExports,
    listPresentationTemplates,
    listPresentationVersions,
    listPresentations,
    importPresentationTemplate,
    importPresentationTemplateFile,
    normalizeTemplatePackage,
    removePresentationCollaborator,
    resolvePresentationComment,
    rollbackPresentation,
    savePresentationContent,
    updatePresentationMetadata,
    updatePresentationTemplate,
    uploadPresentationAsset
};
