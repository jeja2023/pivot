'use strict';
/* global window, document, performance */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const schema = require('../client/common/mindmap-document');
const { queryOne, execute } = require('../server/db/client');
const documents = require('../server/services/mindmaps/documents');
function largeTree() {
    let index = 0; const tree = { id: 'root', text: '企业项目总览', children: [] }; const queue = [tree];
    let branch = tree; for (let depth = 1; depth <= 12; depth++) { const child = { id: `n${++index}`, text: `第 ${depth} 层验证`, children: [] }; branch.children.push(child); branch = child; }
    for (let cursor = 0; index < 4999; cursor++) { const parent = queue[cursor]; while (parent.children.length < 6 && index < 4999) { const child = { id: `n${++index}`, text: `中文😀计划 ${index}`, children: [] }; parent.children.push(child); queue.push(child); } }
    return schema.normalize(tree);
}
test('5000 节点和 12 层经过保存、CRDT 和格式往返，缩略图按版本缓存并保护共享权限', { timeout: 45000 }, async () => {
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status,created_at) VALUES(?,?,'user','active',NOW()) RETURNING id", [`capacity_${crypto.randomUUID()}`, 'test-hash']);
    let saved;
    try {
        const input = largeTree(); assert.equal(schema.count(input), 5000);
        assert.deepEqual(schema.fromEngine(schema.toEngine(input)), input);
        saved = await documents.save(user, { document: input, requestKey: crypto.randomUUID() });
        assert.deepEqual((await documents.get(user, saved.id)).document, input);
        const crdt = require('../client/common/mindmap-crdt'); const state = crdt.create(); crdt.write(state, input); const copy = crdt.create(); crdt.apply(copy, crdt.encode(state)); assert.deepEqual(crdt.read(copy), input); state.destroy(); copy.destroy();
        const formats = require('../server/services/mindmaps/formats');
        for (const format of ['opml', 'mm']) assert.deepEqual((await formats.importDocument({ format, content: formats.exportXml(input, format) })).tree, input.tree);
        assert.deepEqual((await formats.importDocument({ format: 'xmind', contentBase64: (await formats.exportXmind(input)).toString('base64') })).tree, input.tree);
        const previews = require('../server/services/mindmaps/previews'); const first = await previews.get(user, saved.id); assert.ok(first.length < 65536); assert.equal((await require('sharp')(first).metadata()).width, 480);
        assert.deepEqual(await previews.get(user, saved.id), first); assert.equal((await queryOne('SELECT version_id FROM mindmap_thumbnails WHERE artifact_id=?', [saved.id])).version_id, Number(saved.versionId));
        input.tree.text = '更新后的项目'; const next = await documents.save(user, { artifactId: saved.id, expectedVersionId: saved.versionId, document: input, requestKey: crypto.randomUUID() });
        assert.notDeepEqual(await previews.get(user, saved.id), first);
        await documents.remove(user, saved.id, next.versionId); await assert.rejects(previews.get(user, saved.id), error => error.status === 404);
    } finally { if (saved) await execute('DELETE FROM agent_artifacts WHERE id=?', [saved.id]); await execute('DELETE FROM users WHERE id=?', [user.id]); }
});
test('真实浏览器打开 5000 节点、编辑中文并撤销，布局与导出资源遵守 CSP', { timeout: 90000 }, async () => {
    const app = express(); app.use('/common', express.static(path.resolve('client/common'))); app.use('/chat', express.static(path.resolve('client/chat')));
    app.get('/', (_req, res) => { res.set('Content-Security-Policy', "script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'"); res.send('<meta charset="utf-8"><div id="map" style="width:1200px;height:800px"></div><script src="/fixture.js"></script><script src="/common/mindmap-document.js"></script>'); });
    app.get('/fixture.js', (_req, res) => res.type('js').send('window.Pivot={modules:{},exposeModule(k,v){this.modules[k]=v},moduleApi(k){return this.modules[k]}};'));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const { chromium } = require('playwright'); const browser = await chromium.launch({ headless: true, executablePath: require('../server/services/agent-browser').resolveChromiumExecutable(chromium) });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const result = await page.evaluate(async input => {
            const { mount } = await import('/chat/mindmaps/editor.mjs'); const started = performance.now();
            let edited; let failure; window.capacityEditor = mount(document.querySelector('#map'), input, { change(value) { edited = value; }, select() {}, failure(error) { failure = error.message; } });
            while (!document.querySelector('.smm-node')) await new Promise(resolve => setTimeout(resolve, 20));
            await new Promise(resolve => setTimeout(resolve, 150)); const openMs = performance.now() - started;
            window.capacityEditor.focus('root'); const editStart = performance.now(); window.capacityEditor.apply({ text: '中文性能验收' });
            while (window.capacityEditor.document().tree.text !== '中文性能验收') await new Promise(resolve => setTimeout(resolve, 20));
            const editMs = performance.now() - editStart; const count = window.Pivot.moduleApi('mindmaps.document').count(edited);
            window.capacityEditor.command('BACK'); await new Promise(resolve => setTimeout(resolve, 350));
            return { openMs, editMs, count, restored: window.capacityEditor.document().tree.text, failure };
        }, largeTree());
        assert.equal(result.failure, undefined); assert.equal(result.count, 5000); assert.equal(result.restored, '企业项目总览'); assert.ok(result.openMs < 12000, JSON.stringify(result)); assert.ok(result.editMs < 4000, JSON.stringify(result)); assert.deepEqual(errors, []);
        await fs.mkdir('output/mindmaps', { recursive: true }); await page.screenshot({ path: 'output/mindmaps/capacity-5000.png' }); await fs.writeFile('output/mindmaps/capacity-5000.json', JSON.stringify(result, null, 2));
        await page.evaluate(() => window.capacityEditor.destroy());
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
test('5000 节点大图可交付完整安全 SVG，位图尺寸有界', { timeout: 90000 }, async () => {
    const input = largeTree(); const renderer = require('../server/services/mindmaps/renderer');
    const output = await renderer.render(input, 'svg'); const svg = output.buffer.toString('utf8');
    assert.equal(output.mimeType, 'image/svg+xml'); assert.ok(svg.includes('企业项目总览')); assert.ok(svg.includes('4999')); assert.ok(output.buffer.length < 16 * 1024 * 1024); assert.ok(!svg.includes('foreignObject'));
    const png = await renderer.render(input, 'png'); const dimensions = await require('sharp')(png.buffer).metadata(); assert.ok(dimensions.width <= 4000 && dimensions.height <= 4000);
    await fs.mkdir('output/mindmaps', { recursive: true }); await fs.writeFile('output/mindmaps/capacity-export.png', png.buffer);
});
