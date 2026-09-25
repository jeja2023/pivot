'use strict';

/**
 * PPTX 模板导入器。
 *
 * 只把经过关系解析且能映射到 Pivot 模板 IR 的内容导入；宏、ActiveX、外部
 * 关系和复杂 Office 对象绝不执行。无法表达的对象会写入 importReport，调用方
 * 可在发布前要求管理员确认“静态保真”或人工修复。
 */
const crypto = require('crypto');
const path = require('path').posix;
const unzipper = require('unzipper');
const { DOMParser } = require('@xmldom/xmldom');
const { STANDARD_LAYOUTS } = require('./presentation-templates');

const MAX_PPTX_TEMPLATE_BYTES = 20 * 1024 * 1024;
const MAX_PPTX_TEMPLATE_ENTRIES = 800;
const MAX_PPTX_TEMPLATE_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;
const MAX_PPTX_TEMPLATE_COMPRESSION_RATIO = 120;
const MAX_PPTX_TEMPLATE_XML_BYTES = 2 * 1024 * 1024;
const IMAGE_MIME_TYPES = Object.freeze({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'
});

function importError(message, code = 'PRESENTATION_PPTX_TEMPLATE_INVALID', status = 400) {
    const error = new Error(message); error.code = code; error.status = status; error.statusCode = status; error.expose = true; return error;
}

function localName(node) {
    return String(node?.localName || node?.nodeName || '').split(':').pop();
}

function childElements(node, wanted = '') {
    const results = [];
    for (let child = node?.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && (!wanted || localName(child) === wanted)) results.push(child);
    }
    return results;
}

function firstChild(node, wanted) {
    return childElements(node, wanted)[0] || null;
}

