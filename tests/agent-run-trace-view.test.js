'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function createTraceView({ disclosure = () => null, activeRunId = '' } = {}) {
    const escape = value => String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const context = {
        activeAgentRunId: activeRunId,
        agentEscape: escape,
        agentEscapeAttr: escape,
        agentToolTitle: value => String(value),
        agentShortText: (value, limit) => String(value).slice(0, limit),
        isAgentRunDisclosureOpen: disclosure
    };
    vm.runInNewContext(read('client/chat/agent-run-trace-view.js'), context);
    return context;
}

test('Agent 工作区在详情脚本前按需加载追踪渲染脚本', () => {
    const workspace = read('client/chat/app-workspaces.js');
    const traceIndex = workspace.indexOf("'/chat/agent-run-trace-view.js'");
    const detailIndex = workspace.indexOf("'/chat/agent-run-detail.js'");
    assert.ok(traceIndex >= 0 && detailIndex > traceIndex);
});

test('运行追踪保留运行级及步骤级的折叠状态', () => {
    const calls = [];
    const view = createTraceView({
        activeRunId: 'run-current',
        disclosure: (runId, key, fallback) => {
            calls.push({ runId, key, fallback });
            return key === 'trace-panel' || key === 'trace-span-span-one';
        }
    });
    const html = view.renderAgentTrace({
        spans: [{ id: 'span-one', name: 'plan', span_type: 'plan', duration_ms: 15, details: 'test' }]
    }, 'running');
    assert.match(html, /data-disclosure-key="trace-panel" open/);
    assert.match(html, /data-disclosure-key="trace-span-span-one" open/);
    assert.ok(calls.some(call => call.runId === 'run-current' && call.key === 'trace-panel'));
    assert.ok(calls.some(call => call.runId === 'run-current' && call.key === 'trace-span-span-one'));
});

test('运行追踪转义不可信步骤名称、标识和错误信息', () => {
    const view = createTraceView();
    const hostile = '<img src=x onerror=alert(1)>';
    const html = view.renderAgentTrace({
        spans: [{ id: 'x" onmouseover="alert(1)', name: hostile, error_message: hostile, status: 'error' }],
        summary: { errorCount: 1 }
    }, 'error', 'run-1');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /data-trace-span-id="x&quot; onmouseover=&quot;alert\(1\)"/);
    assert.match(html, /data-disclosure-key="trace-panel" open/);
});

test('无追踪步骤时不生成空面板', () => {
    const view = createTraceView();
    assert.equal(view.renderAgentTrace(), '');
    assert.equal(view.renderAgentTrace({ spans: 'invalid' }), '');
});

test('追踪条使用有界数字及模块样式，不输出内联样式', () => {
    const view = createTraceView();
    const html = view.renderAgentTrace({
        spans: [{ id: 'bad', duration_ms: Infinity }, { id: 'negative', duration_ms: -5 }],
        summary: { totalDurationMs: Infinity }
    });
    assert.doesNotMatch(html, /\sstyle=|NaN|Infinity/);
    const coordinates = [...html.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)];
    assert.equal(coordinates.length, 2);
    coordinates.forEach(([, left, width]) => {
        assert.ok(Number(left) >= 0 && Number(left) <= 96);
        assert.ok(Number(width) >= 2 && Number(left) + Number(width) <= 100);
    });
});
