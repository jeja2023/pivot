/* global window, document, renderDagToolbar -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');

async function createTimelinePage(browser, nodes = [], { live = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('http://pivot.test/', route => route.fulfill({
        contentType: 'text/html',
        body: '<div class="pivot-dag-toolbar"></div>'
    }));
    await page.goto('http://pivot.test/');
    for (const file of [
        'client/common/styles/theme.css',
        'client/chat/styles/workspaces/shared.css',
        'client/chat/styles/workspaces/agent/agent-dag-toolbar.css'
    ]) {
        await page.addStyleTag({ path: path.join(root, file) });
    }
    for (const file of [
        'client/chat/pivot-core.js',
        'client/common/vendor/purify.min.js',
        'client/chat/safe-html.js',
        'client/chat/dag-timeline-waterfall.js',
        'client/chat/dag-toolbar.js'
    ]) {
        await page.addScriptTag({ path: path.join(root, file) });
    }
    if (live) await page.addScriptTag({ path: path.join(root, 'client/chat/dag-timeline-source.js') });
    await page.evaluate(({ currentNodes, live }) => {
        if (live) {
            window.API_BASE = '/api';
            window.apiFetch = (url, options) => fetch(url, options);
            window.Pivot.exposeModule('agent.automation', { currentWorkflowId: () => 'flow-1', currentWorkflowName: () => '测试工作流' });
        }
        window.Pivot.legacy.dagNodeRunStates = new Map([
            ['analysis', { status: 'completed', durationMs: 4500 }],
            ['report', { status: 'completed', cached: true, durationMs: 1 }]
        ]);
        renderDagToolbar({
            toolbar: document.querySelector('.pivot-dag-toolbar'),
            spec: { nodes: currentNodes },
            selectNode: id => { document.body.dataset.focusedNode = id; }
        });
    }, { currentNodes: nodes, live });
    return page;
}

test('耗时瀑布图通过真实工具栏和 HTML 组件打开，展示耗时并可定位节点、关闭', { timeout: 30000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createTimelinePage(browser, [
            { id: 'analysis', title: '分析数据', tool: 'agent.llm' },
            { id: 'report', title: '生成报告', tool: 'workflow.template' }
        ]);
        // 使用应用实际注册的 Pivot.html，避免测试桩掩盖不存在的入口。
        assert.equal(await page.evaluate(() => typeof window.Pivot.safeHtml), 'undefined');
        assert.equal(await page.evaluate(() => typeof window.Pivot.html.setHtml), 'function');

        const modal = page.locator('.pivot-dag-waterfall-modal-backdrop');
        await page.locator('.is-run-group > summary').click();
        await page.getByRole('menuitem', { name: '耗时瀑布图', exact: true }).click();
        await expect(modal).toBeVisible();
        await expect(modal.locator('.pivot-waterfall-row')).toHaveCount(2);
        await expect(modal.locator('[data-node-id="analysis"]')).toContainText('4.50s');
        await expect(modal.locator('[data-node-id="report"] .waterfall-badge')).toHaveClass(/is-cached/);
        assert.equal(await modal.locator('[data-node-id="analysis"] .pivot-waterfall-bar').evaluate(bar => bar.style.width), '100%');
        await modal.locator('[data-node-id="analysis"]').click();
        await expect(modal).toHaveCount(0);
        await expect(page.locator('body')).toHaveAttribute('data-focused-node', 'analysis');

        await page.locator('.is-run-group > summary').click();
        await page.getByRole('menuitem', { name: '耗时瀑布图', exact: true }).click();
        await modal.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(modal).toHaveCount(0);
    } finally {
        await browser.close();
    }
});

test('瀑布图从真实运行接口获取节点状态，打开后自动更新，关闭后停止请求', { timeout: 30000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const nodes = [{ id: 'analysis', title: '分组统计', tool: 'db.group_count' }, { id: 'report', title: '大模型处理', tool: 'agent.llm' }];
        const page = await createTimelinePage(browser, nodes, { live: true });
        const run = { id: 'run-live', run_mode: 'dag', title: '测试工作流', status: 'running', metadata: { workflowId: 'flow-1', dagSpec: { nodes } } };
        await page.route('**/api/agents/runs?*', route => route.fulfill({ json: { data: [run] } }));
        let requests = 0;
        const start = Date.now() - 1200;
        await page.route('**/api/agents/runs/run-live', route => {
            requests++;
            return route.fulfill({ json: { run: { ...run, status: requests >= 3 ? 'completed' : 'running' }, dagNodes: requests === 1
                ? nodes.map(node => ({ node_key: node.id, status: 'pending' }))
                : [{ node_key: 'analysis', title: '分组统计', status: 'completed', duration_ms: 1200,
                    completed_at: new Date(start + 1200).toISOString() },
                { node_key: 'report', title: '大模型处理', status: requests >= 3 ? 'completed' : 'running',
                    duration_ms: requests >= 3 ? 4000 : null, started_at: new Date(start + 1200).toISOString() }] } });
        });
        await page.locator('.is-run-group > summary').click();
        await page.getByRole('menuitem', { name: '耗时瀑布图', exact: true }).click();
        const modal = page.locator('.pivot-dag-waterfall-modal-backdrop');
        await expect(modal.locator('[data-node-id="analysis"]')).toContainText('待调度');
        await expect(modal.locator('[data-node-id="analysis"]')).toContainText('1.20s');
        await expect(modal.locator('[data-node-id="report"]')).toContainText('运行中');
        await expect(modal.locator('[data-node-id="report"]')).toContainText('4.00s');
        await expect(modal.locator('.pivot-dag-waterfall-summary')).toContainText('已完成: 2');
        await expect(modal.locator('.pivot-dag-waterfall-summary')).toContainText('5.20s');
        await expect(modal.locator('.pivot-dag-waterfall-status')).toHaveCount(1);
        assert.equal(await modal.locator('[data-node-id="report"] .pivot-waterfall-bar').evaluate(bar => bar.style.marginLeft), '23.1%');
        await page.keyboard.press('Escape');
        await expect(modal).toHaveCount(0);
        const closedAt = requests;
        await page.waitForTimeout(1700);
        assert.equal(requests, closedAt);
    } finally { await browser.close(); }
});

