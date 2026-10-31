'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const JSZip = require('jszip');

test('演示文稿可创建、编辑、刷新恢复并导出 PPTX', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations' }));
    const created = page.waitForResponse(response => response.url().endsWith('/api/apps/presentations') && response.request().method() === 'POST');
    await page.locator('#presentation-create-blank-btn').click();
    const result = await created;
    expect(result.ok()).toBeTruthy();
    const id = (await result.json()).presentation.id;
    await expect(page.locator('#presentation-title-input')).toBeVisible();
    await page.locator('#presentation-title-input').fill('隔离演示保存测试');
    await page.locator('#presentation-add-slide-btn').click();
    await expect.poll(async () => {
        const response = await page.request.get(`/api/apps/presentations/${id}`);
        if (!response.ok()) return false;
        const data = (await response.json()).presentation;
        return data.content.title === '隔离演示保存测试' && data.content.slides.length >= 2;
    }, { timeout: 20_000 }).toBe(true);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations' }));
    await page.locator(`[data-presentation-action="open"][data-presentation-id="${id}"]`).first().click();
    await expect(page.locator('#presentation-title-input')).toHaveValue('隔离演示保存测试');
    await expect(page.locator('#presentation-slide-list [data-presentation-slide-id]')).toHaveCount(2);
    await page.locator('#presentation-export-dropdown summary').click();
    const download = page.waitForEvent('download');
    await page.locator('#presentation-export-pptx-btn').click();
    const zip = await JSZip.loadAsync(await fs.readFile(await (await download).path()));
    expect(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);
});
test('实时事件丢失时，轮询可识别访问撤销；临时服务错误保留编辑界面', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations' }));
    const created = page.waitForResponse(response => response.url().endsWith('/api/apps/presentations') && response.request().method() === 'POST');
    await page.locator('#presentation-create-blank-btn').click();
    const id = (await (await created).json()).presentation.id;
    await expect(page.locator('#presentation-editor')).toBeVisible();
    await page.route(`**/api/apps/presentations/${id}/comments`, async route => {
        if (route.request().method() !== 'GET') return await route.continue();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ comments: [{ id: 1, status: 'open', content: '模拟异节点评论' }] }) });
    });
    await expect(page.locator('#presentation-comments-badge')).toHaveText('1', { timeout: 22000 });
    let status = 500;
    let hits = 0;
    await page.route(`**/api/apps/presentations/${id}`, async route => {
        if (route.request().method() !== 'GET') return await route.continue();
        hits += 1;
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: '模拟错误' }) });
    });
    await expect.poll(() => hits, { timeout: 12000 }).toBeGreaterThan(0);
    await expect(page.locator('#presentation-editor')).toBeVisible();
    status = 404;
    await expect(page.locator('#presentation-editor')).toBeHidden({ timeout: 12000 });
    await expect(page.locator('#presentation-library')).toBeVisible();
    await expect(page.locator('#toast-container')).toContainText('访问已撤销');
});
