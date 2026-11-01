'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness(responseType = 'image/svg+xml', config = null) {
    const created = [];
    const revoked = [];
    const requests = [];
    const toasts = [];
    let api;
    const document = { body: { classList: { add() {}, remove() {} }, appendChild: item => { created.push(item); } }, addEventListener() {}, removeEventListener() {}, createElement(tag) {
        const events = {};
        return { tag, style: {}, children: [], attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
            append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
            addEventListener(name, fn) { events[name] = fn; }, remove() { this.removed = true; }, events };
    } };
    const tasks = { renderEntry() {}, refresh: async () => {} };
    const context = { document, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: value => revoked.push(value) }, API_BASE: '/api',
        AbortController, setTimeout, clearTimeout, showToast: text => toasts.push(text),
        PivotSafeHtml: { setSrcdoc(frame, html) { frame.srcdoc = html; } },
        apiFetch: async url => { requests.push(url); if (url.endsWith('/onlyoffice-preview')) return { ok: true, json: async () => ({ onlyoffice: config }) };
            if (url.endsWith('/document-preview')) return { ok: true, json: async () => ({ html: '<h1>旅行方案</h1>', imagePlaceholders: false }) };
            return url.endsWith('/download-token')
            ? { ok: true, json: async () => ({ token: 'one-use' }) }
            : { ok: true, blob: async () => ({ type: responseType }) }; },
        window: { Pivot: { legacy: {}, moduleApi: () => tasks, exposeModule: (_name, exposed) => { api = exposed; } } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/chat-task-actions.js'), 'utf8'), context);
    return { api, created, revoked, requests, toasts, window: context.window, context };
}

test('查看图形读取已授权渲染文件，图片关闭后释放临时地址', async () => {
    const h = harness();
    const entry = { state: { artifacts: [{ id: '106', title: '结构图', rendition: { id: '13', format: 'svg', ready: true } }] } };
    await h.api.perform(entry, 'preview', { dataset: { taskArtifact: '106', taskRendition: '13' } });
    assert.deepEqual(h.requests, ['/api/agents/renditions/13/download-token', '/api/agents/renditions/13/download?token=one-use']);
    assert.equal(h.created[0].children[1].children[1].src, 'blob:test');
    assert.equal(h.created[0].children[1].children[1].tag, 'img');
    h.created[0].children[0].children[1].events.click();
    assert.deepEqual(h.revoked, ['blob:test']);
});

test('DOCX 未配置 ONLYOFFICE 时展示隔离的文档预览，不显示内部 JSON', async () => {
    const h = harness();
    const entry = { state: { artifacts: [{ id: '106', title: '旅行方案', rendition: { id: '13', format: 'docx', ready: true } }] } };
    await h.api.perform(entry, 'preview', { dataset: { taskArtifact: '106', taskRendition: '13' } });
    assert.deepEqual(h.requests, ['/api/agents/renditions/13/onlyoffice-preview', '/api/agents/renditions/13/document-preview']);
    assert.equal(h.created[0].children[1].children[1].tag, 'iframe');
    assert.equal(h.created[0].children[1].children[1].attributes.sandbox, '');
    assert.match(h.created[0].children[1].children[1].srcdoc, /旅行方案/);
    assert.match(h.created[0].children[1].children[0].textContent, /分页与字体/);
});

test('配置 ONLYOFFICE 时打开只读编辑器，关闭时释放实例', async () => {
    const config = { scriptUrl: '/onlyoffice/web-apps/apps/api/documents/api.js', editor: { editorConfig: { mode: 'view' } } };
    const h = harness('image/svg+xml', config);
    let created;
    let destroyed = false;
    h.window.DocsAPI = { DocEditor: function(id, editor) { created = { id, editor }; this.destroyEditor = () => { destroyed = true; }; } };
    const entry = { state: { artifacts: [{ id: '106', title: '旅行方案', rendition: { id: '13', format: 'docx', ready: true } }] } };
    await h.api.perform(entry, 'preview', { dataset: { taskArtifact: '106', taskRendition: '13' } });
    assert.equal(h.requests.length, 1);
    assert.equal(created.editor.editorConfig.mode, 'view');
    assert.match(created.id, /^onlyoffice-preview-/);
    h.created[0].children[0].children[1].events.click();
    assert.equal(destroyed, true);
});

test('意外的内容类型不展示为图片', async () => {
    const h = harness('text/html');
    const entry = { state: { artifacts: [{ id: '106', rendition: { id: '13', format: 'svg', ready: true } }] } };
    await h.api.perform(entry, 'preview', { dataset: { taskArtifact: '106', taskRendition: '13' } });
    assert.equal(h.created[0].children[1].children[0].textContent, '结果文件不是受支持的图片格式。');
    assert.match(h.toasts[0], /不是受支持的图片/);
});

test('切换到新文件后，旧预览的迟到失败不会覆盖新面板或弹出错误', async () => {
    const h = harness();
    const originalFetch = h.context.apiFetch;
    let rejectOld;
    h.context.apiFetch = url => url.includes('/renditions/11/') ? new Promise((_resolve, reject) => { rejectOld = reject; }) : originalFetch(url);
    const entry = { state: { artifacts: [
        { id: '1', title: '旧图', rendition: { id: '11', format: 'svg', ready: true } },
        { id: '2', title: '新文档', rendition: { id: '13', format: 'docx', ready: true } }
    ] } };
    const old = h.api.perform(entry, 'preview', { dataset: { taskArtifact: '1', taskRendition: '11' } });
    await h.api.perform(entry, 'preview', { dataset: { taskArtifact: '2', taskRendition: '13' } });
    rejectOld(new Error('旧请求失败'));
    await old;
    assert.equal(h.created[0].removed, true);
    assert.equal(h.created[1].children[0].children[0].textContent, '新文档');
    assert.deepEqual(h.toasts, []);
});