test('未匹配当前工作流的运行时显示尚未运行，窄屏没有溢出或虚假进度', { timeout: 30000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const nodes = [{ id: 'same-id', title: '尚未执行的长名称分组统计节点', tool: 'db.group_count', input: { table: 'current' } }];
        const page = await createTimelinePage(browser, nodes, { live: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.route('**/api/agents/runs?*', route => route.fulfill({ json: { data: [
            { id: 'other-workflow', run_mode: 'dag', metadata: { workflowId: 'flow-2', dagSpec: { nodes } } },
            { id: 'old-definition', run_mode: 'dag', metadata: { workflowId: 'flow-1', dagSpec: { nodes: [{ ...nodes[0], input: { table: 'old' } }] } } }
        ] } }));
        await page.locator('.is-run-group > summary').click();
        await page.getByRole('menuitem', { name: '耗时瀑布图', exact: true }).click();
        const modal = page.locator('.pivot-dag-waterfall-modal-backdrop');
        await expect(modal.locator('.waterfall-badge')).toHaveText('尚未运行');
        await expect(modal.locator('.pivot-dag-waterfall-status')).toContainText('暂无匹配的运行记录');
        assert.equal(await modal.locator('.pivot-waterfall-bar').evaluate(bar => bar.style.width), '0%');
        assert.equal(await modal.locator('.pivot-dag-waterfall-card').evaluate(card => card.scrollWidth <= card.clientWidth), true);
        await page.screenshot({ path: path.join(root, '.tmp/dag-timeline-mobile.png') });
        await modal.getByRole('button', { name: '关闭', exact: true }).click();
    } finally { await browser.close(); }
});

test('运行数据请求失败时显示原因并自动重试，不把加载失败伪装成待调度', { timeout: 30000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createTimelinePage(browser, [{ id: 'test', title: '测试节点', tool: 'workflow.template' }], { live: true });
        let requests = 0;
        await page.route('**/api/agents/runs?*', route => ++requests === 1
            ? route.fulfill({ status: 503, json: { error: '运行记录暂时不可用' } }) : route.fulfill({ json: { data: [] } }));
        await page.locator('.is-run-group > summary').click();
        await page.getByRole('menuitem', { name: '耗时瀑布图', exact: true }).click();
        const modal = page.locator('.pivot-dag-waterfall-modal-backdrop');
        await expect(modal.locator('.pivot-dag-waterfall-status')).toContainText('运行记录暂时不可用');
        await expect(modal.locator('.waterfall-badge')).toHaveText('未获取数据');
        await expect(modal.locator('.waterfall-badge')).toHaveText('尚未运行');
        await modal.getByRole('button', { name: '关闭', exact: true }).click();
    } finally { await browser.close(); }
});

test('新运行立即绑定到当前画布，打开瀑布图不依赖任务详情面板的刷新', { timeout: 30000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const nodes = [{ id: 'cached-node', title: '检索', tool: 'rag.search' }];
        const page = await createTimelinePage(browser, nodes, { live: true });
        let historyCalls = 0;
        await page.route('**/api/agents/runs?*', route => { historyCalls++; return route.fulfill({ json: { data: [] } }); });
        await page.route('**/api/agents/runs/run-new', route => route.fulfill({ json: {
            run: { id: 'run-new', title: '新预览运行', status: 'completed' },
            dagNodes: [{ node_key: 'cached-node', title: '检索', status: 'completed', duration_ms: 1 }],
            steps: [{ title: '[快取复用] DAG 节点：检索' }]
        } }));
        await page.evaluate(currentNodes => window.Pivot.moduleApi('agent.dagTimelineSource').rememberRun({ id: 'run-new' }, {
            spec: { nodes: currentNodes }, workflowId: 'flow-1'
        }), nodes);
        await page.locator('.is-run-group > summary').click();
        await page.getByRole('menuitem', { name: '耗时瀑布图', exact: true }).click();
        const modal = page.locator('.pivot-dag-waterfall-modal-backdrop');
        await expect(modal.locator('.waterfall-badge')).toHaveText('缓存');
        await expect(modal.locator('.pivot-dag-waterfall-summary')).toContainText('已完成: 1');
        assert.equal(historyCalls, 0);
        await modal.getByRole('button', { name: '关闭', exact: true }).click();
    } finally { await browser.close(); }
});

test('空工作流可查看瀑布图说明，重复打开只保留一个弹窗并支持点击遮罩关闭', { timeout: 30000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createTimelinePage(browser);
        await page.locator('.is-run-group > summary').click();
        await page.getByRole('menuitem', { name: '耗时瀑布图', exact: true }).click();
        const modal = page.locator('.pivot-dag-waterfall-modal-backdrop');
        await expect(modal.locator('.pivot-waterfall-empty')).toContainText('暂无节点执行数据');
        await page.evaluate(() => {
            window.Pivot.moduleApi('agent.dagTimeline').showTimelineWaterfallModal();
        });
        await expect(modal).toHaveCount(1);
        await modal.click({ position: { x: 10, y: 10 } });
        await expect(modal).toHaveCount(0);
    } finally {
        await browser.close();
    }
});
