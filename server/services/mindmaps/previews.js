'use strict';
const schema = require('../../../client/common/mindmap-document');
const documents = require('./documents');
const repository = require('../../repositories/mindmap-previews');
const { sanitizeSvg } = require('../document-rendering/image-renderer');
const RENDERER = 'preview-1';
const pending = new Map();
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
async function render(document) {
    const palette = schema.palette(document); const root = document.tree;
    const branches = root.children.slice(0, 8); const count = schema.count(document);
    const line = (text, x, y, size, color) => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}">${escape(Array.from(text).slice(0, 18).join(''))}</text>`;
    const items = branches.map((node, index) => { const y = 45 + index * 32; return `<path d="M 180 150 H 220 V ${y} H 250" fill="none" stroke="${palette.line}" stroke-width="2"/>${line(node.text, 260, y + 5, 14, schema.foreground(palette.background))}`; }).join('');
    const svg = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300"><rect width="480" height="300" fill="${palette.background}"/><rect x="12" y="125" width="170" height="50" rx="8" fill="${palette.root}"/>${line(root.text, 22, 154, 15, schema.foreground(palette.root))}${items}${line(`${count} 个节点${root.children.length > 8 ? ' · 更多分支已省略' : ''}`, 16, 285, 12, schema.foreground(palette.background))}</svg>`);
    const buffer = await require('sharp')(Buffer.from(svg)).png().toBuffer();
    if (buffer.length > 65536) throw schema.error('缩略图超过缓存上限。');
    return buffer;
}
async function get(user, id) {
    const current = await documents.get(user, id);
    const cached = await repository.get(current.id, current.versionId, RENDERER);
    if (cached) return cached.content;
    const key = `${current.id}:${current.versionId}`;
    if (!pending.has(key)) {
        if (pending.size >= 8) throw schema.error('缩略图正在生成，请稍后刷新。', 'MINDMAP_PREVIEW_BUSY', 429);
        pending.set(key, (async () => { const content = await render(current.document); await repository.put(current.id, current.versionId, RENDERER, content); return content; })().finally(() => pending.delete(key)));
    }
    const buffer = await pending.get(key);
    await documents.get(user, id);
    return buffer;
}
module.exports = { get };
