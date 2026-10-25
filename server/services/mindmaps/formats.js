'use strict';
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const schema = require('../../../client/common/mindmap-document');
const MAX_ARCHIVE = 2 * 1024 * 1024;
const MAX_EXPANDED = 8 * 1024 * 1024;
const EXPORT_FORMATS = Object.freeze(['json', 'md', 'svg', 'png', 'pdf', 'xmind', 'opml', 'mm']);
const escapeXml = value => String(value ?? '').replace(/[&<>"'\r\n]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;', '\n': '&#10;' }[char]));
function children(node, name) { return [...Array.from(node.childNodes || [])].filter(child => child.nodeType === 1 && (!name || child.localName === name)); }
function one(node, name) { return children(node, name)[0]; }
function parseXml(source) {
    if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_EXPANDED || /<!DOCTYPE|<!ENTITY/i.test(source)) throw schema.error('XML 包含不允许的声明或超过大小限制。');
    let document;
    try { document = new DOMParser({ onError: () => { throw new Error('XML 无效'); } }).parseFromString(source, 'application/xml'); }
    catch (_) { throw schema.error('XML 文件结构无效，请检查后重试。'); }
    let count = 0;
    function inspect(node, depth = 0) { if (++count > 50000 || depth > 64) throw schema.error('XML 结构过大或嵌套过深。'); for (const child of Array.from(node.childNodes || [])) inspect(child, depth + 1); }
    inspect(document);
    return document.documentElement;
}
function makeImport() {
    let sequence = 0; const used = new Set(); const styles = {}; const relations = []; const summaries = [];
    function id(value) {
        const result = value || `import-${++sequence}`;
        if (typeof result !== 'string' || !/^[\w-]{1,64}$/.test(result) || ['__proto__', 'prototype', 'constructor'].includes(result) || used.has(result)) throw schema.error('文件包含重复或无效的节点标识。');
        used.add(result); return result;
    }
    function finish(tree, layout = 'mindMap', themeId = 'indigo') { return schema.normalize({ schemaVersion: 1, tree, presentation: { layout, themeId, nodes: styles }, relations, summaries }); }
    return { id, styles, relations, summaries, finish };
}
function importXml(source, format) {
    const root = parseXml(source); const imported = makeImport(); let count = 0;
    const outlines = format === 'opml' ? children(one(root, 'body') || {}, 'outline') : children(root, 'node');
    if ((format === 'opml' ? root.localName !== 'opml' : root.localName !== 'map') || outlines.length !== 1) throw schema.error('请选择包含一个中心主题的 OPML 或 FreeMind 文件。');
    function walk(node, depth = 0) {
        if (++count > schema.LIMITS.nodes || depth > schema.LIMITS.depth) throw schema.error('导入节点数量或层级超过当前限制。');
        const attrs = name => node.getAttribute(name) || '';
        const id = imported.id(attrs(format === 'opml' ? '_id' : 'ID'));
        if (children(node, 'richcontent').some(content => content.getAttribute('TYPE') === 'NODE')) throw schema.error('暂不支持 FreeMind 富文本节点，请转为纯文本后导入。');
        const text = attrs(format === 'opml' ? 'text' : 'TEXT');
        const style = {};
        if (attrs('COLOR')) style.color = attrs('COLOR'); if (attrs('BACKGROUND_COLOR')) style.fillColor = attrs('BACKGROUND_COLOR');
        const note = attrs('_note') || children(node, 'richcontent').find(content => content.getAttribute('TYPE') === 'NOTE')?.textContent;
        if (note) style.note = note;
        if (attrs('FOLDED') === 'true' || attrs('_expanded') === 'false') style.expanded = false;
        const link = attrs(format === 'opml' ? '_url' : 'LINK'); if (link) style.hyperlink = link;
        const font = one(node, 'font'); if (font?.getAttribute('SIZE')) style.fontSize = Number(font.getAttribute('SIZE')); if (font?.getAttribute('BOLD') === 'true') style.fontWeight = 'bold';
        imported.styles[id] = style;
        for (const arrow of children(node, 'arrowlink')) imported.relations.push({ from: id, to: arrow.getAttribute('DESTINATION'), text: arrow.getAttribute('MIDDLE_LABEL') || '' });
        return { id, text, children: children(node, format === 'opml' ? 'outline' : 'node').map(child => walk(child, depth + 1)) };
    }
    return imported.finish(walk(outlines[0]));
}
function exportXml(document, format) {
    document = schema.normalize(document);
    function walk(node) {
        const style = document.presentation.nodes[node.id] || {};
        if (format === 'opml') return `<outline text="${escapeXml(node.text)}" _id="${node.id}"${style.note ? ` _note="${escapeXml(style.note)}"` : ''}${style.hyperlink ? ` _url="${escapeXml(style.hyperlink)}"` : ''}${style.expanded === false ? ' _expanded="false"' : ''}>${node.children.map(walk).join('')}</outline>`;
        const attrs = [`ID="${node.id}"`, `TEXT="${escapeXml(node.text)}"`];
        if (style.color) attrs.push(`COLOR="${style.color}"`); if (style.fillColor) attrs.push(`BACKGROUND_COLOR="${style.fillColor}"`); if (style.expanded === false) attrs.push('FOLDED="true"'); if (style.hyperlink) attrs.push(`LINK="${escapeXml(style.hyperlink)}"`);
        const font = style.fontSize || style.fontWeight ? `<font${style.fontSize ? ` SIZE="${style.fontSize}"` : ''}${style.fontWeight === 'bold' ? ' BOLD="true"' : ''}/>` : '';
        const note = style.note ? `<richcontent TYPE="NOTE"><html><head/><body><p>${escapeXml(style.note)}</p></body></html></richcontent>` : '';
        const arrows = document.relations.filter(line => line.from === node.id).map(line => `<arrowlink DESTINATION="${line.to}" MIDDLE_LABEL="${escapeXml(line.text)}"/>`).join('');
        return `<node ${attrs.join(' ')}>${font}${note}${arrows}${node.children.map(walk).join('')}</node>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>${format === 'opml' ? `<opml version="2.0"><head><title>${escapeXml(document.tree.text)}</title></head><body>${walk(document.tree)}</body></opml>` : `<map version="1.0.1">${walk(document.tree)}</map>`}`;
}
function boundedZipEntry(entry) {
    return new Promise((resolve, reject) => {
        const chunks = []; let bytes = 0;
        const stream = entry.internalStream('nodebuffer');
        stream.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_EXPANDED) { stream.pause(); reject(schema.error('XMind 解压内容超过限制。')); } else chunks.push(chunk); });
        stream.on('error', () => reject(schema.error('XMind 文件损坏或无法解压。'))); stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); stream.resume();
    });
}
async function importXmind(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_ARCHIVE) throw schema.error('XMind 文件为空或超过 2MiB。');
    let zip; try { zip = await JSZip.loadAsync(buffer); } catch (_) { throw schema.error('XMind 压缩文件无效。'); }
    const entries = Object.values(zip.files); let size = 0;
    if (entries.length > 128) throw schema.error('XMind 文件包含过多条目。');
    for (const entry of entries) {
        if (/\\|(^|\/)\.\.\/|^\/|:/.test(entry.unsafeOriginalName || entry.name)) throw schema.error('XMind 文件包含不安全的条目路径。');
        size += entry._data?.uncompressedSize || 0;
        if (size > MAX_EXPANDED) throw schema.error('XMind 解压后的总大小超过 4MiB。');
    }
    if (!zip.file('content.json')) throw schema.error('暂支持包含 content.json 的现代 XMind 文件，请使用 XMind 转存后导入。');
    let sheets; try { sheets = JSON.parse(await boundedZipEntry(zip.file('content.json'))); } catch (error) { throw error.expose ? error : schema.error('XMind 内容数据无效。'); }
    if (!Array.isArray(sheets) || sheets.length !== 1 || !sheets[0]?.rootTopic) throw schema.error('请选择只包含一个画布的 XMind 文件。');
    const sheet = sheets[0]; const imported = makeImport(); let count = 0;
    function walk(topic, depth = 0) {
        if (++count > schema.LIMITS.nodes || depth > schema.LIMITS.depth) throw schema.error('XMind 节点数量或层级超过限制。');
        if (!topic || typeof topic !== 'object' || topic.image || topic.notes?.realHTML && !topic.notes.plain || topic.children?.detached?.length || topic.labels?.length) throw schema.error('XMind 包含图片、富文本、标签或自由节点，请转换为兼容的纯文本导图。');
        const id = imported.id(topic.id); const style = {};
        if (topic.notes?.plain?.content) style.note = topic.notes.plain.content;
        if (topic.href) style.hyperlink = topic.href;
        if (topic.branch === 'folded') style.expanded = false;
        const properties = topic.style?.properties || {};
        if (properties['fo:color']) style.color = properties['fo:color']; if (properties['svg:fill']) style.fillColor = properties['svg:fill'];
        imported.styles[id] = style;
        const attached = topic.children?.attached || [];
        if (!Array.isArray(attached)) throw schema.error('XMind 子节点格式无效。');
        for (const summary of topic.summaries || []) {
            const match = /^\((\d+),(\d+)\)$/.exec(summary.range || '');
            const label = topic.children?.summary?.find(item => item.id === summary.topicId)?.title;
            if (!match || typeof label !== 'string') throw schema.error('XMind 概要范围无效。');
            imported.summaries.push({ id: summary.topicId, parentId: id, start: Number(match[1]), end: Number(match[2]), text: label });
        }
        return { id, text: topic.title, children: attached.map(child => walk(child, depth + 1)) };
    }
    const tree = walk(sheet.rootTopic);
    for (const line of sheet.relationships || []) imported.relations.push({ from: line.end1Id, to: line.end2Id, text: line.title || '' });
    return imported.finish(tree, { 'org.xmind.ui.logic.right': 'logicalStructure', 'org.xmind.ui.logic.left': 'logicalStructureLeft', 'org.xmind.ui.org-chart.down': 'organizationStructure' }[sheet.rootTopic.structureClass] || 'mindMap');
}
async function exportXmind(document) {
    document = schema.normalize(document);
    function walk(node, root = false) {
        const style = document.presentation.nodes[node.id] || {};
        const topic = { id: node.id, class: 'topic', title: node.text, children: { attached: node.children.map(child => walk(child)) } };
        if (root) topic.structureClass = { logicalStructure: 'org.xmind.ui.logic.right', logicalStructureLeft: 'org.xmind.ui.logic.left', organizationStructure: 'org.xmind.ui.org-chart.down' }[document.presentation.layout] || 'org.xmind.ui.map.unbalanced';
        if (style.note) topic.notes = { plain: { content: style.note } }; if (style.hyperlink) topic.href = style.hyperlink; if (style.expanded === false) topic.branch = 'folded';
        if (style.color || style.fillColor) topic.style = { properties: { ...(style.color ? { 'fo:color': style.color } : {}), ...(style.fillColor ? { 'svg:fill': style.fillColor } : {}) } };
        const summaries = document.summaries.filter(summary => summary.parentId === node.id);
        if (summaries.length) { topic.children.summary = summaries.map(summary => ({ id: summary.id, class: 'topic', title: summary.text })); topic.summaries = summaries.map(summary => ({ topicId: summary.id, range: `(${summary.start},${summary.end})` })); }
        return topic;
    }
    const sheetId = 'pivot-sheet';
    const sheet = { id: sheetId, class: 'sheet', title: document.tree.text, rootTopic: walk(document.tree, true), relationships: document.relations.map((line, index) => ({ id: `relation-${index}`, end1Id: line.from, end2Id: line.to, title: line.text })) };
    const zip = new JSZip(); const date = new Date('2020-01-01T00:00:00Z');
    for (const [name, content] of Object.entries({ 'content.json': [sheet], 'metadata.json': { dataStructureVersion: '2', creator: { name: 'Pivot' }, activeSheetId: sheetId }, 'manifest.json': { 'file-entries': { 'content.json': {}, 'metadata.json': {} } } })) zip.file(name, JSON.stringify(content), { date });
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
async function importDocument(input) {
    const { format, content, contentBase64 } = input;
    if (format === 'xmind') {
        if (typeof contentBase64 !== 'string' || contentBase64.length > Math.ceil(MAX_ARCHIVE / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(contentBase64)) throw schema.error('XMind 文件编码无效或超过大小上限。');
        return importXmind(Buffer.from(contentBase64, 'base64'));
    }
    if (typeof content !== 'string' || Buffer.byteLength(content) > schema.LIMITS.bytes) throw schema.error('导入文件为空或超过 4MiB。');
    if (format === 'json') return schema.normalize(content);
    if (format === 'markdown') return schema.parseMarkdown(content);
    if (['opml', 'mm'].includes(format)) return importXml(content, format);
    throw schema.error('请选择 JSON、Markdown、OPML、FreeMind 或 XMind 文件。');
}
module.exports = { EXPORT_FORMATS, importDocument, exportXml, exportXmind };
