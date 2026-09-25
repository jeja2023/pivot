'use strict';

/** 模板定义、版本快照、审核、导入任务与源文件审计。 */
function createPresentationTemplateService(deps) {
    const {
        crypto, path, Worker, query, queryOne, execute, getBeijingTimestamp,
        assertTenantContext, buildCasRef, incrementRefCount, parseCasRef, putBuffer, readBuffer,
        isAdmin, getBuiltInTemplate, listBuiltInTemplates,
        defaultPresentation, normalizePresentation, publicError, normalizeClientId,
        normalizeTitle, normalizeDepartmentName, parseJson, serializeJson, findPresentationAssetForUser,
        uploadPresentationAsset
    } = deps;
    const MAX_TEMPLATE_NAME_LENGTH = 120;
    const MAX_TEMPLATE_PACKAGE_BYTES = 2 * 1024 * 1024;
    const PPTX_TEMPLATE_PARSE_TIMEOUT_MS = 30_000;
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
    output.sourceAvailable = Boolean(parseCasRef(definition?.importMetadata?.sourceRef || ''));
    if (includeDefinition) output.definition = definition;
    output.importReport = Array.isArray(definition?.importMetadata?.report) ? definition.importMetadata.report : [];
    return output;
}

function templateVersionToPublic(templateRow, versionRow, { includeDefinition = true } = {}) {
    if (!templateRow || !versionRow) return null;
    const definition = parseJson(versionRow.definition_json, {});
    const output = toPublicTemplate({ ...templateRow, version: versionRow.version, snapshot_digest: versionRow.snapshot_digest, definition_json: versionRow.definition_json }, { includeDefinition });
    output.sourceFormat = String(versionRow.source_format || definition?.importMetadata?.sourceFormat || 'pivot');
    output.importReport = parseJson(versionRow.import_report_json, output.importReport || []);
    output.sourceAvailable = Boolean(versionRow.source_object_id);
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

async function resolveTemplateVersionForUser(user, templateId, version, { includeDefinition = true, historical = false } = {}) {
    const id = String(templateId || 'business-blue').trim() || 'business-blue';
    const builtIn = getBuiltInTemplate(id);
    if (builtIn) return Number(version || 1) === Number(builtIn.version) ? systemTemplateToPublic(builtIn) : null;
    const requestedVersion = Number.parseInt(version, 10);
    if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) return null;
    const tenant = await assertTenantContext(user);
    const row = await queryOne(`
        SELECT t.*, tv.version AS snapshot_version, tv.definition_json AS snapshot_definition_json,
               tv.snapshot_digest AS snapshot_snapshot_digest, tv.source_format, tv.source_object_id, tv.import_options_json, tv.import_report_json
        FROM presentation_templates t
        JOIN presentation_template_versions tv ON tv.template_id = t.id AND tv.version = ?
        WHERE t.client_id = ? AND t.tenant_id = ? AND t.deleted_at IS NULL
          AND (? = true OR (
              t.owner_user_id = ?
              OR (t.scope IN ('organization', 'published') AND t.status IN ('published', 'unpublished'))
              OR (t.scope = 'department' AND t.status IN ('published', 'unpublished') AND t.department_name = ?)
          ))
        LIMIT 1
    `, [requestedVersion, id, tenant.tenantId, historical, user.id, normalizeDepartmentName(user.unit)]);
    if (!row) return null;
    return templateVersionToPublic(row, {
        version: row.snapshot_version,
        definition_json: row.snapshot_definition_json,
        snapshot_digest: row.snapshot_snapshot_digest,
        source_format: row.source_format,
        source_object_id: row.source_object_id,
        import_options_json: row.import_options_json,
        import_report_json: row.import_report_json
    }, { includeDefinition });
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

function layoutForSlide(template, slide) {
    const layouts = Array.isArray(template?.definition?.layouts) ? template.definition.layouts : (Array.isArray(template?.layouts) ? template.layouts : []);
    const requested = String(slide?.layoutId || '').trim();
    return layouts.find(layout => layout.id === requested)
        || layouts.find(layout => layout.legacyLayoutId === requested)
        || layouts.find(layout => slide?.type === 'cover' && (layout.legacyLayoutId === 'cover' || /封面|cover/i.test(layout.name)))
        || layouts[0]
        || null;
}

function templateLayerElements(template, layout, slideIndex) {
    const masters = Array.isArray(template?.definition?.masters) ? template.definition.masters : [];
    const master = masters.find(item => item.id === layout?.masterId) || null;
    const source = [...(master?.decorations || []), ...(layout?.decorations || [])];
    return source.map((element, index) => ({
        ...JSON.parse(JSON.stringify(element)),
        id: `pivotTemplate_${String(master?.id || 'default').replace(/[^A-Za-z0-9_-]/g, '_')}_${String(layout?.id || 'layout').replace(/[^A-Za-z0-9_-]/g, '_')}_${slideIndex + 1}_${index + 1}`,
        locked: element.locked !== false,
        visible: element.visible !== false,
        sourceRefs: []
    }));
}

function slotForTextElement(element, placeholders, used) {
    const text = String(element?.content?.text || '');
    const role = element?.id === 'title' || Number(element?.style?.fontSize || 0) >= 28 ? 'title' : /副标题|subtitle/i.test(text) ? 'subtitle' : 'body';
    return placeholders.find(slot => slot.kind === 'text' && !used.has(slot.id) && slot.role === role)
        || placeholders.find(slot => slot.kind === 'text' && !used.has(slot.id));
}

function applyTemplateLayoutLayers(content, template, { reflow = false } = {}) {
    const definition = template?.definition || template || {};
    if (!Array.isArray(definition.masters) || !definition.masters.length) return content;
    const theme = definition.theme || content.theme || {};
    const slides = (content.slides || []).map((slide, slideIndex) => {
        const layout = layoutForSlide(template, slide);
        if (!layout) return slide;
        const master = definition.masters.find(item => item.id === layout.masterId) || null;
        const elements = (slide.elements || []).filter(element => !String(element.id || '').startsWith('pivotTemplate_')).map(element => JSON.parse(JSON.stringify(element)));
        if (reflow) {
            const used = new Set();
            elements.forEach(element => {
                if (element.type !== 'text') return;
                const slot = slotForTextElement(element, layout.placeholders || [], used);
                if (!slot) return;
                used.add(slot.id);
                element.x = slot.x; element.y = slot.y; element.width = slot.width; element.height = slot.height; element.rotation = slot.rotation || 0;
                if (slot.style && Object.keys(slot.style).length) element.style = { ...element.style, ...slot.style };
                if (layout.slotAnimations?.[slot.role]) element.animation = { ...layout.slotAnimations[slot.role] };
            });
        }
        const background = master?.background ? {
            fill: master.background.fill || slide.background?.fill || theme.colors?.background || '#FFFFFF',
            imageAssetRef: master.background.imageAssetRef || '',
            opacity: master.background.opacity === undefined ? 1 : master.background.opacity
        } : slide.background;
        return { ...slide, layoutId: layout.id, background, transition: layout.defaultTransition?.type !== 'none' ? { ...layout.defaultTransition } : slide.transition, elements: [...templateLayerElements(template, layout, slideIndex), ...elements] };
    });
    return normalizePresentation({ ...content, theme: { ...content.theme, ...theme, colors: { ...(content.theme?.colors || {}), ...(theme.colors || {}) }, fonts: { ...(content.theme?.fonts || {}), ...(theme.fonts || {}) } }, slides });
}

async function assertBrandControlAssetAccess(user, definition) {
    const refs = collectTemplateAssetRefs(definition);
    for (const ref of refs) {
        const objectId = parseCasRef(ref);
        const found = objectId ? await findPresentationAssetForUser(user, objectId) : null;
        if (!found?.row) throw publicError('模板引用的素材不存在或无权访问。', 403, 'PRESENTATION_TEMPLATE_ASSET_FORBIDDEN');
    }
}

function normalizeTemplateAssetRef(value, label) {
    const ref = String(value || '').trim();
    if (ref && !parseCasRef(ref)) throw publicError(`${label}必须引用受控素材。`, 400, 'PRESENTATION_TEMPLATE_ASSET_INVALID');
    return ref;
}

function normalizeTemplateBounds(input, aspectRatio, label) {
    const ratio = aspectRatio === '4:3' ? '4:3' : '16:9';
    const canvas = ratio === '4:3' ? { width: 960, height: 720 } : { width: 1280, height: 720 };
    const candidate = {
        id: 'templateBounds', type: 'shape', x: input?.x, y: input?.y, width: input?.width, height: input?.height,
        rotation: input?.rotation, zIndex: 1, locked: true, visible: true, sourceRefs: [], shapeType: 'rect', style: { fill: '#FFFFFF', stroke: '#FFFFFF', strokeWidth: 1, opacity: 1, radius: 0 }
    };
    try {
        const normalized = normalizePresentation({ title: '模板边界校验', aspectRatio: ratio, slides: [{ id: 'templateBoundsSlide', layoutId: 'title-content', background: { fill: '#FFFFFF' }, elements: [candidate], sourceRefs: [] }] });
        const element = normalized.slides[0].elements[0];
        return { x: element.x, y: element.y, width: element.width, height: element.height, rotation: element.rotation, canvas };
    } catch (_) {
        throw publicError(`${label}超出页面边界或格式无效。`, 400, 'PRESENTATION_TEMPLATE_BOUNDS_INVALID');
    }
}

function normalizeTemplateDecorations(value, aspectRatio, theme, label) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 80) throw publicError(`${label}数量无效。`, 400, 'PRESENTATION_TEMPLATE_DECORATIONS_INVALID');
    return value.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw publicError(`${label}包含无效对象。`, 400, 'PRESENTATION_TEMPLATE_DECORATION_INVALID');
        const normalized = normalizePresentation({
            title: '模板装饰校验', aspectRatio,
            theme,
            slides: [{ id: 'templateDecorationSlide', layoutId: 'title-content', background: { fill: '#FFFFFF' }, elements: [{ ...item, id: `templateDecoration_${index + 1}`, locked: true, visible: item.visible !== false, sourceRefs: [] }], sourceRefs: [] }]
        }).slides[0].elements[0];
        return { ...normalized, id: `templateDecoration_${index + 1}`, locked: true, sourceRefs: [] };
    });
}

