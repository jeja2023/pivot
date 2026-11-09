'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

test('admin在页面测试、更换和停用PPT服务，配置即时生效并加密保留，密钥不回显', async ({ page }) => {
    test.setTimeout(120000);
    const token = 'a'.repeat(64), replacement = 'b'.repeat(64), seen = [], runtimeId = 'sha256:' + 'c'.repeat(64);
    const create = secret => http.createServer((req, res) => {
        seen.push({ port: req.socket.localPort, authorization: req.headers.authorization });
        res.setHeader('Content-Type', 'application/json');
        if (req.url !== '/v1/info' || req.headers.authorization !== 'Bearer ' + secret) { res.writeHead(401); return res.end(JSON.stringify({ error: { code: 'PPT_SERVICE_UNAUTHORIZED', message: '服务拒绝访问' } })); }
        res.end(JSON.stringify({ status: 'ready', serviceProtocol: 1, version: 'service-settings-test', revision: 'service-commit', runtimeId, capabilities: ['files', 'operations', 'cancel', 'native', 'templates'] }));
    });
    const first = create(token), second = create(replacement);
    await Promise.all([new Promise(resolve => first.listen(0, '127.0.0.1', resolve)), new Promise(resolve => second.listen(0, '127.0.0.1', resolve))]);
    const endpoint = 'http://127.0.0.1:' + first.address().port, changedEndpoint = 'http://127.0.0.1:' + second.address().port;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'app-services' }));
        await page.locator('[data-ppt-service-config-open]').click(); await expect(page.locator('#ppt-master-endpoint')).toBeEnabled();
        await page.locator('#ppt-master-enabled').check(); await page.locator('#ppt-master-endpoint').fill(endpoint); await page.locator('#ppt-master-token').fill(token);
        await page.locator('#ppt-master-config-test').click(); await expect(page.locator('#ppt-master-config-status')).toContainText('协议检查通过');
        const unsaved = (await (await page.request.get('/api/settings/ppt-master')).json()).config; expect(unsaved.source).toBe('environment');
        await page.locator('#ppt-master-config-save').click(); await expect(page.locator('#ppt-master-config-status')).toContainText('已保存并立即应用');
        await expect(page.locator('#ppt-master-token')).toHaveValue('');
        const settings = await (await page.request.get('/api/settings')).json(); expect(settings.pptMasterConfig.endpoint).toBe(endpoint); expect(settings.pptMasterConfig.hasToken).toBe(true);
        expect(JSON.stringify(settings)).not.toContain(token);
        const ready = await (await page.request.get('/api/apps/presentations/master/info')).json(); expect(ready.engine.enabled).toBe(true); expect(ready.engine.version).toBe('service-settings-test');
        const evidence = path.resolve('artifacts/ppt-master-settings-acceptance'); await fs.mkdir(evidence, { recursive: true });
        await page.locator('#ppt-master-service-modal .model-modal').screenshot({ path: path.join(evidence, 'desktop.png') });
        await page.locator('[data-ppt-service-close]').click();
        await expect(page.locator('#ppt-master-service-card')).toContainText(endpoint);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'app-services' }));
        await page.locator('[data-ppt-service-config-open]').click(); await expect(page.locator('#ppt-master-endpoint')).toHaveValue(endpoint); await expect(page.locator('#ppt-master-token')).toHaveValue('');
        await page.locator('#ppt-master-endpoint').fill(changedEndpoint); await page.locator('#ppt-master-config-test').click(); await expect(page.locator('#ppt-master-config-status')).toContainText('新服务的密钥');
        expect(seen.filter(item => item.port === second.address().port)).toHaveLength(0);
        await page.locator('#ppt-master-token').fill(replacement); await page.locator('#ppt-master-config-test').click(); await expect(page.locator('#ppt-master-config-status')).toContainText('协议检查通过');
        const beforeApply = (await (await page.request.get('/api/settings/ppt-master')).json()).config; expect(beforeApply.endpoint).toBe(endpoint);
        await page.locator('#ppt-master-config-save').click(); await expect(page.locator('#ppt-master-config-status')).toContainText('已保存并立即应用');
        expect((await (await page.request.get('/api/apps/presentations/master/info')).json()).engine.enabled).toBe(true);
        expect(seen.filter(item => item.port === second.address().port).every(item => item.authorization === 'Bearer ' + replacement)).toBe(true);
        await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#ppt-master-service-modal .model-modal').screenshot({ path: path.join(evidence, 'mobile.png') });
        const size = await page.locator('#ppt-master-service-modal .model-modal').evaluate(element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth, client: element.clientWidth }));
        expect(size.width).toBeLessThanOrEqual(390); expect(size.scroll).toBeLessThanOrEqual(size.client + 1);
        await page.locator('#ppt-master-enabled').uncheck(); await page.locator('#ppt-master-config-save').click(); await expect(page.locator('#ppt-master-config-status')).toContainText('已保存并立即应用');
        expect((await (await page.request.get('/api/apps/presentations/master/info')).json()).engine.enabled).toBe(false);
        const stored = await (await page.request.get('/api/settings/ppt-master')).json(); expect(stored.config.enabled).toBe(false); expect(stored.config.hasToken).toBe(true); expect(JSON.stringify(stored)).not.toContain(replacement);
        expect(errors).toEqual([]);
    } finally { first.closeAllConnections(); second.closeAllConnections(); await Promise.all([new Promise(resolve => first.close(resolve)), new Promise(resolve => second.close(resolve))]); }
});

test('关闭后旧配置响应不能覆盖重新打开时的管理员输入', async ({ page }) => {
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    let resolveOld, firstArrived;
    const old = new Promise(resolve => resolveOld = resolve), arrived = new Promise(resolve => firstArrived = resolve); let count = 0;
    await page.route('**/api/settings/ppt-master', async route => {
        count++;
        if (count === 1) { firstArrived(); await old; await route.fulfill({ json: { success: true, config: { revision: 'old', enabled: false, endpoint: 'http://old-service:8502', hasToken: true, canManage: true, source: 'settings' } } }).catch(() => {}); }
        else await route.fulfill({ json: { success: true, config: { revision: 'new', enabled: false, endpoint: 'http://new-service:8502', hasToken: true, canManage: true, source: 'settings' } } });
    });
    await page.goto('/chat', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')?.openAdminPanel));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel({ tab: 'app-services' }));
    await page.locator('[data-ppt-service-config-open]').click(); await arrived; await page.locator('[data-ppt-service-close]').click();
    await page.locator('[data-ppt-service-config-open]').click(); await expect(page.locator('#ppt-master-endpoint')).toHaveValue('http://new-service:8502');
    await page.locator('#ppt-master-endpoint').fill('http://editing-service:8502'); resolveOld();
    await expect(page.locator('#ppt-master-endpoint')).toHaveValue('http://editing-service:8502'); await expect(page.locator('#ppt-master-token')).toHaveValue('');
    await page.locator('[data-ppt-service-close]').click();
});
