'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/chat/agent-skill-import.js'), 'utf8');

function fixture(handler) {
    const elements = new Map();
    for (const id of ['source', 'title', 'description', 'tools', 'preview', 'submit', 'status', 'review', 'template']) {
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
const workspaceRead = { ...tool, name: 'mcp.7.workspace.read', title: '读取工作区', capabilities: ['filesystem.read_workspace'] };
const templateResponse = { template: { id: 'code-review', title: '代码变更审查', description: '只读审查', markdown: '# 只读审查' }, tools: [workspaceRead] };

test('内置模板选取只读工具，预览携带模板标识且旧预览失效', async () => {
    let body;
    const f = fixture(async (url, options) => {
        if (url.endsWith('/import/tools')) return response({ tools: [tool, workspaceRead], templates: [{ id: 'code-review', title: '代码变更审查' }] });
        if (url.endsWith('/templates/code-review')) return response(templateResponse);
        if (url.endsWith('/import/preview')) { body = JSON.parse(options.body); return response({ proposal: { name: 'review', markdown: '指引', tools: [workspaceRead], warnings: [], preview: { valid: true, errors: [] } } }); }
        throw new Error(url);
    });
    await f.api.loadTools();
    f.get('template').value = 'code-review';
    await f.get('template').handlers.change();
    assert.equal(f.get('tools').options.length, 1);
    assert.equal(f.get('tools').options[0].selected, true);
    await f.get('preview').handlers.click();
    assert.equal(body.templateId, 'code-review');
    assert.deepEqual(body.tools, [workspaceRead.name]);
    assert.equal(f.get('submit').disabled, false);
    f.get('source').files = [{ name: 'custom.md', size: 9, text: async () => '# 自定义' }];
    await f.get('source').handlers.change();
    assert.equal(f.get('template').value, '');
    assert.equal(f.get('submit').disabled, true);
});

test('模板请求迟到不能覆盖后来上传的文件', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture(async url => {
        if (url.endsWith('/import/tools')) return response({ tools: [tool] });
        if (url.endsWith('/templates/code-review')) return pending;
        if (url.endsWith('/import/inspect')) return response({ inspection: { identity: { title: '自定义', description: '' }, compatibility: { formatLabel: 'Markdown', status: 'compatible' } } });
        throw new Error(url);
    });
    f.get('template').value = 'code-review';
    const loading = f.get('template').handlers.change();
    f.get('source').files = [{ name: 'custom.md', size: 9, text: async () => '# 自定义' }];
    await f.get('source').handlers.change();
    finish(response(templateResponse));
    await loading;
    assert.equal(f.get('title').value, '自定义');
    assert.equal(f.get('template').value, '');
    assert.equal(f.get('tools').options.length, 1);
});
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

test('读取文件时显示识别格式并自动填写名称和说明，预览携带真实文件类型', async () => {
    let previewBody;
    const f = fixture(async (url, options) => {
        if (url.endsWith('/import/tools')) return response({ tools: [tool] });
        if (url.endsWith('/import/inspect')) return response({ inspection: { identity: { title: '自动名称', description: '自动说明' }, compatibility: { formatLabel: '通用结构化技能清单', status: 'compatible' } } });
        if (url.endsWith('/import/preview')) {
            previewBody = JSON.parse(options.body);
            return response({ proposal: { name: 'imported-test', markdown: 'source', tools: [tool], warnings: [], preview: { valid: true, errors: [] },
                compatibility: { formatLabel: '通用结构化技能清单', adapterVersion: '1.0.0', container: 'json', status: 'compatible', fields: [], requirements: [] } } });
        }
        throw new Error(url);
    });
    await f.api.loadTools();
    f.get('source').files = [{ name: 'skill.json', size: 50, text: async () => '{"instructions":"工作指引"}' }];
    await f.get('source').handlers.change();
    assert.equal(f.get('title').value, '自动名称'); assert.equal(f.get('description').value, '自动说明');
    assert.match(f.get('status').textContent, /通用结构化/);
    f.get('tools').options[0].selected = true;
    await f.get('preview').handlers.click();
    assert.equal(previewBody.fileName, 'skill.json'); assert.match(f.get('review').textContent, /文件类型：JSON/);
});

test('迟到的格式识别响应不覆盖新文件或用户编辑，非法格式不能继续创建', async () => {
    const pending = [];
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const f = fixture(async url => {
        if (url.endsWith('/import/tools')) return response({ tools: [tool] });
        if (url.endsWith('/import/inspect')) return new Promise(resolve => pending.push(resolve));
        throw new Error(url);
    });
    await f.api.loadTools();
    f.get('source').files = [{ name: 'old.md', size: 20, text: async () => '# 旧文件' }];
    const oldRead = f.get('source').handlers.change();
    await tick();
    f.get('source').files = [{ name: 'new.md', size: 20, text: async () => '# 新文件' }];
    const newRead = f.get('source').handlers.change();
    await tick();
    f.get('title').value = '用户自行填写';
    pending[1](response({ inspection: { identity: { title: '新文件建议', description: '新说明' }, compatibility: { formatLabel: 'Markdown 工作指引', status: 'compatible' } } }));
    await newRead;
    pending[0](response({ inspection: { identity: { title: '旧文件建议', description: '旧说明' }, compatibility: { formatLabel: '旧格式', status: 'compatible' } } }));
    await oldRead;
    assert.equal(f.get('title').value, '用户自行填写'); assert.equal(f.get('description').value, '新说明');
    assert.doesNotMatch(f.get('status').textContent, /旧格式/);
    f.get('source').files = [{ name: 'invalid.json', size: 20, text: async () => 'invalid' }];
    const invalidRead = f.get('source').handlers.change(); await tick();
    pending[2](response({ error: 'JSON 格式无效' }, 422)); await invalidRead;
    f.get('tools').options[0].selected = true;
    await f.get('preview').handlers.click();
    assert.equal(f.get('submit').disabled, true);
});