function normalizeTemplatePlaceholders(value, aspectRatio, theme, layoutId) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 30) throw publicError('模板占位符数量无效。', 400, 'PRESENTATION_TEMPLATE_PLACEHOLDERS_INVALID');
    const ids = new Set();
    return value.map((item, index) => {
        const source = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
        if (!source) throw publicError('模板占位符必须是对象。', 400, 'PRESENTATION_TEMPLATE_PLACEHOLDER_INVALID');
        const id = normalizeClientId(source.id || `slot_${index + 1}`);
        if (ids.has(id)) throw publicError('同一布局中不能有重复占位符标识。', 400, 'PRESENTATION_TEMPLATE_PLACEHOLDER_DUPLICATE');
        ids.add(id);
        const role = String(source.role || 'body').trim().slice(0, 64) || 'body';
        const kind = ['text', 'image', 'chart', 'table'].includes(String(source.kind || 'text')) ? String(source.kind || 'text') : 'text';
        const bounds = normalizeTemplateBounds(source, aspectRatio, `布局 ${layoutId} 的占位符`);
        let style = {};
        if (kind === 'text') {
            style = normalizePresentation({
                title: '模板文本样式校验', aspectRatio, theme,
                slides: [{ id: 'templateStyleSlide', layoutId: 'title-content', background: { fill: '#FFFFFF' }, elements: [{ id: 'templateStyleText', type: 'text', ...bounds, zIndex: 1, locked: false, visible: true, sourceRefs: [], content: { text: '' }, style: source.style || {} }], sourceRefs: [] }]
            }).slides[0].elements[0].style;
        }
        return {
            id, role, kind, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, rotation: bounds.rotation, style,
            required: source.required === true || role === 'title',
            constraints: {
                maxLines: Math.max(1, Math.min(40, Number.parseInt(source.constraints?.maxLines, 10) || (role === 'title' ? 2 : 12))),
                overflow: ['shrink-or-split', 'shrink', 'split'].includes(String(source.constraints?.overflow || 'shrink-or-split')) ? String(source.constraints?.overflow || 'shrink-or-split') : 'shrink-or-split'
            }
        };
    });
}

