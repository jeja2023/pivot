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


test('决策失败原因只汇总对话执行失败并安全展示原因代码', async () => {
    const { api, elements } = fixture(async () => ({ ok: true, json: async () => ({ unavailable: false, errorBreakdown: [
        { scenario: 'chat.execution', eventType: 'execution', status: 'failure', reasonCode: 'delivery_not_verified', count: 3 },
        { scenario: 'chat.execution', eventType: 'execution', status: 'failure', reasonCode: 'delivery_not_verified', count: 2 },
        { scenario: 'chat.execution', eventType: 'execution', status: 'failure', reasonCode: '<script>', count: 1 },
        { scenario: 'chat.execution', eventType: 'feedback', status: 'failure', reasonCode: 'feedback', count: 9 },
        { scenario: 'chat.rag', eventType: 'execution', status: 'failure', reasonCode: 'rag', count: 8 },
        { scenario: 'chat.execution', eventType: 'execution', status: 'partial', reasonCode: 'partial', count: 7 }
    ] }) }));
    await api.loadDecisionFailures();
    const html = elements.get('monitor-decision-failures').html;
    assert.match(html, /<tr><td class="text-center">1<\/td><td title="delivery_not_verified">任务交付未通过核验<\/td><td class="text-center">5 条<\/td><\/tr>/);
    assert.match(html, /title="&lt;script>">其他未识别原因/);
    assert.doesNotMatch(html, /feedback|partial|>rag</);
});

test('决策失败原因空数据与接口不可用分别提示', async () => {
    const empty = fixture(async () => ({ ok: true, json: async () => ({ errorBreakdown: [] }) }));
    await empty.api.loadDecisionFailures();
    assert.match(empty.elements.get('monitor-decision-failures').html, /没有记录对话任务执行失败/);
    const failed = fixture(async () => ({ ok: true, json: async () => ({ unavailable: true }) }));
    await failed.api.loadDecisionFailures();
    assert.match(failed.elements.get('monitor-decision-failures').html, /暂时不可用/);
});

test('切换页面时取消失败原因请求，迟到响应不能覆盖页面', async () => {
    let pending;
    const { api, elements } = fixture((_url, options) => new Promise(resolve => { pending = { resolve, signal: options.signal }; }));
    const request = api.loadDecisionFailures();
    api.cancelQualityLoad();
    assert.equal(pending.signal.aborted, true);
    pending.resolve({ ok: true, json: async () => ({ errorBreakdown: [{ scenario: 'chat.execution', eventType: 'execution', status: 'failure', reasonCode: 'old', count: 9 }] }) });
    await request;
    assert.match(elements.get('monitor-decision-failures').html, /正在加载失败原因/);
});
