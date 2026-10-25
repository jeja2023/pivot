'use strict';
/* global window */
const fs = require('node:fs');
const path = require('node:path');
const parse5 = require('parse5');
const schema = require('../../../client/common/mindmap-document');
const { sanitizeSvg, renderImage } = require('../document-rendering/image-renderer');
const SVG_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxNodes: 150000 });
function normalizeSvg(source) {
    const fragment = parse5.parseFragment(source);
    function stripEditorMetadata(node) {
        node.attrs = (node.attrs || []).filter(attribute => !['xmlns:svgjs', 'svgjs:data'].includes(attribute.name));
        // 图形交付保留链接图标但不包含可跳转的外部地址，原生源稿仍保存链接。
        if (node.tagName === 'a') { node.tagName = 'g'; node.nodeName = 'g'; node.attrs = []; }
        for (const child of node.childNodes || []) stripEditorMetadata(child);
    }
    stripEditorMetadata(fragment);
    return sanitizeSvg(parse5.serialize(fragment), SVG_LIMITS);
}
async function renderSvg(input) {
    const document = schema.normalize(input);
    const { chromium } = require('playwright');
    const executablePath = require('../agent-browser').resolveChromiumExecutable(chromium);
    if (!executablePath) throw schema.error('导出浏览器不可用，请联系管理员检查浏览器运行环境。', 'MINDMAP_RENDERER_UNAVAILABLE', 503);
    const vendor = path.resolve(__dirname, '../../../client/common/vendor/simple-mind-map/0.14.0-fix.3/editor.mjs');
    const source = await fs.promises.readFile(vendor);
    const html = '<!doctype html><meta charset="utf-8"><style>body{margin:0}#map{width:1440px;height:900px}#map *{margin:0;padding:0}</style><div id="map"></div><script type="module" src="/render.js"></script>';
    const script = "import MindMap from '/editor.js';window.renderMap=(native,palette)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('导图渲染超时')),60000);let finished=false;const map=new MindMap({el:document.querySelector('#map'),data:native.root,layout:native.layout,readonly:true,themeConfig:{backgroundColor:palette.background,lineColor:palette.line,root:{fillColor:palette.root,color:palette.rootText,...palette.styles?.root},second:{fillColor:palette.background,color:palette.nodeText,...palette.styles?.second},node:{fillColor:palette.background,color:palette.nodeText,...palette.styles?.node}},errorHandler:()=>{clearTimeout(timer);reject(new Error('导图渲染失败'))}});map.on('node_tree_render_end',async()=>{if(finished)return;finished=true;try{const data=await map.export('svg',false,'思维导图');clearTimeout(timer);resolve(data)}catch(e){clearTimeout(timer);reject(e)}})});";
    const browser = await chromium.launch({ headless: true, executablePath, args: ['--disable-dev-shm-usage'] });
    // 浏览器主线程繁忙时页面内计时器也会延迟，外层截止时间负责回收渲染进程。
    const deadline = setTimeout(() => { void browser.close().catch(() => {}); }, 65000).unref();
    try {
        const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin !== 'http://pivot-mindmap.invalid') return route.abort();
            const resource = { '/': ['text/html', html], '/render.js': ['text/javascript', script], '/editor.js': ['text/javascript', source] }[url.pathname];
            return resource ? route.fulfill({ contentType: resource[0], body: resource[1] }) : route.abort();
        });
        const page = await context.newPage(); page.setDefaultTimeout(65000);
        await page.goto('http://pivot-mindmap.invalid/');
        const native = schema.toEngine(document);
        const palette = schema.palette(document);
        const dataUrl = await page.evaluate(({ native, palette }) => window.renderMap(native, palette), { native, palette: { ...palette, rootText: schema.foreground(palette.root), nodeText: schema.foreground(palette.background) } });
        if (typeof dataUrl !== 'string' || dataUrl.length > 24 * 1024 * 1024) throw schema.error('导出图形过大，请折叠或减少分支。');
        return normalizeSvg(Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8'));
    } finally { clearTimeout(deadline); await browser.close(); }
}
async function render(document, format) {
    if (!require('./formats').EXPORT_FORMATS.includes(format)) throw schema.error('导出格式不受支持。');
    if (format === 'json') return { buffer: Buffer.from(JSON.stringify(schema.normalize(document), null, 2)), mimeType: 'application/json; charset=utf-8' };
    if (format === 'md') return { buffer: Buffer.from(schema.markdown(document)), mimeType: 'text/markdown; charset=utf-8' };
    if (format === 'opml' || format === 'mm') return { buffer: Buffer.from(require('./formats').exportXml(document, format)), mimeType: 'application/xml; charset=utf-8' };
    if (format === 'xmind') return { buffer: await require('./formats').exportXmind(document), mimeType: 'application/x-xmind' };
    const svg = Buffer.from(await renderSvg(document));
    if (format === 'svg') return { buffer: svg, mimeType: 'image/svg+xml' };
    const fragment = parse5.parseFragment(svg.toString('utf8')); const root = fragment.childNodes.find(node => node.tagName === 'svg');
    const attribute = name => root.attrs.find(attribute => attribute.name === name);
    const width = Number.parseFloat(attribute('width')?.value); const height = Number.parseFloat(attribute('height')?.value);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw schema.error('导出尺寸无效。');
    const scale = Math.min(1, 4000 / width, 4000 / height);
    attribute('width').value = String(Math.max(1, Math.floor(width * scale))); attribute('height').value = String(Math.max(1, Math.floor(height * scale)));
    const scaled = Buffer.from(parse5.serialize(fragment));
    const png = await renderImage({ blocks: [{ type: 'image', asset_ref: 'mindmap' }] }, 'png', { imageResolver: async () => scaled, maxInputBytes: SVG_LIMITS.maxBytes, svgLimits: SVG_LIMITS });
    if (format === 'pdf') {
        const ref = 'artifact-cas://' + require('crypto').createHash('sha256').update(png).digest('hex');
        const result = await require('../document-rendering').renderDocumentIr({ ir_version: '1', doc_type: 'report', meta: { title: schema.normalize(document).tree.text, page: { size: 'A3', orientation: 'landscape' } }, blocks: [{ type: 'image', asset_ref: ref }] }, 'pdf', { imageResolver: async () => png });
        return { buffer: result.buffer, mimeType: result.mimeType };
    }
    return { buffer: png, mimeType: 'image/png' };
}
module.exports = { render };
