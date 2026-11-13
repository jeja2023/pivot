'use strict';
/* global window, document */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

async function openAnalysis(page) {
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#auth-container')).toBeHidden({ timeout: 15000 });
    await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.currentUser?.id));
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAppsWorkbench));
    await page.evaluate(async () => {
        await window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench();
        await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js');
        await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' });
    });
    await expect(page.locator('#data-analysis-view')).toBeVisible({ timeout: 15000 });
}

function mockCatalog(page, calls) {
    return page.route('**/api/apps/data-analysis/models?*', route => {
        const params = new URL(route.request().url()).searchParams;
        calls.push(Object.fromEntries(params));
        return route.fulfill({ json: { total: 51, models: [
            { id: 'published-source', name: '已发布的跨部门业务统一口径分析模型', modelKind: 'production', publishedVersion: 3, lifecycle: 'published', availability: 'available' },
            { id: 'archived-source', name: '已归档模型', modelKind: 'production', publishedVersion: 1, lifecycle: 'archived' },
            { id: 'draft-source', name: '未发布模型', modelKind: 'production', publishedVersion: 0, lifecycle: 'draft' }
        ] } });
    });
}

test('三个分析页的来源类型紧邻数据集，桌面与窄屏布局正常且原分析功能可用', async ({ page }) => {
    test.setTimeout(120000);
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    await mockCatalog(page, calls);
    await page.setViewportSize({ width: 1660, height: 1000 });
    await openAnalysis(page);
    await page.locator('#data-analysis-file').setInputFiles({ name: '来源布局验证.csv', mimeType: 'text/csv', buffer: Buffer.from('地区,季度,金额\n华东,一季度,100\n华南,一季度,200\n华东,二季度,50\n') });
    await expect(page.locator('#data-analysis-dataset-table-body')).toContainText('来源布局验证');
    const output = path.resolve('output/data-analysis-sources');
    await fs.mkdir(output, { recursive: true });
    for (const width of [1660, 1280, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const tab of ['chart', 'query', 'pivot']) {
            await page.locator(`[data-data-analysis-tab="${tab}"]`).click();
            const panel = page.locator(`#data-analysis-${tab}-panel`);
            const source = panel.locator('[data-model-source-type]'), dataset = panel.locator(`#data-analysis-${tab}-dataset`);
            await expect(source).toBeVisible();
            await expect(panel.locator('[data-model-source-id] option')).toHaveCount(2);
            await source.selectOption('dataset');
            await expect(panel.locator('[data-model-source-search]')).toBeHidden();
            await dataset.selectOption({ label: '来源布局验证' });
            await expect.poll(() => page.evaluate(() => Boolean(window.Pivot.legacy.PivotDataAnalysis.state.summary)), { timeout: 15000 }).toBe(true);
            if (width >= 1280) {
                const left = await source.boundingBox(), right = await dataset.boundingBox();
                expect(Math.abs(left.y + left.height - right.y - right.height)).toBeLessThanOrEqual(1);
                expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1);
                if (tab === 'query') {
                    expect(right.width).toBeGreaterThanOrEqual(200);
                    expect(right.width).toBeLessThanOrEqual(260);
                }
            }
            if (width === 1660) {
                if (tab === 'chart') {
                    await page.locator('#data-analysis-chart-x').selectOption('c_1');
                    await page.locator('#data-analysis-chart-y').selectOption('c_3');
                    await page.locator('#data-analysis-chart-aggregation').selectOption('sum');
                    await page.locator('#data-analysis-build-chart').click();
                    await expect(page.locator('#data-analysis-chart-png')).toBeVisible();
                } else if (tab === 'query') {
                    await page.locator('#data-analysis-run-query-visual').click();
                    await expect(page.locator('#data-analysis-query-result')).toContainText('华东');
                } else {
                    await page.locator('#data-analysis-pivot-row').selectOption('c_1');
                    await page.locator('#data-analysis-pivot-col').selectOption('c_2');
                    await page.locator('#data-analysis-pivot-value').selectOption('c_3');
                    await page.locator('#data-analysis-run-pivot').click();
                    await expect(page.locator('#data-analysis-pivot-result')).toContainText('华东');
                }
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
            await page.locator('#data-analysis-view').screenshot({ path: path.join(output, `${tab}-${width}.png`) });
            await source.selectOption('model');
            await expect(panel.locator('[data-model-source-id]')).toBeVisible();
            await expect(panel.locator('[data-model-source-open]')).toBeVisible();
            await expect(panel.locator('[data-model-source-search]')).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
            if (width === 390) await page.locator('#data-analysis-view').screenshot({ path: path.join(output, `${tab}-model-${width}.png`) });
            await source.selectOption('dataset');
        }
    }
    expect(errors).toEqual([]);
});

test('来源控件移动后保留模型搜索、分页、选择与统一口径分析入口', async ({ page }) => {
    const calls = [];
    await mockCatalog(page, calls);
    await openAnalysis(page);
    await page.locator('[data-data-analysis-tab="chart"]').click();
    await page.locator('[data-model-source-type="chart"]').selectOption('model');
    await page.locator('[data-model-source-search="chart"]').fill('统一口径');
    await expect.poll(() => calls.at(-1)?.search).toBe('统一口径');
    await page.locator('[data-model-source-page="chart"][data-page-delta="1"]').click();
    await expect(page.locator('[data-model-source-page-info]')).toContainText('第 2 页');
    expect(calls.at(-1).page).toBe('2'); expect(calls.at(-1).lifecycle).toBe('published');
    await page.locator('[data-model-source-id="chart"]').selectOption('published-source');
    await page.evaluate(() => {
        const app = window.Pivot.legacy.PivotDataAnalysis;
        window.sourceEntryCalls = [];
        app.activateTab = tab => window.sourceEntryCalls.push(tab);
        app.modeling.canLeave = async () => true;
        app.modeling.loadModel = async (id, options) => window.sourceEntryCalls.push({ id, options });
        app.modeling.render = () => window.sourceEntryCalls.push('render');
    });
    await page.locator('[data-model-source-open="chart"]').click();
    await expect.poll(() => page.evaluate(() => window.sourceEntryCalls.length)).toBe(3);
    expect(await page.evaluate(() => ({ calls: window.sourceEntryCalls, queryMode: window.Pivot.legacy.PivotDataAnalysis.modeling.state.queryMode }))).toEqual({
        calls: ['modeling', { id: 'published-source', options: { force: true } }, 'render'], queryMode: 'published'
    });
});