function normalizeTemplateAnimation(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const type = ['none', 'fade', 'zoom', 'wipe', 'fly'].includes(String(source.type || 'none')) ? String(source.type || 'none') : 'none';
    return {
        type,
        durationMs: type === 'none' ? 0 : Math.max(100, Math.min(10000, Number.parseInt(source.durationMs || source.duration_ms, 10) || 500)),
        delayMs: type === 'none' ? 0 : Math.max(0, Math.min(10000, Number.parseInt(source.delayMs || source.delay_ms, 10) || 0)),
        direction: String(source.direction || '').slice(0, 24)
    };
}

function normalizeTemplateTransition(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const type = ['none', 'fade', 'push', 'wipe', 'split', 'cover', 'uncover'].includes(String(source.type || 'none')) ? String(source.type || 'none') : 'none';
    return { type, durationMs: type === 'none' ? 0 : Math.max(100, Math.min(10000, Number.parseInt(source.durationMs || source.duration_ms, 10) || 500)), direction: String(source.direction || '').slice(0, 24) };
}

function normalizeTemplateBackground(value, theme) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const fill = String(source.fill || theme.colors?.background || '#FFFFFF').trim();
    const normalized = normalizePresentation({ title: '模板背景校验', theme, slides: [{ id: 'templateBackgroundSlide', layoutId: 'title-content', background: { fill, imageAssetRef: normalizeTemplateAssetRef(source.imageAssetRef || source.image_asset_ref, '模板背景图片'), opacity: source.opacity }, elements: [], sourceRefs: [] }] });
    return normalized.slides[0].background;
}

function collectTemplateAssetRefs(definition) {
    const refs = new Set();
    const add = value => { const ref = String(value || '').trim(); if (ref) refs.add(ref); };
    add(definition?.brandControls?.logoAssetRef);
    add(definition?.theme?.fontAssets?.heading); add(definition?.theme?.fontAssets?.body);
    (definition?.masters || []).forEach(master => {
        add(master?.background?.imageAssetRef);
        (master?.decorations || []).forEach(element => { if (element?.type === 'image') add(element.assetRef); if (element?.type === 'media') { add(element.assetRef); add(element.posterAssetRef); } });
    });
    (definition?.layouts || []).forEach(layout => (layout?.decorations || []).forEach(element => { if (element?.type === 'image') add(element.assetRef); if (element?.type === 'media') { add(element.assetRef); add(element.posterAssetRef); } }));
    return [...refs];
}

