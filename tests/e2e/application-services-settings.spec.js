'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

test('模型与应用服务独立导航，直接展示全部服务，现有弹窗可用且刷新恢复入口', async ({ page }) => {
    test.setTimeout(90000);
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'models' }));
    await expect(page.locator('#retrieval-model-services-body')).toContainText('向量生成服务'); await expect(page.locator('#retrieval-model-services-body')).toContainText('重排序服务');
    await expect(page.locator('#retrieval-model-services-body')).not.toContainText('OCR'); await expect(page.locator('#retrieval-model-services-body')).not.toContainText('语音识别');
    await expect(page.locator('#retrieval-model-services-body')).not.toContainText('PPT Master');
    const before = await (await page.request.get('/api/settings/ppt-master')).json();
    await page.locator('#tab-app-services').click(); await expect(page.locator('#application-services-body [data-application-service]')).toHaveCount(3);
    await expect(page.locator('#application-services-search')).toHaveCount(0);
    for (const id of ['ocr', 'speech', 'ppt-master']) await expect(page.locator(`[data-application-service="${id}"]`)).toBeVisible();
    await page.locator('[data-retrieval-model-config-open="ocr"]').click(); await expect(page.locator('#setting-ocr-service-url')).toBeVisible();
    await page.locator('#ocr-service-modal [data-retrieval-modal-cancel]').click();
    await page.locator('[data-speech-config-open]').click(); await expect(page.locator('#speech-endpoint')).toBeAttached(); await page.locator('[data-speech-close]').first().click();
    await page.locator('[data-ppt-service-config-open]').click(); await expect(page.locator('#ppt-master-endpoint')).toBeEnabled(); await page.locator('[data-ppt-service-close]').click();
    expect((await (await page.request.get('/api/settings/ppt-master')).json()).config.revision).toBe(before.config.revision);
    const evidence = path.resolve('artifacts/application-services-settings-acceptance'); await fs.mkdir(evidence, { recursive: true });
    await page.locator('#tab-content-app-services').screenshot({ path: path.join(evidence, 'desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const dimensions = await page.locator('#tab-content-app-services').evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth })); expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
    await page.locator('#tab-content-app-services').screenshot({ path: path.join(evidence, 'mobile.png') });
    await page.locator('[data-ppt-service-config-open]').click(); await expect(page.locator('#ppt-master-endpoint')).toBeEnabled(); await page.locator('[data-ppt-service-close]').click();
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ restore: true }));
    await expect(page.locator('#tab-content-app-services')).toBeVisible(); await expect(page.locator('#application-services-body [data-application-service]')).toHaveCount(3);
    await page.locator('#tab-models').click(); await expect(page.locator('#tab-content-models')).toBeVisible(); await expect(page.locator('#tab-content-app-services')).toBeHidden();
});

test('完整的全站PPT配置在系统admin和其他管理员中都显示绿色，只读账号不获得配置权限', async ({ page, browser }) => {
    test.setTimeout(90000);
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const username = 'ppt_status_' + Date.now(), password = 'PptStatus123!';
    const created = await page.request.post('/api/admin/users', { headers: { 'x-csrf-token': csrf }, data: { username, password, nickname: 'PPT状态验证', role: 'admin' } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const context = await browser.newContext(), member = await context.newPage();
    try {
        expect((await member.request.post('/api/auth/login', { data: { username, password } })).ok()).toBeTruthy();
        for (const [target, canManage] of [[page, true], [member, false]]) {
            await target.route('**/api/settings', async route => {
                const response = await route.fetch(), settings = await response.json();
                settings.pptMasterConfig = { ...settings.pptMasterConfig, enabled: true, configured: true, hasToken: true, endpoint: canManage ? 'http://ppt-status:8502' : '********' };
                await route.fulfill({ response, json: settings });
            });
            await target.goto('/chat', { waitUntil: 'domcontentloaded' });
            await target.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
            await target.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'app-services' }));
            const card = target.locator('#ppt-master-service-card');
            await expect(card).toHaveClass(/is-ready/); await expect(card).not.toHaveClass(/is-warning/);
            await expect(card.locator('[data-ppt-service-config-open]')).toHaveCount(canManage ? 1 : 0);
            await expect(card.locator('[data-ppt-service-test-card]')).toHaveCount(canManage ? 1 : 0);
            if (!canManage) { await expect(card).not.toContainText('http://ppt-status'); expect((await target.request.get('/api/settings/ppt-master')).status()).toBe(403); }
        }
    } finally { await context.close(); }
});

test('刷新时先清空旧连接信息，切走后迟到的状态不会改写其他设置分区', async ({ page }) => {
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'app-services' })); await expect(page.locator('#application-services-body [data-application-service]')).toHaveCount(3);
    const saved = await (await page.request.get('/api/settings')).json();
    let started, release; const arrived = new Promise(resolve => started = resolve), pending = new Promise(resolve => release = resolve); let delayed = false;
    await page.route('**/api/settings', async route => {
        if (!delayed) { delayed = true; started(); await pending; await route.fulfill({ json: saved }).catch(() => {}); }
        else await route.continue();
    });
    await page.locator('#application-services-refresh').click(); await arrived;
    await expect(page.locator('#application-services-loading')).toBeVisible(); await expect(page.locator('#application-services-body [data-application-service]')).toHaveCount(0);
    await page.locator('#tab-models').click(); await expect(page.locator('#tab-content-models')).toBeVisible(); release();
    await page.locator('#tab-app-services').click(); await expect(page.locator('#application-services-body [data-application-service]')).toHaveCount(3);
    await expect(page.locator('#tab-content-models')).toBeHidden();
});

test('应用服务页保持管理员可见和系统admin配置边界，普通账号不能直接打开', async ({ page, browser }) => {
    test.setTimeout(90000);
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    for (const role of ['admin', 'user']) {
        const username = 'appservices_' + role + '_' + Date.now(), password = 'AppServices123!';
        const created = await page.request.post('/api/admin/users', { headers: { 'x-csrf-token': csrf }, data: { username, password, nickname: '应用服务权限验证', unit: 'QA', role } });
        expect(created.ok(), await created.text()).toBeTruthy();
        const context = await browser.newContext(); const member = await context.newPage();
        try {
            expect((await member.request.post('/api/auth/login', { data: { username, password } })).ok()).toBeTruthy();
            await member.goto('/chat', { waitUntil: 'domcontentloaded' }); await member.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
            await member.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'app-services' }));
            if (role === 'admin') {
                await expect(member.locator('#tab-content-app-services')).toBeVisible(); await expect(member.locator('#application-services-body [data-application-service]')).toHaveCount(3);
                await expect(member.locator('#application-services-body [data-ppt-service-config-open]')).toHaveCount(0);
                await expect(member.locator('#application-services-body [data-speech-config-open]')).toHaveCount(0);
                await expect(member.locator('#application-services-body [data-retrieval-model-config-open="ocr"]')).toHaveCount(0);
            } else {
                await expect(member.locator('#tab-app-services')).toBeHidden(); await expect(member.locator('#tab-content-app-services')).toBeHidden(); await expect(member.locator('#tab-content-models')).toBeVisible();
            }
            expect((await member.request.get('/api/settings/ppt-master')).status()).toBe(403);
        } finally { await context.close(); }
    }
});