function descendants(node, wanted) {
    const results = [];
    const stack = childElements(node).reverse();
    while (stack.length) {
        const current = stack.pop();
        if (!wanted || localName(current) === wanted) results.push(current);
        const children = childElements(current);
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
    return results;
}

function firstDescendant(node, wanted) {
    return descendants(node, wanted)[0] || null;
}

function attribute(node, name) {
    if (!node) return '';
    return String(node.getAttribute?.(name) || node.getAttribute?.(`r:${name}`) || '').trim();
}

function relationshipId(node) {
    return String(node?.getAttributeNS?.('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || node?.getAttribute?.('r:id') || '').trim();
}

function textContent(node) {
    return String(node?.textContent || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseXml(xml, entryPath) {
    const source = String(xml || '');
    if (!source || Buffer.byteLength(source, 'utf8') > MAX_PPTX_TEMPLATE_XML_BYTES) {
        throw importError(`PPTX XML 文件大小异常：${entryPath}`, 'PRESENTATION_PPTX_TEMPLATE_XML_TOO_LARGE', 413);
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw importError(`PPTX XML 包含不受支持的 DTD/实体：${entryPath}`, 'PRESENTATION_PPTX_TEMPLATE_XML_UNSAFE');
    const errors = [];
    const document = new DOMParser({ onError: (level, message) => { if (level === 'error' || level === 'fatalError') errors.push(String(message)); } }).parseFromString(source, 'application/xml');
    if (errors.length || descendants(document, 'parsererror').length) throw importError(`PPTX XML 无法解析：${entryPath}`, 'PRESENTATION_PPTX_TEMPLATE_XML_INVALID');
    return document;
}

function toHexColor(value, fallback) {
    const color = String(value || '').replace(/^#/, '').trim();
    return /^[0-9a-f]{6}$/i.test(color) ? '#' + color.toUpperCase() : fallback;
}

function colorFromNode(node, fallback, scheme = {}) {
    if (!node) return fallback;
    const srgb = firstDescendant(node, 'srgbClr');
    if (srgb) return toHexColor(attribute(srgb, 'val'), fallback);
    const system = firstDescendant(node, 'sysClr');
    if (system) return toHexColor(attribute(system, 'lastClr'), fallback);
    const schemeColor = firstDescendant(node, 'schemeClr');
    if (schemeColor) return scheme[String(attribute(schemeColor, 'val')).toLowerCase()] || fallback;
    return fallback;
}

function colorFromFill(node, fallback, scheme = {}) {
    const solid = firstDescendant(node, 'solidFill');
    return solid ? colorFromNode(solid, fallback, scheme) : fallback;
}

function extractColorScheme(themeDocument) {
    const defaults = { primary: '#1769AA', secondary: '#5B8FF9', accent: '#61DDAA', text: '#1F2937', background: '#F7F9FC' };
    const scheme = firstDescendant(themeDocument, 'clrScheme');
    const find = name => colorFromNode(firstChild(scheme, name), defaults.primary, {});
    const palette = {
        dk1: colorFromNode(firstChild(scheme, 'dk1'), defaults.text, {}),
        lt1: colorFromNode(firstChild(scheme, 'lt1'), defaults.background, {}),
        dk2: colorFromNode(firstChild(scheme, 'dk2'), defaults.text, {}),
        lt2: colorFromNode(firstChild(scheme, 'lt2'), defaults.background, {}),
        accent1: find('accent1'), accent2: find('accent2'), accent3: find('accent3'), accent4: find('accent4'), accent5: find('accent5'), accent6: find('accent6')
    };
    return {
        colors: { primary: palette.accent1, secondary: palette.accent2, accent: palette.accent3, text: palette.dk1, background: palette.lt1 },
        palette
    };
}

function extractTypeface(fontBlock) {
    const eastAsian = firstChild(fontBlock, 'ea');
    const latin = firstChild(fontBlock, 'latin');
    return (attribute(eastAsian, 'typeface') || attribute(latin, 'typeface') || 'Microsoft YaHei').slice(0, 120) || 'Microsoft YaHei';
}

function extractFonts(themeDocument) {
    const fontScheme = firstDescendant(themeDocument, 'fontScheme');
    return { heading: extractTypeface(firstChild(fontScheme, 'majorFont')), body: extractTypeface(firstChild(fontScheme, 'minorFont')) };
}

function canvasForSize(presentationDocument) {
    const size = firstDescendant(presentationDocument, 'sldSz');
    const cx = Number(attribute(size, 'cx')) || 0;
    const cy = Number(attribute(size, 'cy')) || 0;
    const ratio = cx / Math.max(1, cy);
    const aspectRatio = !cx || !cy || Math.abs(ratio - 16 / 9) <= Math.abs(ratio - 4 / 3) ? '16:9' : '4:3';
    return { aspectRatio, width: aspectRatio === '4:3' ? 960 : 1280, height: 720, emuWidth: cx || (aspectRatio === '4:3' ? 9144000 : 12192000), emuHeight: cy || 6858000 };
}

function relsPathFor(sourcePath) {
    return path.join(path.dirname(sourcePath), '_rels', path.basename(sourcePath) + '.rels');
}

function resolveRelationshipTarget(sourcePath, target) {
    const value = String(target || '').replace(/\\/g, '/').trim();
    if (!value || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
    const resolved = path.normalize(path.join(path.dirname(sourcePath), value)).replace(/^\.\//, '');
    return resolved.startsWith('../') || resolved === '..' ? '' : resolved;
}

function relationshipMap(entriesByPath, sourcePath, report) {
    const relsEntry = entriesByPath.get(relsPathFor(sourcePath));
    if (!relsEntry?.text) return new Map();
    const document = parseXml(relsEntry.text, relsEntry.path);
    const relationships = new Map();
    descendants(document, 'Relationship').forEach(item => {
        const id = attribute(item, 'Id'); const type = attribute(item, 'Type'); const target = attribute(item, 'Target'); const external = String(attribute(item, 'TargetMode')).toLowerCase() === 'external';
        if (!id) return;
        if (external || !resolveRelationshipTarget(sourcePath, target)) {
            report.push({ severity: 'warning', code: 'EXTERNAL_RELATIONSHIP_IGNORED', location: sourcePath, message: '检测到外部或非法关系；已忽略且不会联网下载。' });
            return;
        }
        relationships.set(id, { id, type, target: resolveRelationshipTarget(sourcePath, target) });
    });
    return relationships;
}

function categoryForName(name, index) {
    const normalized = String(name || '').toLowerCase();
    if (/section|章节/.test(normalized)) return '章节';
    if (/title.*slide|标题幻灯片|封面/.test(normalized)) return '封面';
    if (/chart|图表|table|表格/.test(normalized)) return '数据';
    if (/summary|总结/.test(normalized)) return '总结';
    return STANDARD_LAYOUTS[index % STANDARD_LAYOUTS.length]?.category || '内容';
}

function legacyLayoutIdForName(name, index) {
    const normalized = String(name || '').toLowerCase();
    if (/section|章节/.test(normalized)) return 'section';
    if (/title.*slide|标题幻灯片|封面/.test(normalized)) return 'cover';
    if (/two|comparison|比较|双栏/.test(normalized)) return 'two-column';
    if (/three|三栏|card/.test(normalized)) return 'three-card';
    if (/picture|image|图片|图像/.test(normalized)) return 'image-focus';
    if (/chart|图表/.test(normalized)) return 'chart';
    if (/table|表格/.test(normalized)) return 'table';
    if (/quote|引用/.test(normalized)) return 'quote';
    if (/summary|总结/.test(normalized)) return 'summary';
    if (/title|标题|content|内容/.test(normalized)) return 'title-content';
    return STANDARD_LAYOUTS[index % STANDARD_LAYOUTS.length]?.id || 'title-content';
}

function clampBounds(bounds, canvas) {
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round(bounds.x * 100) / 100));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round(bounds.y * 100) / 100));
    const width = Math.max(1, Math.min(canvas.width - x, Math.round(bounds.width * 100) / 100));
    const height = Math.max(1, Math.min(canvas.height - y, Math.round(bounds.height * 100) / 100));
    return { x, y, width, height, rotation: Math.round((bounds.rotation || 0) * 100) / 100 };
}

function transformFor(node, canvas) {
    const xfrm = firstDescendant(node, 'xfrm');
    const off = firstChild(xfrm, 'off'); const ext = firstChild(xfrm, 'ext');
    const x = (Number(attribute(off, 'x')) || 0) / canvas.emuWidth * canvas.width;
    const y = (Number(attribute(off, 'y')) || 0) / canvas.emuHeight * canvas.height;
    const width = (Number(attribute(ext, 'cx')) || canvas.emuWidth * 0.25) / canvas.emuWidth * canvas.width;
    const height = (Number(attribute(ext, 'cy')) || canvas.emuHeight * 0.1) / canvas.emuHeight * canvas.height;
    return clampBounds({ x, y, width, height, rotation: (Number(attribute(xfrm, 'rot')) || 0) / 60000 }, canvas);
}

function placeholderRole(placeholder, fallbackName = '') {
    const type = String(attribute(placeholder, 'type') || '').toLowerCase();
    const name = String(fallbackName || '').toLowerCase();
    if (['title', 'ctrtitle'].includes(type) || /title|标题/.test(name)) return 'title';
    if (['subTitle'.toLowerCase(), 'subsubtitle'].includes(type) || /subtitle|副标题/.test(name)) return 'subtitle';
    if (['body', 'obj'].includes(type) || /body|正文|content/.test(name)) return 'body';
    if (['pic', 'clipart'].includes(type) || /image|picture|图片|图像/.test(name)) return 'image';
    if (type === 'chart') return 'chart';
    if (type === 'tbl') return 'table';
    if (type === 'dt') return 'date';
    if (type === 'ftr') return 'footer';
    if (type === 'sldnum') return 'pageNumber';
    return type || 'body';
}

function textStyleFor(shape, theme, scheme) {
    const run = firstDescendant(shape, 'defRPr') || firstDescendant(shape, 'rPr') || firstDescendant(shape, 'endParaRPr');
    const fontSize = Math.max(6, Math.min(96, Math.round((Number(attribute(run, 'sz')) || 1800) / 100)));
    const family = attribute(firstChild(run, 'ea'), 'typeface') || attribute(firstChild(run, 'latin'), 'typeface') || (fontSize >= 24 ? theme.fonts.heading : theme.fonts.body);
    const alignment = String(attribute(firstDescendant(shape, 'pPr'), 'algn')).toLowerCase();
    const align = alignment === 'ctr' ? 'center' : alignment === 'r' ? 'right' : alignment === 'just' ? 'justify' : 'left';
    const color = colorFromFill(run, theme.colors.text, scheme);
    return { fontFamily: family.slice(0, 120), fontSize, fontWeight: String(attribute(run, 'b')).toLowerCase() === '1' || String(attribute(run, 'b')).toLowerCase() === 'true' ? 700 : 400, color, align, verticalAlign: 'top', lineHeight: 1.35, italic: String(attribute(run, 'i')).toLowerCase() === '1' || String(attribute(run, 'i')).toLowerCase() === 'true', underline: Boolean(attribute(run, 'u')), bullet: false, padding: 0 };
}

function shapeTypeFor(shape) {
    const geometry = firstDescendant(shape, 'prstGeom');
    const type = String(attribute(geometry, 'prst'));
    if (['ellipse'].includes(type)) return 'ellipse';
    if (['roundRect', 'round1Rect', 'round2SameRect', 'round2DiagRect'].includes(type)) return 'roundRect';
    if (['line'].includes(type)) return 'line';
    return 'rect';
}

function opacityFor(node) {
    const alpha = firstDescendant(node, 'alpha');
    if (!alpha) return 1;
    return Math.max(0, Math.min(1, (Number(attribute(alpha, 'val')) || 100000) / 100000));
}

function shapeDecoration(shape, canvas, theme, scheme) {
    const bounds = transformFor(shape, canvas);
    const text = descendants(shape, 't').map(item => textContent(item)).join('');
    const spPr = firstChild(shape, 'spPr') || firstDescendant(shape, 'spPr');
    if (text) return { id: '', type: 'text', ...bounds, zIndex: 1, locked: true, visible: true, sourceRefs: [], content: { text: text.slice(0, 16000) }, style: textStyleFor(shape, theme, scheme), animation: { type: 'none', durationMs: 0, delayMs: 0, direction: '' } };
    return { id: '', type: 'shape', ...bounds, zIndex: 1, locked: true, visible: true, sourceRefs: [], shapeType: shapeTypeFor(shape), style: { fill: colorFromFill(spPr, '#FFFFFF', scheme), stroke: colorFromFill(firstDescendant(spPr, 'ln'), '#FFFFFF', scheme), strokeWidth: 1, opacity: opacityFor(spPr), radius: shapeTypeFor(shape) === 'roundRect' ? 12 : 0 }, animation: { type: 'none', durationMs: 0, delayMs: 0, direction: '' } };
}

function uniqueId(prefix, existing) {
    let index = 1; let candidate = prefix;
    while (existing.has(candidate)) candidate = `${prefix}_${index++}`;
    existing.add(candidate); return candidate;
}

function addReport(report, severity, code, location, message) {
    report.push({ severity, code, location: String(location || '').slice(0, 300), message: String(message || '').slice(0, 500) });
}

function mimeForPath(filePath) {
    return IMAGE_MIME_TYPES[path.extname(String(filePath || '')).toLowerCase()] || '';
}

function createAssetRegistry(entriesByPath, report) {
    const assets = []; const byPath = new Map();
    return {
        assets,
        keyFor(target, location) {
            const entry = entriesByPath.get(target);
            if (!entry?.buffer) { addReport(report, 'warning', 'MISSING_TEMPLATE_ASSET', location, `模板引用的素材不存在：${target}`); return ''; }
            const mimeType = mimeForPath(target);
            if (!mimeType || !IMAGE_MIME_TYPES[path.extname(target).toLowerCase()]) { addReport(report, 'warning', 'UNSUPPORTED_TEMPLATE_ASSET', location, `模板素材类型不支持：${target}`); return ''; }
            if (byPath.has(target)) return byPath.get(target).key;
            const key = 'asset_' + crypto.createHash('sha256').update(target).digest('hex').slice(0, 16);
            const asset = { key, path: target, filename: path.basename(target).slice(0, 240), mimeType, buffer: entry.buffer };
            byPath.set(target, asset); assets.push(asset);
            addReport(report, 'info', 'IMPORTED_TEMPLATE_ASSET', target, `已提取模板素材：${asset.filename}。`);
            return key;
        }
    };
}

function parseBackground(source, relationships, canvas, scheme, assets, location) {
    const background = { fill: '#FFFFFF', imageAssetKey: '', opacity: 1 };
    const bgPr = firstDescendant(source, 'bgPr');
    if (!bgPr) return background;
    background.fill = colorFromFill(bgPr, background.fill, scheme);
    background.opacity = opacityFor(bgPr);
    const blip = firstDescendant(bgPr, 'blip'); const relId = attribute(blip, 'embed');
    const relation = relationships.get(relId);
    if (relation) background.imageAssetKey = assets.keyFor(relation.target, location);
    return background;
}

function parseLayer(document, entryPath, relationships, canvas, theme, scheme, assets, report) {
    const cSld = firstDescendant(document, 'cSld');
    const name = attribute(cSld, 'name');
    const tree = firstDescendant(cSld, 'spTree');
    const placeholders = []; const decorations = []; const ids = new Set(); let zIndex = 1;
    const pushDecoration = item => { if (!item) return; item.id = uniqueId('templateDecoration', ids); item.zIndex = zIndex++; decorations.push(item); };
    childElements(tree).forEach(shape => {
        const type = localName(shape);
        if (['nvGrpSpPr', 'grpSpPr', 'extLst'].includes(type)) return;
        const nvPr = firstDescendant(shape, 'nvPr'); const placeholder = firstChild(nvPr, 'ph');
        const cNvPr = firstDescendant(shape, 'cNvPr'); const elementName = attribute(cNvPr, 'name');
        const bounds = transformFor(shape, canvas);
        if (placeholder) {
            const role = placeholderRole(placeholder, elementName); const kind = type === 'pic' || role === 'image' ? 'image' : type === 'graphicFrame' || role === 'chart' ? 'chart' : role === 'table' ? 'table' : 'text';
            placeholders.push({ id: uniqueId(`slot_${role.replace(/[^A-Za-z0-9_-]/g, '_') || 'content'}`, ids), role, kind, ...bounds, style: kind === 'text' ? textStyleFor(shape, theme, scheme) : {}, required: role === 'title', constraints: { maxLines: Math.max(1, Math.floor(bounds.height / Math.max(12, kind === 'text' ? textStyleFor(shape, theme, scheme).fontSize * 1.25 : 24))), overflow: 'shrink-or-split' } });
            return;
        }
        if (type === 'sp') { pushDecoration(shapeDecoration(shape, canvas, theme, scheme)); return; }
        if (type === 'pic') {
            const blip = firstDescendant(shape, 'blip'); const relation = relationships.get(attribute(blip, 'embed')); const assetKey = relation ? assets.keyFor(relation.target, entryPath) : '';
            if (assetKey) pushDecoration({ id: '', type: 'image', ...bounds, zIndex: 1, locked: true, visible: true, sourceRefs: [], assetKey, fit: 'cover', opacity: opacityFor(shape), alt: elementName.slice(0, 300), animation: { type: 'none', durationMs: 0, delayMs: 0, direction: '' } });
            return;
        }
        if (type === 'graphicFrame' || type === 'grpSp' || type === 'cxnSp') addReport(report, 'warning', 'UNSUPPORTED_TEMPLATE_OBJECT', entryPath, `未转换的模板对象：${type}（${elementName || '未命名'}）。`);
    });
    return { name, background: parseBackground(cSld || document, relationships, canvas, scheme, assets, entryPath), placeholders, decorations };
}

function fallbackLayouts() {
    return STANDARD_LAYOUTS.map(layout => ({
        id: layout.id,
        name: layout.name,
        category: layout.category,
        slots: [...layout.slots],
        legacyLayoutId: layout.id,
        masterId: 'master_default',
        placeholders: layout.slots.map((role, slotIndex) => ({
            id: `slot_${role}`,
            role,
            kind: role === 'image' ? 'image' : role === 'chart' ? 'chart' : role === 'table' ? 'table' : 'text',
            x: slotIndex === 0 ? 80 : 100,
            y: slotIndex === 0 ? 58 : 180,
            width: slotIndex === 0 ? 1120 : 1040,
            height: slotIndex === 0 ? 72 : 360,
            rotation: 0,
            style: {},
            required: role === 'title',
            constraints: { maxLines: slotIndex === 0 ? 2 : 12, overflow: 'shrink-or-split' }
        })),
        decorations: [],
        defaultTransition: { type: 'none', durationMs: 0, direction: '' }
    }));
}

function parseLayouts(entries) {
    const normalized = Array.isArray(entries) ? entries : [];
    const results = []; const used = new Set();
    normalized.filter(entry => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(entry.path)).sort((left, right) => left.path.localeCompare(right.path)).forEach((entry, index) => {
        let document; try { document = parseXml(entry.text || '', entry.path); } catch (_) { return; }
        const name = attribute(firstDescendant(document, 'cSld'), 'name') || `导入布局 ${index + 1}`;
        const id = uniqueId(`layout_${index + 1}`, used); const legacyLayoutId = legacyLayoutIdForName(name, index); const standard = STANDARD_LAYOUTS.find(item => item.id === legacyLayoutId) || STANDARD_LAYOUTS[0];
        results.push({ id, name: name.slice(0, 120), category: standard.category, slots: [...standard.slots], legacyLayoutId, masterId: 'master_default', placeholders: [], decorations: [], defaultTransition: { type: 'none', durationMs: 0, direction: '' } });
    });
    return results.length ? results : fallbackLayouts();
}

function transitionFromSlide(document, report, location) {
    const transition = firstDescendant(document, 'transition');
    if (!transition) return { type: 'none', durationMs: 0, direction: '' };
    const child = childElements(transition)[0]; const type = ['fade', 'push', 'wipe', 'split', 'cover', 'uncover'].includes(localName(child)) ? localName(child) : 'none';
    if (type === 'none') {
        addReport(report, 'warning', 'UNSUPPORTED_SLIDE_TRANSITION', location, '检测到无法映射的页面转场；未继承，可在 Pivot 中重新设置。');
        return { type, durationMs: 0, direction: '' };
    }
    const speed = String(attribute(transition, 'spd')).toLowerCase();
    return { type, durationMs: speed === 'fast' ? 300 : speed === 'slow' ? 1200 : 700, direction: attribute(child, 'dir').slice(0, 24) };
}

function animationTypeFromEffect(effect) {
    const filter = String(attribute(effect, 'filter')).toLowerCase();
    if (/fade/.test(filter) || localName(effect) === 'fade') return 'fade';
    if (/zoom|grow|shrink/.test(filter)) return 'zoom';
    if (/wipe|wheel/.test(filter)) return 'wipe';
    if (/fly|slide|strips/.test(filter) || localName(effect) === 'animMotion') return 'fly';
    return '';
}

function slotAnimationsFromSlide(document, report, location) {
    const shapeRoles = new Map();
    descendants(document, 'sp').forEach(shape => {
        const id = attribute(firstDescendant(shape, 'cNvPr'), 'id');
        const placeholder = firstChild(firstDescendant(shape, 'nvPr'), 'ph');
        if (id && placeholder) shapeRoles.set(id, placeholderRole(placeholder, attribute(firstDescendant(shape, 'cNvPr'), 'name')));
    });
    const animations = {};
    descendants(document, 'animEffect').concat(descendants(document, 'animMotion')).forEach(effect => {
        const type = animationTypeFromEffect(effect);
        const target = firstDescendant(effect, 'spTgt');
        const role = shapeRoles.get(attribute(target, 'spid'));
        if (!role) { addReport(report, 'warning', 'UNMAPPED_ENTRY_ANIMATION', location, '检测到未关联到模板占位符的入场动画；未继承。'); return; }
        if (!type) { addReport(report, 'warning', 'UNSUPPORTED_ENTRY_ANIMATION', location, `占位符 ${role} 使用了无法映射的入场动画。`); return; }
        const timing = firstDescendant(effect, 'cTn'); const duration = Number(attribute(timing, 'dur'));
        animations[role] = { type, durationMs: Number.isFinite(duration) && duration >= 100 && duration <= 10000 ? duration : 500, delayMs: 0, direction: String(attribute(effect, 'dir') || attribute(effect, 'filter')).slice(0, 24) };
    });
    return animations;
}

function applyExampleSlideMotion(presentationDocument, presentationRelationships, entriesByPath, layoutsByPath, report) {
    descendants(presentationDocument, 'sldId').forEach(slideRef => {
        const slidePath = presentationRelationships.get(relationshipId(slideRef))?.target;
        const entry = slidePath ? entriesByPath.get(slidePath) : null;
        if (!entry?.text) return;
        const document = parseXml(entry.text, entry.path); const relationships = relationshipMap(entriesByPath, entry.path, report);
        const layoutPath = [...relationships.values()].find(item => /\/slideLayout$/i.test(item.type))?.target;
        const layout = layoutsByPath.get(layoutPath);
        if (!layout) return;
        const transition = transitionFromSlide(document, report, entry.path);
        if (transition.type !== 'none' && layout.defaultTransition?.type === 'none') layout.defaultTransition = transition;
        const animations = slotAnimationsFromSlide(document, report, entry.path);
        if (Object.keys(animations).length) layout.slotAnimations = { ...(layout.slotAnimations || {}), ...animations };
    });
}

function collectWarnings(entries) {
    const paths = entries.map(entry => entry.path.toLowerCase()); const content = entries.map(entry => entry.text || '').join('\n'); const warnings = [];
    if (paths.some(item => item.endsWith('vbaproject.bin') || item.includes('/activex/'))) warnings.push('检测到宏或 ActiveX 控件；已忽略且不会导入。');
    if (/<p:timing\b/i.test(content) && !/<p:(?:animEffect|animMotion)\b/i.test(content)) warnings.push('检测到复杂或无法映射的动画时，已在兼容性报告中标明；可在 Pivot 中重新设置。');
    if (paths.some(item => item.includes('/embeddings/'))) warnings.push('检测到嵌入对象；已忽略。');
    if (paths.some(item => item.includes('/media/'))) warnings.push('检测到音视频媒体；未作为模板素材导入。');
    if (paths.some(item => item.includes('/charts/'))) warnings.push('检测到 Office 原生图表；图表对象未转换为模板内容。');
    if (!paths.some(item => item.includes('/theme/'))) warnings.push('未找到主题定义，已使用 Pivot 默认颜色和字体。');
    return warnings;
}

async function readArchiveEntries(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_PPTX_TEMPLATE_BYTES) throw importError('PPTX 模板包为空或超过 20MB 限制。', 'PRESENTATION_PPTX_TEMPLATE_TOO_LARGE', 413);
    if (buffer.subarray(0, 2).toString() !== 'PK') throw importError('导入文件不是有效的 PPTX/OOXML 包。');
    let directory; try { directory = await unzipper.Open.buffer(buffer); } catch (_) { throw importError('PPTX 模板包无法解压。'); }
    const files = directory.files.filter(file => file.type === 'File');
    if (!files.length || files.length > MAX_PPTX_TEMPLATE_ENTRIES) throw importError('PPTX 模板包文件数量异常。');
    const uncompressedBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file.uncompressedSize ?? file.vars?.uncompressedSize ?? 0) || 0), 0);
    const compressedBytes = files.reduce((sum, file) => sum + Math.max(0, Number(file.compressedSize ?? file.vars?.compressedSize ?? 0) || 0), 0);
    if (uncompressedBytes > MAX_PPTX_TEMPLATE_UNCOMPRESSED_BYTES) throw importError('PPTX 模板解压后超过 12MB 限制。', 'PRESENTATION_PPTX_TEMPLATE_UNCOMPRESSED_TOO_LARGE', 413);
    if (compressedBytes && uncompressedBytes / compressedBytes > MAX_PPTX_TEMPLATE_COMPRESSION_RATIO) throw importError('PPTX 模板压缩比异常。', 'PRESENTATION_PPTX_TEMPLATE_COMPRESSION_RATIO', 413);
    const paths = files.map(file => file.path.replace(/\\/g, '/'));
    if (paths.some(filePath => /(^|\/)\.\.(\/|$)|^[\/\\]/.test(filePath)) || new Set(paths).size !== paths.length) throw importError('PPTX 模板包包含非法或重复路径。');
    return await Promise.all(files.map(async file => {
        const entryPath = file.path.replace(/\\/g, '/'); const itemBuffer = await file.buffer(); const isXml = /\.(xml|rels)$/i.test(entryPath);
        if (isXml && itemBuffer.length > MAX_PPTX_TEMPLATE_XML_BYTES) throw importError(`PPTX XML 文件超过大小限制：${entryPath}`, 'PRESENTATION_PPTX_TEMPLATE_XML_TOO_LARGE', 413);
        return { path: entryPath, buffer: itemBuffer, text: isXml ? itemBuffer.toString('utf8') : '' };
    }));
}

function buildReport(entries, report) {
    collectWarnings(entries).forEach(message => addReport(report, 'warning', 'PPTX_COMPATIBILITY_WARNING', 'package', message));
    return report;
}

function addFontAvailabilityReport(entries, theme, report) {
    const hasEmbeddedFont = entries.some(entry => /^ppt\/fonts\//i.test(entry.path));
    if (!hasEmbeddedFont) {
        addReport(report, 'warning', 'FONT_SUBSTITUTION_RISK', 'theme', `已识别标题字体“${theme.fonts.heading}”和正文字体“${theme.fonts.body}”，但 PPTX 未提供可受控嵌入字体；请在预览中核对替代效果或绑定字体素材。`);
    }
}

function applyImportMode(definition, mode) {
    if (mode !== 'editable') return definition;
    const unlock = elements => (elements || []).map(element => ({ ...element, locked: false }));
    return {
        ...definition,
        masters: (definition.masters || []).map(master => ({ ...master, decorations: unlock(master.decorations) })),
        layouts: (definition.layouts || []).map(layout => ({ ...layout, decorations: unlock(layout.decorations) }))
    };
}

async function importPptxTemplatePackage(buffer, options = {}) {
    const entries = await readArchiveEntries(buffer); const entriesByPath = new Map(entries.map(entry => [entry.path, entry])); const report = [];
    const contentTypes = entriesByPath.get('[Content_Types].xml')?.text || ''; const presentationEntry = entriesByPath.get('ppt/presentation.xml');
    if (!/presentationml\.presentation\.main\+xml/i.test(contentTypes) || !presentationEntry?.text) throw importError('文件不是演示文稿 PPTX。');
    const presentationDocument = parseXml(presentationEntry.text, presentationEntry.path); const canvas = canvasForSize(presentationDocument); const presentationRelationships = relationshipMap(entriesByPath, presentationEntry.path, report);
    const masterTargets = descendants(presentationDocument, 'sldMasterId').map(node => presentationRelationships.get(relationshipId(node))?.target).filter(Boolean);
    const fallbackMasters = entries.filter(entry => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(entry.path)).map(entry => entry.path);
    const masterPaths = [...new Set(masterTargets.length ? masterTargets : fallbackMasters)];
    if (!masterPaths.length) addReport(report, 'warning', 'MISSING_SLIDE_MASTER', 'ppt/presentation.xml', '未找到幻灯片母版，已使用受控默认布局。');
    let themeDocument = null;
    for (const masterPath of masterPaths) {
        const relationships = relationshipMap(entriesByPath, masterPath, report); const themeTarget = [...relationships.values()].find(item => /\/theme$/i.test(item.type))?.target;
        const entry = themeTarget ? entriesByPath.get(themeTarget) : null;
        if (entry?.text) { themeDocument = parseXml(entry.text, entry.path); break; }
    }
    if (!themeDocument) {
        const themeEntry = entries.find(entry => /^ppt\/theme\/theme\d+\.xml$/i.test(entry.path));
        if (themeEntry?.text) themeDocument = parseXml(themeEntry.text, themeEntry.path);
    }
    const extractedTheme = extractColorScheme(themeDocument); const fonts = extractFonts(themeDocument); const theme = { name: String(options.name || options.filename || '导入 PPTX 模板').replace(/\.pptx$/i, '').trim().slice(0, 120) || '导入 PPTX 模板', colors: extractedTheme.colors, fonts, chartPalette: [extractedTheme.colors.primary, extractedTheme.colors.secondary, extractedTheme.colors.accent, '#F59E0B', '#8B5CF6', '#EC4899'] };
    const assets = createAssetRegistry(entriesByPath, report); const masters = []; const layouts = []; const layoutIds = new Set(); const layoutsByPath = new Map();
    masterPaths.forEach((masterPath, masterIndex) => {
        const entry = entriesByPath.get(masterPath); if (!entry?.text) { addReport(report, 'warning', 'MISSING_SLIDE_MASTER', masterPath, '母版关系指向的 XML 不存在。'); return; }
        const masterDocument = parseXml(entry.text, entry.path); const relationships = relationshipMap(entriesByPath, entry.path, report); const layer = parseLayer(masterDocument, entry.path, relationships, canvas, theme, extractedTheme.palette, assets, report); const masterId = `master_${masterIndex + 1}`;
        masters.push({ id: masterId, name: layer.name || `母版 ${masterIndex + 1}`, background: layer.background, decorations: layer.decorations });
        addReport(report, 'info', 'IMPORTED_SLIDE_MASTER', entry.path, `已转换母版：${layer.name || masterId}。`);
        const layoutTargets = descendants(masterDocument, 'sldLayoutId').map(node => relationships.get(relationshipId(node))?.target).filter(Boolean);
        layoutTargets.forEach((layoutPath, layoutIndex) => {
            const layoutEntry = entriesByPath.get(layoutPath); if (!layoutEntry?.text) { addReport(report, 'warning', 'MISSING_SLIDE_LAYOUT', layoutPath, '布局关系指向的 XML 不存在。'); return; }
            const layoutDocument = parseXml(layoutEntry.text, layoutEntry.path); const layoutRelationships = relationshipMap(entriesByPath, layoutEntry.path, report); const layoutLayer = parseLayer(layoutDocument, layoutEntry.path, layoutRelationships, canvas, theme, extractedTheme.palette, assets, report); const name = layoutLayer.name || `导入布局 ${layouts.length + 1}`; const id = uniqueId(`layout_${masterIndex + 1}_${layoutIndex + 1}`, layoutIds); const legacyLayoutId = legacyLayoutIdForName(name, layouts.length);
            const layout = { id, name: name.slice(0, 120), category: categoryForName(name, layouts.length), slots: layoutLayer.placeholders.map(item => item.role), legacyLayoutId, masterId, placeholders: layoutLayer.placeholders, decorations: layoutLayer.decorations, defaultTransition: { type: 'none', durationMs: 0, direction: '' }, slotAnimations: {} };
            layouts.push(layout); layoutsByPath.set(layoutPath, layout);
            addReport(report, 'info', 'IMPORTED_SLIDE_LAYOUT', layoutPath, `已转换布局：${layout.name}，识别 ${layout.placeholders.length} 个可填充槽位。`);
        });
    });
    if (!layouts.length) {
        const fallback = parseLayouts(entries); layouts.push(...fallback); masters.push({ id: 'master_default', name: '默认母版', background: { fill: theme.colors.background, imageAssetKey: '', opacity: 1 }, decorations: [] });
    }
    applyExampleSlideMotion(presentationDocument, presentationRelationships, entriesByPath, layoutsByPath, report);
    addFontAvailabilityReport(entries, theme, report);
    const importMode = options.importMode === 'fidelity' ? 'fidelity' : 'editable';
    if (importMode === 'editable') addReport(report, 'info', 'EDITABLE_DECORATIONS', 'template', '已将可转换的母版和布局装饰保留为可编辑对象；修改后可能偏离原始视觉规范。');
    else addReport(report, 'info', 'LOCKED_DECORATIONS', 'template', '已将可转换的母版和布局装饰锁定，以优先保持原始视觉规范。');
    buildReport(entries, report);
    const warnings = report.filter(item => item.severity !== 'info').map(item => item.message);
    const definition = applyImportMode({
        schemaVersion: '2.0', theme, masters, layouts, assetRefs: [], brandControls: {},
        importMetadata: { sourceFormat: 'pptx', importMode, importedAt: new Date().toISOString(), warningCount: warnings.length, report }
    }, importMode);
    return {
        name: theme.name, aspectRatio: canvas.aspectRatio, warnings, report, assets: assets.assets,
        definition
    };
}

module.exports = {
    MAX_PPTX_TEMPLATE_UNCOMPRESSED_BYTES,
    MAX_PPTX_TEMPLATE_COMPRESSION_RATIO,
    importPptxTemplatePackage,
    parseLayouts
};