function templateColorLuminance(color) {
    const hex = String(color || '').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return 0;
    const channels = [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
        .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function templateContrastRatio(foreground, background) {
    const first = templateColorLuminance(foreground); const second = templateColorLuminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

async function assertTemplatePublishable(user, definition) {
    await assertBrandControlAssetAccess(user, definition);
    const blocking = Array.isArray(definition?.importMetadata?.report)
        ? definition.importMetadata.report.filter(item => item?.severity === 'blocking').map(item => String(item.message || '导入报告包含阻断项。'))
        : [];
    if (!Array.isArray(definition?.layouts) || !definition.layouts.length) blocking.push('模板没有可用布局。');
    const v2 = definition?.schemaVersion === '2.0';
    if (v2 && (!Array.isArray(definition?.masters) || !definition.masters.length)) blocking.push('模板 v2 缺少母版定义。');
    if (v2 && definition.layouts.some(layout => !layout.masterId || !(definition.masters || []).some(master => master.id === layout.masterId))) blocking.push('模板存在未关联母版的布局。');
    const theme = definition?.theme || {};
    const backgrounds = [...(definition?.masters || []).map(master => master.background?.fill), theme.colors?.background].filter(Boolean);
    if (backgrounds.some(background => templateContrastRatio(theme.colors?.text, background) < 3)) blocking.push('模板正文色与背景色对比度不足，无法通过发布检查。');
    if (blocking.length) throw publicError('模板发布前检查未通过：' + blocking.slice(0, 5).join('；'), 422, 'PRESENTATION_TEMPLATE_PREFLIGHT_FAILED');
}

function normalizeTemplateDefinition(body = {}) {
    const template = body.definition && typeof body.definition === 'object' ? body.definition : body;
    const theme = template.theme && typeof template.theme === 'object' ? template.theme : {};
    const aspectRatio = body.aspectRatio === '4:3' || template.aspectRatio === '4:3' ? '4:3' : '16:9';
    // 利用演示文稿校验器统一归一化主题，避免模板和文稿对颜色/字体有两套语义。
    const normalized = normalizePresentation(defaultPresentation({
        title: '模板校验',
        template: { id: 'template-check', version: 1, snapshotDigest: '' },
        aspectRatio
    }));
    const withTheme = normalizePresentation({ ...normalized, theme: { ...normalized.theme, ...theme, colors: { ...normalized.theme.colors, ...(theme.colors || {}) }, fonts: { ...normalized.theme.fonts, ...(theme.fonts || {}) } } });
    const masters = Array.isArray(template.masters) ? template.masters.slice(0, 20).map((master, index) => {
        const source = master && typeof master === 'object' && !Array.isArray(master) ? master : {};
        const id = normalizeClientId(source.id || `master_${index + 1}`);
        return {
            id,
            name: String(source.name || `母版 ${index + 1}`).trim().slice(0, 120) || `母版 ${index + 1}`,
            background: normalizeTemplateBackground(source.background, withTheme.theme),
            decorations: normalizeTemplateDecorations(source.decorations, aspectRatio, withTheme.theme, `母版 ${id} 的装饰元素`)
        };
    }) : [];
    const masterIds = new Set(masters.map(master => master.id));
    if (masterIds.size !== masters.length) throw publicError('模板不能包含重复母版标识。', 400, 'PRESENTATION_TEMPLATE_MASTER_DUPLICATE');
    const layouts = Array.isArray(template.layouts) ? template.layouts.slice(0, 30).map(layout => {
        const id = normalizeClientId(layout?.id);
        const masterId = String(layout?.masterId || layout?.master_id || (masters.length === 1 ? masters[0].id : '')).trim();
        if (masterId && !masterIds.has(masterId)) throw publicError(`布局 ${id} 引用了不存在的母版。`, 400, 'PRESENTATION_TEMPLATE_MASTER_NOT_FOUND');
        const placeholders = normalizeTemplatePlaceholders(layout?.placeholders, aspectRatio, withTheme.theme, id);
        const rawSlots = Array.isArray(layout?.slots) ? layout.slots.slice(0, 20).map(slot => String(slot).trim().slice(0, 64)).filter(Boolean) : [];
        const slots = [...new Set(placeholders.map(item => item.role).concat(rawSlots))].slice(0, 20);
        return {
            id,
            name: String(layout?.name || '').trim().slice(0, 120) || '未命名布局',
            category: String(layout?.category || '内容').trim().slice(0, 60) || '内容',
            slots,
            legacyLayoutId: String(layout?.legacyLayoutId || layout?.legacy_layout_id || '').trim().slice(0, 96),
            masterId,
            placeholders,
            decorations: normalizeTemplateDecorations(layout?.decorations, aspectRatio, withTheme.theme, `布局 ${id} 的装饰元素`),
            defaultTransition: normalizeTemplateTransition(layout?.defaultTransition || layout?.default_transition),
            slotAnimations: Object.fromEntries(Object.entries(layout?.slotAnimations || layout?.slot_animations || {}).slice(0, 20).map(([role, animation]) => [String(role).slice(0, 64), normalizeTemplateAnimation(animation)]).filter(([role, animation]) => role && animation.type !== 'none'))
        };
    }) : [];
    if (!layouts.length) throw publicError('模板至少需要一个布局。', 400, 'PRESENTATION_TEMPLATE_LAYOUT_REQUIRED');
    const layoutIds = new Set(layouts.map(layout => layout.id));
    if (layoutIds.size !== layouts.length) throw publicError('模板不能包含重复布局标识。', 400, 'PRESENTATION_TEMPLATE_LAYOUT_DUPLICATE');
    const sourceReport = Array.isArray(template.importMetadata?.report) ? template.importMetadata.report.slice(0, 500).map(item => ({ severity: ['info', 'warning', 'blocking'].includes(String(item?.severity)) ? String(item.severity) : 'warning', code: String(item?.code || 'PPTX_COMPATIBILITY_WARNING').slice(0, 80), location: String(item?.location || '').slice(0, 300), message: String(item?.message || '').slice(0, 500) })) : [];
    const sourceRef = normalizeTemplateAssetRef(template.importMetadata?.sourceRef || template.importMetadata?.source_ref, '模板源文件');
    const importMetadata = template.importMetadata && typeof template.importMetadata === 'object' ? { sourceFormat: String(template.importMetadata.sourceFormat || '').slice(0, 32), importMode: ['editable', 'fidelity'].includes(String(template.importMetadata.importMode)) ? String(template.importMetadata.importMode) : 'editable', importedAt: String(template.importMetadata.importedAt || '').slice(0, 64), warningCount: Math.max(0, Math.min(Number(template.importMetadata.warningCount) || sourceReport.length, 1000)), sourceRef, report: sourceReport } : undefined;
    const brandControls = normalizeBrandControls(template.brandControls || body.brandControls);
    return { schemaVersion: masters.length || template.schemaVersion === '2.0' ? '2.0' : '1.0', theme: withTheme.theme, masters, layouts, assetRefs: collectTemplateAssetRefs({ masters, layouts, brandControls, theme: withTheme.theme }), brandControls, ...(importMetadata ? { importMetadata } : {}) };
}

async function writeTemplateVersion(templateRow, definition, snapshotDigest, user) {
    const report = Array.isArray(definition?.importMetadata?.report) ? definition.importMetadata.report : [];
    const sourceFormat = String(definition?.importMetadata?.sourceFormat || 'pivot').slice(0, 24) || 'pivot';
    const sourceObjectId = parseCasRef(definition?.importMetadata?.sourceRef || '');
    const importOptions = { importMode: definition?.importMetadata?.importMode || 'editable', importedAt: definition?.importMetadata?.importedAt || '' };
    await execute(`
        INSERT INTO presentation_template_versions
            (template_id, version, definition_json, snapshot_digest, source_format, source_object_id, import_options_json, import_report_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON CONFLICT (template_id, version) DO NOTHING
    `, [templateRow.id, Number(templateRow.version), serializeJson(definition), snapshotDigest, sourceFormat, sourceObjectId, serializeJson(importOptions), serializeJson(report), user.id]);
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
    await writeTemplateVersion(row, definition, snapshotDigest, user);
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
    await writeTemplateVersion(row, definition, snapshotDigest, user);
    return toPublicTemplate(row, { includeDefinition: true });
}

async function submitPresentationTemplateForReview(user, templateId) {
    if (!isAdmin(user)) throw publicError('只有管理员可以提交模板审核。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    const existing = await queryOne('SELECT * FROM presentation_templates WHERE client_id = ? AND tenant_id = ? AND deleted_at IS NULL', [normalizeClientId(templateId), tenant.tenantId]);
    if (!existing) throw publicError('模板不存在或无权访问。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    if (!['draft', 'unpublished'].includes(String(existing.status))) throw publicError('只有草稿或已下架模板可以提交审核。', 409, 'PRESENTATION_TEMPLATE_REVIEW_STATE_INVALID');
    await assertTemplatePublishable(user, parseJson(existing.definition_json, {}));
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
    if (approved) await assertTemplatePublishable(user, parseJson(existing.definition_json, {}));
    const row = await queryOne('UPDATE presentation_templates SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_note = ?, updated_at = NOW() WHERE id = ? RETURNING *', [nextStatus, user.id, note, existing.id]);
    return toPublicTemplate(row, { includeDefinition: true });
}

function normalizeTemplatePackage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw publicError('模板包格式无效。', 400, 'PRESENTATION_TEMPLATE_PACKAGE_INVALID');
    if (String(value.kind || '') !== 'pivot-presentation-template' || !['1.0', '2.0'].includes(String(value.schemaVersion || ''))) {
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
    let source;
    const sourceWasCreatedHere = !options.sourceRef;
    let sourceRetainedForTemplate = false;
    try {
        source = options.sourceRef ? { ref: String(options.sourceRef), objectId: parseCasRef(options.sourceRef) } : await persistTemplateSourcePackage(user, buffer, options);
        if (!source.objectId) throw publicError('模板源文件引用无效。', 400, 'PRESENTATION_TEMPLATE_SOURCE_INVALID');
        if (!sourceWasCreatedHere) { await incrementRefCount(source.objectId, 1); sourceRetainedForTemplate = true; }
        const definition = { ...normalized.definition, importMetadata: { ...(normalized.definition.importMetadata || {}), sourceFormat: 'pivot', importMode: 'editable', importedAt: new Date().toISOString(), sourceRef: source.ref, report: [] } };
        return await createPresentationTemplate(user, { ...normalized, definition, scope: options.scope || 'organization', publish: options.publish !== false });
    } catch (error) {
        if (sourceWasCreatedHere && source?.objectId) await incrementRefCount(source.objectId, -1).catch(() => {});
        if (sourceRetainedForTemplate && source?.objectId) await incrementRefCount(source.objectId, -1).catch(() => {});
        throw error;
    }
}

async function parsePptxTemplateInWorker(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer)) throw publicError('PPTX 模板内容无效。', 400, 'PRESENTATION_PPTX_TEMPLATE_INVALID');
    const worker = new Worker(path.join(__dirname, 'presentation-pptx-template-worker.js'), {
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 24, stackSizeMb: 4 }
    });
    return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true; clearTimeout(timeout);
            worker.terminate().catch(() => {});
            callback(value);
        };
        const timeout = setTimeout(() => finish(reject, publicError('PPTX 模板解析超时。', 408, 'PRESENTATION_PPTX_TEMPLATE_TIMEOUT')), PPTX_TEMPLATE_PARSE_TIMEOUT_MS);
        worker.once('error', error => finish(reject, publicError('PPTX 模板解析工作进程失败：' + String(error?.message || ''), 422, 'PRESENTATION_PPTX_TEMPLATE_WORKER_FAILED')));
        worker.once('message', message => {
            if (!message?.ok) return finish(reject, publicError(message?.error?.message || 'PPTX 模板解析失败。', Number(message?.error?.status || 400), message?.error?.code || 'PRESENTATION_PPTX_TEMPLATE_INVALID'));
            const parsed = message.parsed || {};
            parsed.assets = (parsed.assets || []).map(asset => ({ ...asset, buffer: Buffer.from(asset.buffer || []) }));
            finish(resolve, parsed);
        });
        worker.postMessage({ buffer, options: { filename: options.filename, name: options.name, importMode: options.importMode || options.import_mode } });
    });
}

