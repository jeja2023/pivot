'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    const pending = [], renders = [], copied = [], nodes = new Map(), classes = new Set();
    const node = id => { if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', focus() {}, replaceChildren() { this.textContent = ''; }, querySelectorAll: () => [] }); return nodes.get(id); };
    const modal = { contains: () => false, querySelector: node, querySelectorAll: () => [],
        classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } };
    const context = { window: { Pivot: { legacy: { currentUser: { id: 1 } }, ArtifactRenderer: class { render(_target, artifact) { renders.push(artifact.id); } } }, addEventListener() {}, location: { origin: 'http://localhost' } },
        document: { getElementById: () => modal, activeElement: { isConnected: true, focus() {} }, addEventListener() {} }, console,
        PivotSafeHtml: { setHtml: (target, html) => { target.textContent = html; } }, confirm: () => true,
        navigator: { clipboard: { writeText: async value => copied.push(value) } },
        apiFetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve })) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/artifact-viewer.js'), 'utf8'), context);
    const viewer = context.window.Pivot.ArtifactViewer;
    viewer.switchTab = () => {};
    const finish = (index, artifact) => pending[index].resolve({ ok: true, json: async () => ({ success: true, data: artifact }) });
    return { viewer, context, pending, finish, renders, copied, node };
}

test('A 到 B 乱序返回、关闭后重开同一产物，都不恢复旧编辑周期', async () => {
    const h = harness(), a = h.viewer.open('A'), b = h.viewer.open('B');
    h.finish(1, { id: 'B', content: '乙' }); await b;
    h.finish(0, { id: 'A', content: '甲' }); await a;
    assert.deepEqual(h.renders, ['B']); assert.equal(h.viewer.currentArtifact.id, 'B');
    const older = h.viewer.open('C'); h.viewer.close(); const newer = h.viewer.open('C');
    h.finish(3, { id: 'C', content: '新周期' }); await newer;
    h.finish(2, { id: 'C', content: '旧周期' }); await older;
    assert.equal(h.viewer.currentArtifact.content, '新周期');
});

test('保存和回滚携带原版本，迟到响应不覆盖另一产物，保存中的新输入保留', async () => {
    const h = harness(); h.viewer.openPreview({ id: 'A', content: '原文', version: 3 });
    const editor = h.node('#pivot-artifact-source-editor'); editor.value = '提交快照';
    const save = h.viewer.handleSaveVersion();
    assert.equal(JSON.parse(h.pending[0].options.body).expectedVersion, 3);
    editor.value = '提交之后的新输入'; h.finish(0, { id: 'A', content: '提交快照', version: 4 }); await save;
    assert.equal(editor.value, '提交之后的新输入'); assert.equal(h.viewer.currentArtifact.version, 4);
    const restore = h.viewer.restoreVersion(1); h.viewer.openPreview({ id: 'B', content: '乙', version: 1 });
    h.finish(1, { id: 'A', content: '历史甲', version: 5 }); await restore;
    assert.equal(h.viewer.currentArtifact.id, 'B');
});

test('账号切换使读响应和分享剪贴板副作用失效', async () => {
    const h = harness(), open = h.viewer.open('A');
    h.context.window.Pivot.legacy.currentUser = { id: 2 };
    h.finish(0, { id: 'A', content: '其他账号正文' }); await open;
    assert.equal(h.viewer.currentArtifact, null);
    h.viewer.openPreview({ id: 'B', content: '乙', version: 1 });
    const share = h.viewer.handleShare(); h.viewer.close();
    h.finish(1, { shareUrl: '/artifacts/shared/1' }); await share;
    assert.deepEqual(h.copied, []);
});

test('同一编辑周期切换预览和源码不会清空未保存输入', () => {
    const h = harness(); h.viewer.openPreview({ id: 'A', content: '原稿', version: 1 });
    const switchTab = Object.getPrototypeOf(h.viewer).switchTab;
    switchTab.call(h.viewer, 'source');
    const editor = h.node('#pivot-artifact-source-editor'); editor.value = '尚未保存的新输入';
    switchTab.call(h.viewer, 'preview'); switchTab.call(h.viewer, 'source');
    assert.equal(editor.value, '尚未保存的新输入');
});
