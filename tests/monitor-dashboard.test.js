const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/chat/monitor-dashboard.js'), 'utf8');

function fixture(fetch) {
    const elements = new Map();
    const modules = {};
    vm.runInNewContext(source, {
        AbortController,
        API_BASE: '/api', apiFetch: fetch,
        escapeHtml: value => String(value).replace(/</g, '&lt;'),
        formatMetricNumber: value => String(value), formatTokenCount: value => String(value || 0), formatDuration: value => `${value}秒`,
        document: { getElementById(id) { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
        PivotSafeHtml: { setHtml: (element, html) => { element.html = html; } },
        window: { Pivot: { legacy: {}, exposeModule: (name, api) => { modules[name] = api; } } }
    });
    return { api: modules['settings.monitorDashboard'], elements };
}

test('空 HTTP 样本和不可用运行探针不会显示成正常的零延迟或零等待', () => {
    const { api, elements } = fixture();
    api.render({ http: { requests: 0 }, runtime: { pgPool: { available: false }, eventLoop: { supported: true, sampled: false } } });
    const summary = elements.get('monitor-summary-grid').html;
    assert.match(summary, /HTTP P95<\/span><strong>暂无数据/);
    assert.match(summary, /HTTP 5xx 错误率<\/span><strong>暂无数据/);
    assert.match(elements.get('monitor-runtime-pressure').html, /事件循环 P99<\/span><strong>暂无数据/);
    assert.match(elements.get('monitor-runtime-pressure').html, /等待数据库连接<\/span><strong>暂无数据/);
    assert.match(elements.get('monitor-task-queue').html, /暂不可用/);
    assert.match(elements.get('monitor-routing-quality').html, /路由平均耗时<\/span><strong>暂无数据/);
});

test('HTTP 延迟超出直方图范围与明确故障保留可见状态', () => {
    const { api, elements } = fixture();
    api.render({ health: { status: 'error' }, http: { requests: 4, p95LatencyMs: 0 }, observability: { openByType: [{ count: 2 }, { count: 3 }] } });
    const summary = elements.get('monitor-summary-grid').html;
    assert.match(summary, /monitor-card is-critical/);
    assert.match(summary, /HTTP P95<\/span><strong>> 10 s/);
    assert.match(summary, /未恢复告警<\/span><strong>5/);
});

test('对话执行统计读取失败时提供重试提示并保留不可用含义', async () => {
    const { api, elements } = fixture(async () => ({ ok: false, status: 503 }));
    await api.loadQuality();
    assert.match(elements.get('monitor-chat-execution').textContent, /暂不可用，请稍后刷新/);
    assert.equal(elements.get('monitor-chat-execution').html, undefined);
});

test('刷新重叠时取消旧统计请求，旧响应不能覆盖最新结果', async () => {
    const pending = [];
    const { api, elements } = fixture((_url, options) => new Promise(resolve => pending.push({ resolve, signal: options.signal })));
    const first = api.loadQuality();
    const second = api.loadQuality();
    assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve({ ok: true, json: async () => ({ metrics: [{ count: 2 }] }) });
    await second;
    const latest = elements.get('monitor-chat-execution').html;
    pending[0].resolve({ ok: true, json: async () => ({ metrics: [{ count: 99 }] }) });
    await first;
    assert.equal(elements.get('monitor-chat-execution').html, latest);
    assert.match(latest, /请求数<\/span><strong>2/);
});