async function previewPresentationTemplateFile(user, buffer, options = {}) {
    if (!isAdmin(user)) throw publicError('只有管理员可以预检组织模板。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const filename = String(options.filename || '').trim();
    const mimeType = String(options.mimeType || options.mimetype || '').toLowerCase();
    const isPptx = /\.pptx$/i.test(filename) || mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (!isPptx) {
        if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_TEMPLATE_PACKAGE_BYTES) throw publicError('模板包为空或超过大小上限。', 413, 'PRESENTATION_TEMPLATE_PACKAGE_TOO_LARGE');
        let parsed;
        try { parsed = JSON.parse(buffer.toString('utf8')); } catch (_) { throw publicError('模板包不是有效 JSON。', 400, 'PRESENTATION_TEMPLATE_PACKAGE_INVALID'); }
        const normalized = normalizeTemplatePackage(parsed);
        return { sourceFormat: 'pivot', name: normalized.name, aspectRatio: normalized.aspectRatio, definition: normalized.definition, assets: [], report: [], warnings: [] };
    }
    const parsed = await parsePptxTemplateInWorker(buffer, { filename, name: options.name, importMode: options.importMode || options.import_mode });
    return {
        sourceFormat: 'pptx', name: parsed.name, aspectRatio: parsed.aspectRatio, definition: parsed.definition,
        assets: (parsed.assets || []).map(asset => ({ key: asset.key, filename: asset.filename, mimeType: asset.mimeType, byteSize: asset.buffer.length })),
        report: parsed.report, warnings: parsed.warnings
    };
}

