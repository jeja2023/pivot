/* global window, document, renderDagToolbar -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');

async function createTimelinePage(browser, nodes = []) {
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
    await page.evaluate(currentNodes => {
        window.Pivot.legacy.dagNodeRunStates = new Map([
            ['analysis', { status: 'completed', durationMs: 4500 }],
            ['report', { status: 'completed', cached: true, durationMs: 1 }]
        ]);
        renderDagToolbar({
            toolbar: document.querySelector('.pivot-dag-toolbar'),
            spec: { nodes: currentNodes },
            selectNode: id => { document.body.dataset.focusedNode = id; }
        });
    }, nodes);
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
