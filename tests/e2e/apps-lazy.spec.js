'use strict';
/* global window */
const { test, expect } = require('@playwright/test');

test('应用中心按需加载子应用并保持法规脚本执行顺序', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ home: true }));
    await expect(page.locator('#apps-workbench-modal')).toBeVisible();
    await expect(page.locator('script[src*="apps-workbench-regulations.js"]')).toHaveCount(0);
    await expect(page.locator('script[src*="apps-workbench-presentations.js"]')).toHaveCount(0);
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'regulations' }));
    await expect(page.locator('#regulations-view')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('script[src*="regulations/events.js"]')).toHaveCount(1);
    expect(errors).toEqual([]);
});