async function getPresentationTemplateSource(user, templateId, version) {
    if (!isAdmin(user)) throw publicError('只有管理员可以下载模板源文件。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const requestedVersion = Number.parseInt(version, 10);
    if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) throw publicError('模板版本无效。', 400, 'PRESENTATION_TEMPLATE_VERSION_INVALID');
    const tenant = await assertTenantContext(user);
    const row = await queryOne(`
        SELECT t.name, tv.source_format, tv.source_object_id
        FROM presentation_templates t
        JOIN presentation_template_versions tv ON tv.template_id = t.id AND tv.version = ?
        WHERE t.tenant_id = ? AND t.client_id = ? AND t.deleted_at IS NULL
        LIMIT 1
    `, [requestedVersion, tenant.tenantId, normalizeClientId(templateId)]);
    if (!row?.source_object_id) throw publicError('该模板版本没有可下载的源文件。', 404, 'PRESENTATION_TEMPLATE_SOURCE_NOT_FOUND');
    const loaded = await readBuffer({ objectId: row.source_object_id, tenantId: tenant.tenantId, tenantScoped: true });
    return {
        name: String(row.name || 'PPT模板'),
        sourceFormat: String(row.source_format || 'pivot'),
        version: requestedVersion,
        mimeType: loaded.object.mime_type,
        buffer: loaded.buffer
    };
}

