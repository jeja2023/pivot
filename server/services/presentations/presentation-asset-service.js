'use strict';

/** 演示素材的 CAS、访问范围和文稿引用校验。 */
const sharp = require('sharp');
const { readTypedEnv } = require('../../config/env-registry');
const { isAdmin } = require('../../permissions');
const { isVbaFilename, scanVbaSource } = require('./presentation-vba');

const MAX_ASSET_BYTES = readTypedEnv('PIVOT_PRESENTATION_ASSET_MAX_BYTES');
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const FONT_MIME_TYPES = new Set(['font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/font-sfnt', 'application/vnd.ms-fontobject']);
const AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac']);
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const ATTACHMENT_MIME_TYPES = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain', 'text/markdown', 'application/vnd.ms-powerpoint.presentation.macroenabled.12', 'application/vnd.ms-powerpoint.slideshow.macroenabled.12']);

function createPresentationAssetService(deps) {
    const {
        publicError, normalizeDepartmentName, normalizeAssetScope, assetAccessClause, parseJson,
        assertTenantContext, query, queryOne, readBuffer, statObject, putBuffer, incrementRefCount,
        buildCasRef, parseCasRef, getPresentationRow, collectPresentationAssetRefs
    } = deps;

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

    async function inspectPresentationImageMetadata(file, assetType) {
        if (assetType !== 'image') return { pixelWidth: 0, pixelHeight: 0 };
        try {
            const metadata = await sharp(file.buffer, { animated: false, limitInputPixels: 48_000_000 }).metadata();
            return { pixelWidth: Math.max(0, Number(metadata.width) || 0), pixelHeight: Math.max(0, Number(metadata.height) || 0) };
        } catch (_) {
            return { pixelWidth: 0, pixelHeight: 0 };
        }
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
        const tenant = await assertTenantContext(user); const dimensions = await inspectPresentationImageMetadata(file, assetType);
        const stored = await putBuffer({ buffer: file.buffer, mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'presentation_asset', retentionDays: 365 });
        await incrementRefCount(stored.objectId, 1);
        const row = await queryOne(`
            INSERT INTO presentation_assets (tenant_id, owner_user_id, object_id, filename, mime_type, byte_size, content_digest, asset_type, scope, department_name, pixel_width, pixel_height, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            ON CONFLICT (tenant_id, owner_user_id, object_id) DO UPDATE SET filename = EXCLUDED.filename, asset_type = EXCLUDED.asset_type, scope = EXCLUDED.scope, department_name = EXCLUDED.department_name, pixel_width = EXCLUDED.pixel_width, pixel_height = EXCLUDED.pixel_height
            RETURNING *
        `, [tenant.tenantId, user.id, stored.objectId, String(file.originalname || '图片素材').replace(/[\\/]/g, '_').slice(0, 240), mimeType, stored.byteSize, stored.contentDigest, assetType, scope, departmentName, dimensions.pixelWidth, dimensions.pixelHeight]);
        return { id: Number(row.id), ref: buildCasRef(stored.objectId), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), contentDigest: row.content_digest, assetType: row.asset_type || 'image', scope: row.scope, departmentName: row.department_name || '', pixelWidth: Number(row.pixel_width || 0), pixelHeight: Number(row.pixel_height || 0), createdAt: row.created_at };
    }

    async function findPresentationAssetForUser(user, objectId) {
        const tenant = await assertTenantContext(user); const access = assetAccessClause(user);
        const row = await queryOne(`SELECT * FROM presentation_assets WHERE object_id = ? AND tenant_id = ? AND deleted_at IS NULL AND ${access.sql} LIMIT 1`, [objectId, tenant.tenantId, ...access.params]);
        return { tenant, row };
    }

    async function publishPresentationAsset(user, ref, options = {}) {
        if (!isAdmin(user)) throw publicError('只有管理员可以发布品牌素材。', 403, 'PRESENTATION_ASSET_SCOPE_FORBIDDEN');
        const objectId = parseCasRef(ref); if (!objectId) throw publicError('品牌素材引用无效。', 400, 'PRESENTATION_ASSET_REF_INVALID');
        const scope = normalizeAssetScope(options.scope); if (scope === 'private') throw publicError('发布品牌素材时必须指定组织或部门范围。', 400, 'PRESENTATION_ASSET_SCOPE_REQUIRED');
        const departmentName = scope === 'department' ? normalizeDepartmentName(options.departmentName || options.department_name || user.unit) : '';
        if (scope === 'department' && !departmentName) throw publicError('部门品牌素材必须指定部门。', 400, 'PRESENTATION_ASSET_DEPARTMENT_REQUIRED');
        const tenant = await assertTenantContext(user);
        const row = await queryOne('UPDATE presentation_assets SET scope = ?, department_name = ? WHERE tenant_id = ? AND owner_user_id = ? AND object_id = ? AND deleted_at IS NULL RETURNING *', [scope, departmentName, tenant.tenantId, user.id, objectId]);
        if (!row) throw publicError('品牌素材不存在或无权发布。', 404, 'PRESENTATION_ASSET_NOT_FOUND');
        return { id: Number(row.id), ref: buildCasRef(row.object_id), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), assetType: row.asset_type || 'image', scope: row.scope, departmentName: row.department_name || '' };
    }

    async function findPresentationAssetForPresentation(user, objectId, presentationId = '') {
        const direct = await findPresentationAssetForUser(user, objectId); if (direct.row || !presentationId) return direct;
        const presentation = await getPresentationRow(user, presentationId, { includeContent: true });
        const trustedRefs = new Set(collectPresentationAssetRefs(parseJson(presentation?.content_json, {})));
        if (!presentation || !trustedRefs.has(buildCasRef(objectId))) return direct;
        const row = await queryOne('SELECT * FROM presentation_assets WHERE object_id = ? AND tenant_id = ? AND deleted_at IS NULL', [objectId, direct.tenant.tenantId]);
        return { ...direct, row };
    }

    function publicAsset(row) {
        return { id: Number(row.id), ref: buildCasRef(row.object_id), filename: row.filename, mimeType: row.mime_type, byteSize: Number(row.byte_size), assetType: row.asset_type || 'image', scope: row.scope, departmentName: row.department_name || '', pixelWidth: Number(row.pixel_width || 0), pixelHeight: Number(row.pixel_height || 0), createdAt: row.created_at };
    }

    async function listPresentationAssets(user, options = {}) {
        const tenant = await assertTenantContext(user); const access = assetAccessClause(user);
        const type = ['image', 'font', 'audio', 'video', 'attachment'].includes(String(options.type || options.assetType || '')) ? String(options.type || options.assetType) : '';
        const search = String(options.search || '').trim().slice(0, 120); const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 80, 200));
        const conditions = ['tenant_id = ?', 'deleted_at IS NULL', access.sql]; const params = [tenant.tenantId, ...access.params];
        if (type) { conditions.push('asset_type = ?'); params.push(type); }
        if (search) { const escaped = search.replace(/[\\%_]/g, char => '\\' + char); conditions.push("filename ILIKE ? ESCAPE '\\'"); params.push('%' + escaped + '%'); }
        return (await query('SELECT * FROM presentation_assets WHERE ' + conditions.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT ?', [...params, limit])).map(publicAsset);
    }

    async function getPresentationAsset(user, assetId) {
        const tenant = await assertTenantContext(user); const access = assetAccessClause(user);
        const row = await queryOne(`SELECT * FROM presentation_assets WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND ${access.sql} LIMIT 1`, [Number.parseInt(assetId, 10), tenant.tenantId, ...access.params]);
        if (!row) return null; const loaded = await readBuffer({ objectId: row.object_id, tenantId: tenant.tenantId, tenantScoped: true });
        return { asset: publicAsset(row), buffer: loaded.buffer };
    }

    async function getPresentationAssetByRef(user, ref, options = {}) {
        const objectId = parseCasRef(ref); if (!objectId) return null;
        const { tenant, row } = await findPresentationAssetForPresentation(user, objectId, options.presentationId || options.presentation_id);
        if (!row) return null; const loaded = await readBuffer({ objectId: row.object_id, tenantId: tenant.tenantId, tenantScoped: true });
        return { asset: publicAsset(row), buffer: loaded.buffer };
    }

    async function resolvePresentationAssets(user, content, options = {}) {
        const tenant = await assertTenantContext(user); const assets = new Map();
        for (const ref of collectPresentationAssetRefs(content)) {
            const objectId = parseCasRef(ref); const { row: asset } = objectId ? await findPresentationAssetForPresentation(user, objectId, options.presentationId || options.presentation_id) : { row: null };
            const object = asset ? await statObject({ objectId: asset.object_id, tenantId: tenant.tenantId }) : null;
            if (!object) throw publicError('演示文稿引用的素材不存在或无权访问。', 403, 'PRESENTATION_ASSET_FORBIDDEN');
            const loaded = await readBuffer({ objectId: asset.object_id, tenantId: tenant.tenantId, tenantScoped: true }); assets.set(ref, { buffer: loaded.buffer, mimeType: loaded.object.mime_type });
        }
        return assets;
    }

    function expectedAssetTypes(content) {
        const expected = new Map(); const add = (ref, type) => { if (ref) expected.set(ref, type); };
        (content.slides || []).forEach(slide => {
            add(slide.background?.imageAssetRef, 'image');
            (slide.elements || []).forEach(element => { if (element.type === 'image') add(element.assetRef, 'image'); if (element.type === 'media') { add(element.assetRef, element.mediaType); add(element.posterAssetRef, 'image'); } if (element.type === 'attachment') add(element.assetRef, 'attachment'); });
            add(content.theme?.fontAssets?.heading, 'font'); add(content.theme?.fontAssets?.body, 'font'); add(content.metadata?.coverAssetRef, 'image');
        });
        return expected;
    }

    async function assertPresentationAssetOwnership(user, content, options = {}) {
        const tenant = await assertTenantContext(user); const trustedRefs = new Set(options.trustedRefs || []);
        for (const [ref, expectedType] of expectedAssetTypes(content)) {
            const objectId = parseCasRef(ref); const access = assetAccessClause(user);
            const asset = objectId ? (trustedRefs.has(ref) ? await queryOne('SELECT asset_type FROM presentation_assets WHERE tenant_id = ? AND object_id = ? AND deleted_at IS NULL', [tenant.tenantId, objectId]) : await queryOne(`SELECT asset_type FROM presentation_assets WHERE tenant_id = ? AND object_id = ? AND deleted_at IS NULL AND ${access.sql}`, [tenant.tenantId, objectId, ...access.params])) : null;
            if (!asset) throw publicError('演示文稿引用了不存在或无权访问的素材。', 403, 'PRESENTATION_ASSET_FORBIDDEN');
            if (String(asset.asset_type || 'image') !== expectedType) throw publicError('素材类型与页面元素不匹配。', 400, 'PRESENTATION_ASSET_TYPE_MISMATCH');
        }
    }

    return { inferPresentationAssetType, uploadPresentationAsset, findPresentationAssetForUser, publishPresentationAsset, findPresentationAssetForPresentation, listPresentationAssets, getPresentationAsset, getPresentationAssetByRef, resolvePresentationAssets, assertPresentationAssetOwnership };
}

module.exports = { createPresentationAssetService };
