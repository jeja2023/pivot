'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const path = require('node:path');

async function login(page, username, password) {
    await page.goto('/chat');
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    const response = page.waitForResponse(item => item.url().endsWith('/api/auth/login') && item.request().method() === 'POST', { timeout: 60000 });
    await page.locator('#auth-submit').click();
    expect((await response).status()).toBe(200);
    await expect(page.locator('#app')).toBeVisible({ timeout: 30000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ home: true }));
    await expect(page.locator('[data-app-id="ocr"]')).toBeVisible();
}

async function api(page, path, method = 'GET', body) {
    return page.evaluate(async input => {
        const response = await window.Pivot.api.fetch(input.path, {
            method: input.method,
            ...(input.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.body) })
        });
        return { status: response.status, body: await response.json() };
    }, { path, method, body });
}

test('仅 admin 可在椭圆按钮开关全局应用，覆盖其他管理员、刷新、失败、空列表及窄屏', async ({ page, browser }) => {
    test.setTimeout(180000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await login(page, 'admin', process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    const original = (await api(page, '/api/apps/catalog')).body.apps;
    const contexts = [];
    try {
        const members = [];
        for (const role of ['admin', 'user']) {
            const username = `app_${role}_${Date.now().toString(36)}`;
            const created = await api(page, '/api/admin/users', 'POST', { username, password: 'AppVisibility123!', nickname: '应用开关验收', unit: 'QA', role });
            expect(created.status).toBe(200);
            const context = await browser.newContext();
            contexts.push(context);
            const member = await context.newPage();
            await login(member, username, 'AppVisibility123!');
            await expect(member.locator('[data-app-toggle]')).toHaveCount(0);
            expect((await api(member, '/api/apps/ocr/availability', 'PUT', { enabled: false })).status).toBe(403);
            members.push(member);
        }
        await expect(page.locator('[data-app-toggle]')).toHaveCount(8);
        await page.locator('[data-app-id="mindmaps"]').focus();
        await page.evaluate(() => window.Pivot.moduleApi('apps.availability').refresh());
        await expect(page.locator('[data-app-id="mindmaps"]')).toBeFocused();
        await page.locator('[data-app-toggle="ocr"]').click();
        await expect(page.locator('[data-app-toggle="ocr"]')).toHaveText('开启');
        await expect(page.locator('[data-app-id="ocr"]')).toBeDisabled();
        await page.reload();
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ home: true }));
        await expect(page.locator('[data-app-toggle="ocr"]')).toHaveText('开启');
        await page.screenshot({ path: path.resolve(__dirname, '../../output/app-availability-desktop.png'), fullPage: true });
        for (const member of members) {
            await member.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ home: true }));
            await expect(member.locator('[data-app-id="ocr"]')).toHaveCount(0);
            await member.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'ocr' }));
            await expect(member.locator('#ocr-view')).toBeHidden();
            expect((await api(member, '/api/apps/ocr/jobs')).status).toBe(403);
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('[data-app-toggle="ocr"]')).toBeVisible();
        expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const shape = await page.locator('[data-app-toggle="ocr"]').evaluate(button => ({ radius: parseFloat(window.getComputedStyle(button).borderRadius), height: button.getBoundingClientRect().height }));
        expect(shape.radius).toBeGreaterThanOrEqual(shape.height / 2);
        await page.screenshot({ path: path.resolve(__dirname, '../../output/app-availability-mobile.png'), fullPage: true });
        await page.route('**/api/apps/ocr/availability', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '保存失败，请重试。' }) }));
        await page.locator('[data-app-toggle="ocr"]').click();
        await expect(page.locator('[data-app-toggle="ocr"]')).toHaveText('开启');
        await expect(page.locator('[data-app-toggle="ocr"]')).toBeEnabled();
        expect((await api(page, '/api/apps/catalog')).body.apps.find(app => app.id === 'ocr').enabled).toBe(false);
        await page.unroute('**/api/apps/ocr/availability');
        await page.locator('[data-app-toggle="ocr"]').click();
        await expect(page.locator('[data-app-toggle="ocr"]')).toHaveText('关闭');
        await members[0].evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ home: true }));
        await expect(members[0].locator('[data-app-id="ocr"]')).toBeVisible();

        await members[1].evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'mindmaps' }));
        await expect(members[1].locator('#mindmaps-view')).toBeVisible({ timeout: 15000 });
        await api(page, '/api/apps/mindmaps/availability', 'PUT', { enabled: false });
        await members[1].evaluate(() => window.Pivot.moduleApi('apps.availability').refresh());
        await expect(members[1].locator('#mindmaps-view')).toBeHidden();
        await expect(members[1].locator('#apps-home-view')).toBeVisible();

        for (const app of original) await api(page, `/api/apps/${app.id}/availability`, 'PUT', { enabled: false });
        await members[1].evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ home: true }));
        await expect(members[1].locator('[data-app-id]')).toHaveCount(0);
        await expect(members[1].locator('#apps-empty')).toContainText('暂无已开启的应用');
        await page.route('**/api/apps/catalog', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ home: true }));
        await expect(page.locator('#apps-empty')).toContainText('加载失败');
        await page.unroute('**/api/apps/catalog');
        await page.locator('[data-app-catalog-retry]').click();
        await expect(page.locator('[data-app-toggle]')).toHaveCount(8);
        expect(errors).toEqual([]);
    } finally {
        await page.unroute('**/api/apps/catalog');
        await page.unroute('**/api/apps/ocr/availability');
        for (const app of original) await api(page, `/api/apps/${app.id}/availability`, 'PUT', { enabled: app.enabled });
        for (const context of contexts) await context.close();
    }
});
