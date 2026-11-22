/* global window */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium, expect } = require('@playwright/test');
const source = fs.readFileSync(path.join(__dirname, '../client/chat/monitor-dashboard.js'), 'utf8');

function fixture(fetch) {
    const elements = new Map();
    const modules = {};
    const context = {
        AbortController,
        API_BASE: '/api', apiFetch: fetch,
        escapeHtml: value => String(value).replace(/</g, '&lt;'),
        formatMetricNumber: value => String(value), formatTokenCount: value => String(value || 0), formatDuration: value => `${value}秒`,
        document: {
            getElementById(id) {
                if (!elements.has(id)) {
                    const classes = new Set(['hidden']);
                    const attrs = {};
                    elements.set(id, {
                        classList: {
                            add: c => classes.add(c),
                            remove: c => classes.delete(c),
                            contains: c => classes.has(c)
                        },
                        setAttribute: (k, v) => { attrs[k] = String(v); },
                        getAttribute: k => attrs[k],
                        classes,
                        attrs
                    });
                }
                return elements.get(id);
            }
        },
        PivotSafeHtml: { setHtml: (element, html) => { element.html = html; } },
        window: { Pivot: { legacy: {}, exposeModule: (name, api) => { modules[name] = api; } } }
    };
    vm.runInNewContext(source, context);
    return { api: modules['settings.monitorDashboard'], elements, document: context.document };
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

test('系统资源的磁盘与进程指标按卡片宽度从双列切换到单列', { timeout: 60000 }, async () => {
    const client = path.resolve(__dirname, '../client');
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        const template = fs.readFileSync(path.join(client, 'chat/partials/settings/monitor.html'), 'utf8');
        await page.setContent(`<style>.hidden{display:none!important}</style><main class="settings-workspace-view">${template}</main>`);
        for (const style of ['common/styles/theme.css', 'chat/styles/stats-monitor/stats-monitor-common.css', 'chat/styles/stats-monitor/stats-system-monitor.css']) {
            await page.addStyleTag({ path: path.join(client, style) });
        }
        await page.evaluate(() => {
            const document = window.document;
            document.getElementById('tab-content-monitor').classList.remove('hidden');
            document.getElementById('monitor-overview-panel').classList.add('hidden');
            document.getElementById('monitor-services-panel').classList.remove('hidden');
            window.isAdminUser = () => true;
            window.API_BASE = '/api';
            window.formatDateToCN = () => '';
            window.formatTokenCount = String;
            window.showToast = () => {};
            window.monitorSummaryFixture = {
                system: { disk: { total: 1024 ** 3, used: 0.8 * 1024 ** 3, free: 0.2 * 1024 ** 3 } },
                process: { cpuSeconds: { user: 12345.6, system: 789.1 }, memory: { rss: 248.8 * 1024 ** 2 } },
                http: {}
            };
            window.apiFetch = async () => ({ ok: true, json: async () => window.monitorSummaryFixture });
        });
        for (const script of ['chat/pivot-core.js', 'common/vendor/purify.min.js', 'chat/safe-html.js', 'chat/monitor-dashboard.js', 'chat/stats-monitor-utils.js', 'chat/stats-monitor.js']) {
            await page.addScriptTag({ path: path.join(client, script) });
        }
        await page.evaluate(async () => {
            window.escapeHtml = window.Pivot.html.escapeHtml;
            await window.Pivot.moduleApi('settings.monitor').loadMonitorSummary({ propagateErrors: true });
        });

        const disk = page.locator('#monitor-resource-list .monitor-row').filter({ hasText: '硬盘空间' });
        const process = page.locator('#monitor-resource-list .monitor-row').filter({ hasText: 'CPU 累计耗时' });
        await expect(process).toContainText('进程常驻内存');
        await expect(process).toContainText('248.8 MB');
        await expect(disk.locator('.monitor-meter-fill')).toHaveAttribute('data-meter-rate', '80');

        const positions = row => row.locator(':scope > div').evaluateAll(cells => cells.map(cell => ({ x: cell.offsetLeft, y: cell.offsetTop })));
        for (const row of [disk, process]) {
            const [left, right] = await positions(row);
            assert.equal(left.y, right.y);
            assert.ok(right.x > left.x);
        }

        for (const width of [950, 390]) {
            await page.setViewportSize({ width, height: 900 });
            for (const row of [disk, process]) {
                const [first, second] = await positions(row);
                assert.equal(first.x, second.x);
                assert.ok(second.y > first.y);
                assert.ok(await row.evaluate(element => element.scrollWidth <= element.clientWidth));
            }
        }

        await page.evaluate(async () => {
            window.monitorSummaryFixture.system.disk = {};
            await window.Pivot.moduleApi('settings.monitor').loadMonitorSummary({ propagateErrors: true });
        });
        await expect(disk.locator('.monitor-meter-track')).toHaveCount(0);
        await expect(disk.getByText('暂无数据')).toHaveCount(2);
    } finally {
        await browser.close();
    }
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
    const { api, elements, document } = fixture(async () => ({ ok: true, json: async () => ({ unavailable: false, detailsAvailable: true, errorBreakdown: [
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
    assert.doesNotMatch(html, /查看任务核验失败明细/);
    const openBtn = document.getElementById('btn-monitor-open-failure-modal');
    assert.equal(openBtn.classList.contains('hidden'), false);
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

test('决策计数保留调用错误口径，明细显示组件、原因、耗时及任务缺项', async () => {
    const { api, elements } = fixture(async url => ({ ok: true, json: async () => url.includes('kind=provider')
        ? { items: [{ providerId: 'chat-intent', providerVersion: '8', decisionId: 'decision-one', reasonCode: 'intent_timeout', label: '任务意图判断超时', durationMs: 30000,
            failureStage: 'model_queue', timing: { queueMs: 25000, providerMs: 4800 } }], total: 39, hasMore: true }
        : { items: [{ runId: 'run-one', decisionId: 'decision-one', label: '缺少文件格式', missing: ['尚未生成PPTX<script>'], ruleFailures: [], detailSource: 'current_report' }], total: 69, hasMore: true } }));
    api.render({ decisionRouting: { providers: [{ calls: 121, errors: 39, p95_duration_ms: 30000 }] } });
    assert.match(elements.get('monitor-routing-quality').html, /121 \/ 39/);
    assert.match(elements.get('monitor-routing-quality').html, /查看24小时决策错误明细/);
    await api.loadFailureDetails('provider');
    assert.match(elements.get('monitor-failure-details').html, /任务意图判断超时/); assert.match(elements.get('monitor-failure-details').html, /39 条|39<\/|39 /);
    assert.match(elements.get('monitor-failure-details').html, /模型排队/);
    assert.match(elements.get('monitor-failure-details').html, /25,000|25000/);
    assert.match(elements.get('monitor-failure-details').html, /上游.*4,800|上游.*4800/);
    await api.loadFailureDetails('delivery');
    const html = elements.get('monitor-failure-details').html;
    assert.match(html, /run-one/); assert.match(html, /当前核验报告/); assert.match(html, /&lt;script>/); assert.doesNotMatch(html, /<script>/);
});

test('失败明细显示发起用户并区分失败记录时间和任务发起时间，用户名称安全转义', async () => {
    const { api, elements } = fixture(async () => ({ ok: true, json: async () => ({ items: [{
        userId: '7', username: 'member12345678', nickname: '测试<script>', occurredAt: '2026-11-13T06:30:00Z', runCreatedAt: '2026-11-13T06:00:00Z'
    }], total: 1 }) }));
    await api.loadFailureDetails('delivery');
    const delivery = elements.get('monitor-failure-details').html;
    assert.match(delivery, /<th scope="col">发起用户<\/th>/);
    assert.match(delivery, /<th scope="col">失败记录时间<\/th>/);
    assert.match(delivery, /<th scope="col">任务发起时间<\/th>/);
    assert.match(delivery, /14:30:00/); assert.match(delivery, /14:00:00/);
    assert.match(delivery, /测试&lt;script>（member12345678）/); assert.doesNotMatch(delivery, /<script>/);
    await api.loadFailureDetails('provider');
    const provider = elements.get('monitor-failure-details').html;
    assert.match(provider, /<th scope="col">决策记录时间<\/th>/);
    assert.match(provider, /<th scope="col">发起用户<\/th>/);
    assert.doesNotMatch(provider, /任务发起时间|14:00:00/);
});

test('缺失用户与任务时间明确提示，空表的列数与两种明细一致', async () => {
    let items = [{ occurredAt: null, runCreatedAt: null }, { userId: '8' }];
    const { api, elements } = fixture(async () => ({ ok: true, json: async () => ({ items, total: items.length }) }));
    await api.loadFailureDetails('delivery');
    const html = elements.get('monitor-failure-details').html;
    assert.match(html, /未关联用户/); assert.match(html, /用户 8/); assert.match(html, /未记录时间/);
    assert.doesNotMatch(html, /1970|Invalid Date/);
    items = [];
    await api.loadFailureDetails('delivery'); assert.match(elements.get('monitor-failure-details').html, /colspan="7"/);
    await api.loadFailureDetails('provider'); assert.match(elements.get('monitor-failure-details').html, /colspan="6"/);
});

test('明细请求取消后迟到结果不能覆盖当前选择', async () => {
    const pending = [];
    const { api, elements } = fixture((_url, options) => new Promise(resolve => pending.push({ resolve, signal: options.signal })));
    const first = api.loadFailureDetails('delivery'), second = api.loadFailureDetails('provider');
    assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve({ ok: true, json: async () => ({ items: [], total: 0, hasMore: false }) }); await second;
    const latest = elements.get('monitor-failure-details').html;
    pending[0].resolve({ ok: true, json: async () => ({ items: [], total: 99 }) }); await first;
    assert.equal(elements.get('monitor-failure-details').html, latest);
});

test('失败明细使用全局统一样式的弹窗结构展示，并支持通过接口关闭', async () => {
    const { api, elements, document } = fixture(async () => ({ ok: true, json: async () => ({
        items: [{ runId: 'run-delivery-1', decisionId: 'dec-1', label: '缺失产物', missing: ['未生成最终报表'] }],
        total: 1,
        hasMore: false
    }) }));
    const modal = document.getElementById('monitor-failure-modal');
    assert.equal(modal.classList.contains('hidden'), true);

    await api.loadFailureDetails('delivery');
    assert.equal(modal.classList.contains('hidden'), false);
    assert.equal(modal.getAttribute('aria-hidden'), 'false');

    const html = elements.get('monitor-failure-details').html;
    assert.match(html, /class="[^"]*monitor-failure-modal-header[^"]*"/);
    assert.match(html, /class="monitor-failure-modal-body"/);
    assert.match(html, /class="monitor-failure-modal-footer"/);
    assert.match(html, /class="[^"]*btn-danger-outline[^"]*monitor-failure-close-btn[^"]*"/);
    assert.match(html, /<th scope="col" class="text-center col-index">序号<\/th>/);
    assert.match(html, /<td class="text-center col-index">1<\/td>/);
    assert.match(html, /id="monitor-failure-pagination"/);
    assert.match(html, /class="pagination workspace-pagination"/);
    assert.match(html, /data-monitor-failure-close/);
    assert.match(html, /run-delivery-1/);
    const closeButtons = (html.match(/data-monitor-failure-close/g) || []).length;
    assert.equal(closeButtons, 1);

    api.closeFailureDetailsModal();
    assert.equal(modal.classList.contains('hidden'), true);
    assert.equal(modal.getAttribute('aria-hidden'), 'true');
});
