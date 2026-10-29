'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/chat/agent-skill-import.js'), 'utf8');

function fixture(handler) {
    const elements = new Map();
    for (const id of ['source', 'title', 'description', 'tools', 'preview', 'submit', 'status', 'review']) {
        const item = { value: '', textContent: '', disabled: false, files: [], options: [], handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, append(option) { this.options.push(option); }, replaceChildren() { this.options = []; } };
        Object.defineProperty(item, 'selectedOptions', { get() { return this.options.filter(option => option.selected); } });
        elements.set(`agent-skill-import-${id}`, item);
    }
    let api;
    const document = { getElementById: id => elements.get(id), createElement: () => ({ value: '', textContent: '', selected: false }), addEventListener() {} };
    vm.runInNewContext(source, { document, API_BASE: '/api', apiFetch: handler, window: { Pivot: { exposeModule(_name, value) { api = value; } } } });
    api.bind({ refresh: async () => {} });
    return { api, elements, get: id => elements.get(`agent-skill-import-${id}`) };
}
const response = (data, code = 200) => ({ ok: code < 400, status: code, json: async () => data });
const tool = { name: 'rag.search', title: '知识库', capabilities: ['knowledge.search'], risk: 'low', approvalRequired: false };
async function prepare(f) {
    await f.api.loadTools();
    f.get('source').files = [{ size: 50, text: async () => '# 工作指引' }];
    await f.get('source').handlers.change();
    f.get('title').value = '测试技能';
    f.get('tools').options[0].selected = true;
    await f.get('preview').handlers.click();
}

test('验证失败保留草稿，重试时不会重复创建且成功后解锁', async () => {
    let createCount = 0; let validateCount = 0;
    const f = fixture(async (url) => {
        if (url.endsWith('/import/tools')) return response({ tools: [tool] });
        if (url.endsWith('/import/preview')) return response({ proposal: { name: 'imported-test', markdown: 'source', tools: [tool], warnings: [], preview: { valid: true, errors: [] } } });
        if (url.endsWith('/skills/source')) { createCount++; return response({ version: { id: 7 } }); }
        if (url.endsWith('/validate')) { validateCount++; return validateCount === 1 ? response({ declarative: { errors: ['验证失败'] } }, 422) : response({ passed: true }); }
        if (url.endsWith('/publish')) return response({ success: true });
        throw new Error(url);
    });
    await prepare(f);
    assert.equal(f.get('submit').disabled, false);
    await f.get('submit').handlers.click();
    assert.match(f.get('status').textContent, /草稿已保留/);
    assert.equal(f.get('title').disabled, true);
    await f.get('submit').handlers.click();
    assert.equal(createCount, 1);
    assert.equal(validateCount, 2);
    assert.match(f.get('status').textContent, /已添加并发布/);
    assert.equal(f.get('title').disabled, false);
});

test('发布响应不确定时查询已有发布，不重复提交发布', async () => {
    let publishes = 0;
    const f = fixture(async url => {
        if (url.endsWith('/import/tools')) return response({ tools: [tool] });
        if (url.endsWith('/import/preview')) return response({ proposal: { name: 'imported-test', markdown: 'source', tools: [tool], warnings: [], preview: { valid: true, errors: [] } } });
        if (url.endsWith('/skills/source')) return response({ version: { id: 7 } });
        if (url.endsWith('/validate')) return response({ passed: true });
        if (url.endsWith('/publish')) { publishes++; throw new Error('连接中断'); }
        if (url.includes('/skills/releases?')) return response({ data: [{ skill_version_id: 7, status: 'published', rollout_scope: 'personal' }] });
        throw new Error(url);
    });
    await prepare(f);
    await f.get('submit').handlers.click();
    assert.match(f.get('status').textContent, /发布未完成/);
    await f.get('submit').handlers.click();
    assert.equal(publishes, 1);
    assert.match(f.get('status').textContent, /已添加并发布/);
});

test('工具目录变化时撤销预览并阻止创建', async () => {
    let calls = 0; let created = 0;
    const f = fixture(async url => {
        if (url.endsWith('/import/tools')) { calls++; return response({ tools: calls === 1 ? [tool] : [] }); }
        if (url.endsWith('/import/preview')) return response({ proposal: { name: 'imported-test', markdown: 'source', tools: [tool], warnings: [], preview: { valid: true, errors: [] } } });
        if (url.endsWith('/skills/source')) { created++; return response({ version: { id: 7 } }); }
        throw new Error(url);
    });
    await prepare(f);
    await f.get('submit').handlers.click();
    assert.equal(created, 0);
    assert.match(f.get('status').textContent, /授权已变化/);
    assert.equal(f.get('submit').disabled, true);
});


test('创建响应丢失时通过唯一技能标识找回草稿，不重复创建', async () => {
    let creates = 0;
    const f = fixture(async url => {
        if (url.endsWith('/import/tools')) return response({ tools: [tool] });
        if (url.endsWith('/import/preview')) return response({ proposal: { name: 'imported-test', markdown: 'source', tools: [tool], warnings: [], preview: { valid: true, errors: [] } } });
        if (url.endsWith('/skills/source')) { creates++; throw new Error('连接中断'); }
        if (url.includes('/skills/versions?')) return response({ data: [{ id: 7, name: 'imported-test', version: '1.0.0' }] });
        if (url.endsWith('/validate')) return response({ passed: true });
        if (url.endsWith('/publish')) return response({ success: true });
        throw new Error(url);
    });
    await prepare(f);
    await f.get('submit').handlers.click();
    assert.equal(creates, 1);
    assert.match(f.get('status').textContent, /已添加并发布/);
});

test('草稿创建结果未知时禁止重复创建并保留核对状态', async () => {
    let creates = 0;
    const f = fixture(async url => {
        if (url.endsWith('/import/tools')) return response({ tools: [tool] });
        if (url.endsWith('/import/preview')) return response({ proposal: { name: 'imported-test', markdown: 'source', tools: [tool], warnings: [], preview: { valid: true, errors: [] } } });
        if (url.endsWith('/skills/source')) { creates++; throw new Error('连接中断'); }
        if (url.includes('/skills/versions?')) return response({ data: [] });
        throw new Error(url);
    });
    await prepare(f);
    await f.get('submit').handlers.click();
    await f.get('submit').handlers.click();
    assert.equal(creates, 1);
    assert.match(f.get('status').textContent, /结果尚未确认/);
    assert.equal(f.get('title').disabled, true);
});


test('预览期间工具或文本变化不会启用旧方案', async () => {
    let finishPreview;
    const f = fixture(async url => {
        if (url.endsWith('/import/tools')) return response({ tools: [tool] });
        if (url.endsWith('/import/preview')) return await new Promise(resolve => { finishPreview = resolve; });
        throw new Error(url);
    });
    await f.api.loadTools();
    f.get('source').files = [{ size: 50, text: async () => '# 工作指引' }];
    await f.get('source').handlers.change();
    f.get('title').value = '原名称';
    f.get('tools').options[0].selected = true;
    const pending = f.get('preview').handlers.click();
    f.get('title').value = '新名称';
    finishPreview(response({ proposal: { name: 'imported-test', markdown: 'source', tools: [tool], warnings: [], preview: { valid: true, errors: [] } } }));
    await pending;
    assert.equal(f.get('submit').disabled, true);
    assert.match(f.get('status').textContent, /重新预览/);
});
