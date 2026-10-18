'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function createDiagnostics(diagnostics) {
    let module;
    const escape = value => String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const context = {
        API_BASE: '/api',
        window: { Pivot: { exposeModule: (name, exports) => { if (name === 'agent.runDiagnostics') module = exports; } } }
    };
    vm.runInNewContext(read('client/chat/agent-run-diagnostics.js'), context);
    return module.create({
        diagnostics, escape, escapeAttr: escape, formatDate: String, shortText: String,
        jsonText: value => JSON.stringify(value), setMarkup: () => {}, prependMarkup: () => {},
        setNotice: () => {}, apiJson: async () => ({ data: [] })
    });
}

test('工作区在控制台前加载独立的运行诊断模块', () => {
    const workspaces = read('client/chat/app-workspaces.js');
    const diagnostics = workspaces.indexOf("'/chat/agent-run-diagnostics.js'");
    const harness = workspaces.indexOf("'/chat/agent-harness.js'");
    assert.ok(diagnostics >= 0 && harness > diagnostics);
    assert.match(read('client/chat/agent-harness.js'), /moduleApi\('agent\.runDiagnostics'\)\.create/);
});

test('诊断缓存淘汰最早运行时同步移除子页面状态', () => {
    const diagnostics = new Map();
    const view = createDiagnostics(diagnostics);
    const runIds = ['', ...Array.from({ length: 80 }, (_, index) => `run-${index}`)];
    for (const runId of runIds) {
        diagnostics.set(runId, 'world');
        const html = view.diagnosticTabMarkup(runId);
        assert.match(html, /data-agent-harness-active-tab="world"/);
    }
    assert.equal(diagnostics.size, 80);
    assert.equal(diagnostics.has(''), false);
    assert.equal(diagnostics.get('run-79'), 'world');
});

test('运行标识用于属性前必须转义', () => {
    const view = createDiagnostics(new Map());
    const html = view.diagnosticTabMarkup('x" onmouseover="alert(1)');
    assert.match(html, /data-agent-harness-diagnostics="x&quot; onmouseover=&quot;alert\(1\)"/);
    assert.doesNotMatch(html, /data-agent-harness-diagnostics="x" onmouseover=/);
});
