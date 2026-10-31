'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('流式快照客户端只渲染当前任务的最新授权响应', async () => {
    const pending = [];
    const panel = { classList: { add() {}, remove() {} } };
    const container = { firstChild: null, querySelector: () => null, insertBefore() {} };
    const rendered = [];
    const context = {
        activeAgentRunId: 'one', API_BASE: '/api', isAgentRunDetailModalOpen: () => true,
        apiFetch: url => new Promise(resolve => pending.push({ url, resolve })),
        renderAgentStreamingPanel: undefined,
        document: { getElementById: id => id === 'agent-run-detail' ? container : null, createElement: () => panel },
        PivotSafeHtml: { setHtml: (_target, html) => rendered.push(html) }, agentEscape: value => String(value || ''),
        window: { Pivot: { legacy: {}, moduleApi: () => ({}), exposeModule() {} } }, setTimeout: () => 1, clearTimeout() {}, setInterval, clearInterval
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/agent-run-realtime.js'), 'utf8'), context);
    const first = context.refreshAgentStreamingSnapshot('one');
    const second = context.refreshAgentStreamingSnapshot('one');
    pending[1].resolve({ ok: true, json: async () => ({ snapshot: { runId: 'one', content: 'new response' } }) });
    await second;
    pending[0].resolve({ ok: true, json: async () => ({ snapshot: { runId: 'one', content: 'stale response' } }) });
    await first;
    assert.equal(rendered.length, 1);
    assert.match(rendered[0], /new response/);
    const oldTask = context.refreshAgentStreamingSnapshot('one');
    context.activeAgentRunId = 'two';
    pending[2].resolve({ ok: true, json: async () => ({ snapshot: { runId: 'one', content: 'wrong task' } }) });
    await oldTask;
    assert.equal(rendered.length, 1);
    const denied = context.refreshAgentStreamingSnapshot('two');
    pending[3].resolve({ ok: false });
    await denied;
    assert.equal(rendered.length, 1);
});
