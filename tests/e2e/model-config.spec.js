'use strict';
/* global window */
const { expect, test } = require('@playwright/test');
const http = require('node:http');
const os = require('node:os');

test('模型连接测试访问隔离服务并区分可连接与认证失败', async ({ page }) => {
    const address = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
    test.skip(!address, '需要可绑定的私网地址，避免放宽回环安全策略。');
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.headers.authorization === 'Bearer invalid-test-key') {
            res.writeHead(401); res.end(JSON.stringify({ error: { message: '测试密钥无效' } }));
        } else {
            res.end(JSON.stringify({ data: [{ id: 'e2e-real-model' }] }));
        }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve); });
    try {
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const input = { source: 'manual', url: `http://${address}:${server.address().port}/v1`, model_name: 'e2e-real-model' };
    const success = await page.request.post('/api/models/test', { headers, data: input });
    expect(success.ok()).toBeTruthy();
    expect((await success.json()).success).toBe(true);
    const denied = await page.request.post('/api/models/test', { headers, data: { ...input, api_key: 'invalid-test-key' } });
    expect(denied.ok()).toBeTruthy();
    const body = await denied.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('测试密钥无效');
    expect(JSON.stringify(body)).not.toContain('invalid-test-key');
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('模型连接测试不保存或关闭弹窗，保存一次并可编辑可用范围', async ({ page }) => {
    test.setTimeout(90000);
    let tests = 0;
    let creates = 0;
    let testResult = true;
    await page.route('**/api/models/test', async route => {
        const body = route.request().postDataJSON();
        if (body.source === 'manual' && !body.id) tests++;
        await route.fulfill({ status: 200, json: testResult ? { success: true, message: '连接成功' } : { success: false, error: '测试服务不可用' } });
    });
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/models' && request.method() === 'POST') creates++;
    });
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false }));
    await page.locator('#tab-models').click();
    await page.locator('#model-add-btn').click();
    const modal = page.locator('#model-modal-container');
    await expect(modal).toBeVisible();
    const modelName = `范围测试${Date.now()}`;
    await page.locator('#m-name').fill(modelName);
    await page.locator('#m-url').fill('https://models.example.com/v1');
    await page.locator('#m-model').fill('scope-test');
    await page.locator('#modal-model-test').click();
    await expect.poll(() => tests).toBe(1);
    await expect(modal).toBeVisible();
    await expect(page.locator('#m-name')).toHaveValue(modelName);
    expect(creates).toBe(0);
    testResult = false;
    await expect(page.locator('#modal-model-test')).toBeEnabled();
    await page.locator('#modal-model-test').click();
    await expect.poll(() => tests).toBe(2);
    await expect(modal).toBeVisible();
    expect(creates).toBe(0);
    await page.locator('#m-submit-btn').click();
    await expect(modal).toBeHidden();
    await expect.poll(() => creates).toBe(1);
    const list = await page.request.get('/api/models?limit=100');
    const matches = (await list.json()).data.filter(item => item.name === modelName);
    expect(matches).toHaveLength(1);
    const row = page.locator(`#model-row-${matches[0].id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('仅本人');
    await row.locator('[data-model-action="edit"]').click();
    await expect(page.locator('#m-scope')).toBeEnabled();
    await expect(page.locator('label[for="m-scope"]')).toHaveText('可用范围');
    await page.locator('#m-scope').selectOption('global');
    await expect(page.locator('#m-units')).toBeEnabled();
    await page.locator('#m-units').fill('研发部');
    await page.locator('#m-submit-btn').click();
    await expect(modal).toBeHidden();
    await expect.poll(async () => (await (await page.request.get('/api/models?limit=100')).json()).data.find(item => item.id === matches[0].id)?.allowed_units).toBe('研发部');
    const updated = (await (await page.request.get('/api/models?limit=100')).json()).data.find(item => item.id === matches[0].id);
    expect(updated.user_id).toBeNull();
    await expect(row).toContainText('研发部');
    await row.locator('[data-model-action="edit"]').click();
    await expect(page.locator('#m-scope')).toHaveValue('global');
    await page.locator('#m-scope').selectOption('personal');
    await expect(page.locator('#m-units')).toBeDisabled();
    await page.locator('#m-submit-btn').click();
    await expect(modal).toBeHidden();
    await expect.poll(async () => (await (await page.request.get('/api/models?limit=100')).json()).data.find(item => item.id === matches[0].id)?.user_id).not.toBeNull();
    const personal = (await (await page.request.get('/api/models?limit=100')).json()).data.find(item => item.id === matches[0].id);
    expect(personal.allowed_units || '').toBe('');
});
