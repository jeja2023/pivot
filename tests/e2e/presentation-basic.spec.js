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