async function reparsePresentationTemplateSource(user, templateId, options = {}) {
    if (!isAdmin(user)) throw publicError('只有管理员可以重新解析模板源文件。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    const existing = await queryOne(`
        SELECT t.*, tv.source_format, tv.source_object_id, tv.import_options_json
        FROM presentation_templates t
        JOIN presentation_template_versions tv ON tv.template_id = t.id AND tv.version = t.version
        WHERE t.tenant_id = ? AND t.client_id = ? AND t.deleted_at IS NULL
        LIMIT 1
    `, [tenant.tenantId, normalizeClientId(templateId)]);
    if (!existing?.source_object_id || String(existing.source_format) !== 'pptx') throw publicError('当前模板没有可重新解析的 PPTX 源文件。', 409, 'PRESENTATION_TEMPLATE_REPARSE_UNAVAILABLE');
    const loaded = await readBuffer({ objectId: existing.source_object_id, tenantId: tenant.tenantId, tenantScoped: true });
    const importOptions = parseJson(existing.import_options_json, {});
    const parsed = await parsePptxTemplateInWorker(loaded.buffer, { filename: existing.name + '.pptx', name: existing.name, importMode: options.importMode || options.import_mode || importOptions.importMode });
    let persisted; let sourceRetained = false;
    try {
        persisted = await persistImportedTemplateAssets(user, parsed, { scope: existing.scope, departmentName: existing.department_name });
        await incrementRefCount(existing.source_object_id, 1);
        sourceRetained = true;
        const definition = { ...persisted.definition, importMetadata: { ...(persisted.definition.importMetadata || {}), sourceRef: buildCasRef(existing.source_object_id) } };
        const template = await updatePresentationTemplate(user, templateId, { definition, aspectRatio: parsed.aspectRatio, status: 'pending_review' });
        return { ...template, importWarnings: parsed.warnings, importReport: parsed.report, sourceFormat: 'pptx' };
    } catch (error) {
        if (sourceRetained) await incrementRefCount(existing.source_object_id, -1).catch(() => {});
        await Promise.all((persisted?.objectIds || []).map(objectId => incrementRefCount(objectId, -1).catch(() => {})));
        throw error;
    }
}

function replaceImportedAssetKeys(definition, assetRefs) {
    const mapped = JSON.parse(JSON.stringify(definition || {}));
    const replaceBackground = background => {
        if (!background || typeof background !== 'object') return;
        const ref = assetRefs.get(String(background.imageAssetKey || ''));
        if (ref) background.imageAssetRef = ref;
        delete background.imageAssetKey;
    };
    const replaceElements = elements => (Array.isArray(elements) ? elements : []).forEach(element => {
        if (!element || typeof element !== 'object') return;
        const ref = assetRefs.get(String(element.assetKey || ''));
        if (ref) element.assetRef = ref;
        delete element.assetKey;
    });
    (mapped.masters || []).forEach(master => { replaceBackground(master.background); replaceElements(master.decorations); });
    (mapped.layouts || []).forEach(layout => replaceElements(layout.decorations));
    mapped.assetRefs = [...new Set([...assetRefs.values()])];
    return mapped;
}

async function persistImportedTemplateAssets(user, parsed, options = {}) {
    const scope = ['private', 'organization', 'department'].includes(String(options.scope || '')) ? String(options.scope) : 'organization';
    const departmentName = scope === 'department' ? normalizeDepartmentName(options.departmentName || options.department_name || user.unit) : '';
    const refs = new Map(); const incrementedObjectIds = [];
    try {
        for (const asset of parsed.assets || []) {
            const uploaded = await uploadPresentationAsset(user, {
                buffer: asset.buffer,
                mimetype: asset.mimeType,
                originalname: asset.filename
            }, { assetType: 'image', scope, departmentName });
            refs.set(asset.key, uploaded.ref);
            const objectId = parseCasRef(uploaded.ref); if (objectId) incrementedObjectIds.push(objectId);
        }
        return { definition: replaceImportedAssetKeys(parsed.definition, refs), objectIds: incrementedObjectIds };
    } catch (error) {
        await Promise.all(incrementedObjectIds.map(objectId => incrementRefCount(objectId, -1).catch(() => {})));
        throw error;
    }
}

async function persistTemplateSourcePackage(user, buffer, options = {}) {
    const tenant = await assertTenantContext(user);
    const mimeType = String(options.mimeType || options.mimetype || '').toLowerCase() || (/\.pptx$/i.test(String(options.filename || '')) ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/json');
    const stored = await putBuffer({ buffer, mimeType, tenantId: tenant.tenantId, ownerUserId: user.id, kind: 'presentation_tpl_source', retentionDays: 365 });
    await incrementRefCount(stored.objectId, 1);
    return { ref: buildCasRef(stored.objectId), objectId: stored.objectId };
}

async function importPresentationTemplateFile(user, buffer, options = {}) {
    const filename = String(options.filename || '').trim();
    const mimeType = String(options.mimeType || options.mimetype || '').toLowerCase();
    const isPptx = /\.pptx$/i.test(filename) || mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (!isPptx) return await importPresentationTemplate(user, buffer, options);
    const parsed = options.parsedPptx || await parsePptxTemplateInWorker(buffer, { filename, name: options.name, importMode: options.importMode || options.import_mode });
    let source; let persisted;
    const sourceWasCreatedHere = !options.sourceRef;
    let sourceRetainedForTemplate = false;
    try {
        source = options.sourceRef ? { ref: String(options.sourceRef), objectId: parseCasRef(options.sourceRef) } : await persistTemplateSourcePackage(user, buffer, options);
        if (!source.objectId) throw publicError('模板源文件引用无效。', 400, 'PRESENTATION_TEMPLATE_SOURCE_INVALID');
        if (!sourceWasCreatedHere) { await incrementRefCount(source.objectId, 1); sourceRetainedForTemplate = true; }
        persisted = await persistImportedTemplateAssets(user, parsed, options);
        const definition = { ...persisted.definition, importMetadata: { ...(persisted.definition.importMetadata || {}), sourceRef: source.ref } };
        const template = await createPresentationTemplate(user, {
            name: parsed.name,
            description: '从外部 PPTX 提取的受控主题、母版、布局和素材模板。' + (parsed.warnings.length ? ' 导入时发现 ' + parsed.warnings.length + ' 项兼容性提示。' : ''),
            aspectRatio: parsed.aspectRatio,
            definition,
            scope: options.scope || 'organization',
            publish: options.publish !== false
        });
        return { ...template, importWarnings: parsed.warnings, importReport: parsed.report, sourceFormat: 'pptx' };
    } catch (error) {
        const ids = [...(sourceWasCreatedHere && source?.objectId ? [source.objectId] : []), ...(persisted?.objectIds || [])];
        if (sourceRetainedForTemplate && source?.objectId) ids.push(source.objectId);
        await Promise.all(ids.map(objectId => incrementRefCount(objectId, -1).catch(() => {})));
        throw error;
    }
}

function toPublicTemplateImportJob(row) {
    if (!row) return null;
    const result = parseJson(row.result_json, {});
    return {
        id: String(row.client_id),
        status: String(row.status || 'queued'),
        filename: String(row.filename || ''),
        scope: String(row.scope || 'organization'),
        departmentName: String(row.department_name || ''),
        importMode: String(row.import_mode || 'editable'),
        templateId: String(row.template_client_id || ''),
        template: result.template || null,
        importWarnings: Array.isArray(result.importWarnings) ? result.importWarnings : [],
        importReport: Array.isArray(result.importReport) ? result.importReport : [],
        errorCode: String(row.error_code || ''),
        errorMessage: String(row.error_message || ''),
        createdAt: row.created_at,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        updatedAt: row.updated_at
    };
}

function isPptxTemplateFile(options = {}) {
    const filename = String(options.filename || '').trim();
    const mimeType = String(options.mimeType || options.mimetype || '').toLowerCase();
    return /\.pptx$/i.test(filename) || mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
}

function normalizeTemplateImportRequestOptions(user, options = {}) {
    const scope = ['private', 'organization', 'department'].includes(String(options.scope || '')) ? String(options.scope) : 'organization';
    const departmentName = scope === 'department' ? normalizeDepartmentName(options.departmentName || options.department_name || user.unit) : '';
    if (scope === 'department' && !departmentName) throw publicError('部门模板必须指定部门。', 400, 'PRESENTATION_TEMPLATE_DEPARTMENT_REQUIRED');
    return {
        scope,
        departmentName,
        importMode: options.importMode === 'fidelity' || options.import_mode === 'fidelity' ? 'fidelity' : 'editable',
        publish: options.publish !== false,
        filename: String(options.filename || '导入模板').replace(/[\\/]/g, '_').slice(0, 240),
        mimeType: String(options.mimeType || options.mimetype || '').toLowerCase()
    };
}

async function createPresentationTemplateImportJob(user, buffer, options = {}) {
    if (!isAdmin(user)) throw publicError('只有管理员可以导入组织模板。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw publicError('请选择模板包文件。', 400, 'PRESENTATION_TEMPLATE_FILE_REQUIRED');
    const request = normalizeTemplateImportRequestOptions(user, options);
    const maxBytes = isPptxTemplateFile(request) ? 20 * 1024 * 1024 : MAX_TEMPLATE_PACKAGE_BYTES;
    if (buffer.length > maxBytes) throw publicError('模板包超过允许的大小上限。', 413, 'PRESENTATION_TEMPLATE_PACKAGE_TOO_LARGE');
    const source = await persistTemplateSourcePackage(user, buffer, request);
    const tenant = await assertTenantContext(user);
    const clientId = `template_import_${crypto.randomUUID().replace(/-/g, '')}`;
    try {
        const row = await queryOne(`
            INSERT INTO presentation_template_import_jobs
                (tenant_id, owner_user_id, client_id, source_object_id, filename, mime_type, scope, department_name, import_mode, publish_requested, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NOW(), NOW())
            RETURNING *
        `, [tenant.tenantId, user.id, clientId, source.objectId, request.filename, request.mimeType || (isPptxTemplateFile(request) ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/json'), request.scope, request.departmentName, request.importMode, request.publish]);
        return toPublicTemplateImportJob(row);
    } catch (error) {
        await incrementRefCount(source.objectId, -1).catch(() => {});
        throw error;
    }
}

async function getPresentationTemplateImportJob(user, taskId) {
    const tenant = await assertTenantContext(user);
    const row = await queryOne(`
        SELECT * FROM presentation_template_import_jobs
        WHERE tenant_id = ? AND client_id = ? AND (owner_user_id = ? OR ? = true)
        LIMIT 1
    `, [tenant.tenantId, normalizeClientId(taskId), user.id, isAdmin(user)]);
    return toPublicTemplateImportJob(row);
}

async function runPresentationTemplateImportJob(user, taskId) {
    const tenant = await assertTenantContext(user);
    const clientId = normalizeClientId(taskId);
    const started = await queryOne(`
        UPDATE presentation_template_import_jobs
        SET status = 'processing', started_at = NOW(), updated_at = NOW(), error_code = '', error_message = ''
        WHERE tenant_id = ? AND owner_user_id = ? AND client_id = ? AND status = 'queued'
        RETURNING *
    `, [tenant.tenantId, user.id, clientId]);
    if (!started) return await getPresentationTemplateImportJob(user, clientId);
    try {
        const loaded = await readBuffer({ objectId: started.source_object_id, tenantId: tenant.tenantId, tenantScoped: true });
        const parsedPptx = isPptxTemplateFile({ filename: started.filename, mimeType: started.mime_type })
            ? await parsePptxTemplateInWorker(loaded.buffer, { filename: started.filename, importMode: started.import_mode })
            : null;
        const template = await importPresentationTemplateFile(user, loaded.buffer, {
            filename: started.filename,
            mimeType: started.mime_type,
            scope: started.scope,
            departmentName: started.department_name,
            importMode: started.import_mode,
            publish: started.publish_requested === true || started.publish_requested === 'true' || Number(started.publish_requested) === 1,
            sourceRef: buildCasRef(started.source_object_id),
            parsedPptx
        });
        const completed = await queryOne(`
            UPDATE presentation_template_import_jobs
            SET status = 'completed', template_client_id = ?, result_json = ?, completed_at = NOW(), updated_at = NOW()
            WHERE id = ? AND status = 'processing'
            RETURNING *
        `, [template.id, serializeJson({ template, importWarnings: template.importWarnings || [], importReport: template.importReport || [] }), started.id]);
        return toPublicTemplateImportJob(completed || started);
    } catch (error) {
        await incrementRefCount(started.source_object_id, -1).catch(() => {});
        const failed = await queryOne(`
            UPDATE presentation_template_import_jobs
            SET status = 'failed', error_code = ?, error_message = ?, completed_at = NOW(), updated_at = NOW()
            WHERE id = ? AND status = 'processing'
            RETURNING *
        `, [String(error.code || 'PRESENTATION_TEMPLATE_IMPORT_FAILED').slice(0, 96), String(error.message || '模板导入失败。').slice(0, 1000), started.id]);
        return toPublicTemplateImportJob(failed || started);
    }
}

async function cancelPresentationTemplateImportJob(user, taskId) {
    if (!isAdmin(user)) throw publicError('只有管理员可以取消模板导入。', 403, 'PRESENTATION_TEMPLATE_ADMIN_REQUIRED');
    const tenant = await assertTenantContext(user);
    const row = await queryOne(`
        UPDATE presentation_template_import_jobs
        SET status = 'cancelled', completed_at = NOW(), updated_at = NOW(), error_code = 'PRESENTATION_TEMPLATE_IMPORT_CANCELLED', error_message = '模板导入已取消。'
        WHERE tenant_id = ? AND owner_user_id = ? AND client_id = ? AND status = 'queued'
        RETURNING *
    `, [tenant.tenantId, user.id, normalizeClientId(taskId)]);
    if (!row) {
        const current = await getPresentationTemplateImportJob(user, taskId);
        if (!current) throw publicError('模板导入任务不存在或无权访问。', 404, 'PRESENTATION_TEMPLATE_IMPORT_NOT_FOUND');
        if (current.status === 'processing') throw publicError('模板导入已进入不可取消的解析阶段。', 409, 'PRESENTATION_TEMPLATE_IMPORT_PROCESSING');
        return current;
    }
    const objectId = String(row.source_object_id || '');
    if (objectId) await incrementRefCount(objectId, -1).catch(() => {});
    return toPublicTemplateImportJob(row);
}

async function exportPresentationTemplate(user, templateId) {
    const template = await resolveTemplateForUser(user, templateId, { includeDefinition: true });
    if (!template?.definition) throw publicError('模板不存在或无权访问。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    return {
        schemaVersion: template.definition?.schemaVersion === '2.0' ? '2.0' : '1.0',
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

    return {
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
    };
}

module.exports = { createPresentationTemplateService };
