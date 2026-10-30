'use strict';
/* global window -- 浏览器执行上下文 */
const { test, expect } = require('@playwright/test');

test('空模型回复显示错误并可在刷新后恢复，新消息仍可正常发送', async ({ page }) => {
    test.setTimeout(60_000);
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const list = await (await page.request.get('/api/models?limit=100')).json();
    const originalDefault = list.data.find(item => Number(item.is_default) === 1);
    const name = `空回复测试${Date.now()}`;
    const created = await page.request.post('/api/models', { headers, data: { name, url: process.env.E2E_MODEL_URL, model_name: 'pivot-e2e-empty-response' } });
    expect(created.ok()).toBeTruthy();
    const model = (await (await page.request.get('/api/models?limit=100')).json()).data.find(item => item.name === name);
    try {
        expect((await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: model.id } })).ok()).toBeTruthy();
        const session = await (await page.request.post('/api/sessions', { headers, data: { title: '空回复回归' } })).json();
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
        await expect(page.locator('#model-selector')).toHaveValue(String(model.id));
        await page.locator('#user-input').fill('请解释基础概念。');
        await page.locator('#send-btn').click();
        await expect(page.locator('#message-container')).toContainText('模型返回空回复', { timeout: 30_000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
        await expect(page.locator('#message-container')).toContainText('模型返回空回复');
        await expect(page.locator('#user-input')).toBeEnabled();
        await page.locator('#user-input').fill('请再次发送。');
        await page.locator('#send-btn').click();
        await expect(page.locator('#message-container .message.assistant')).toHaveCount(2, { timeout: 30_000 });
        await expect(page.locator('#message-container .message.assistant').last()).toContainText('模型返回空回复');
    } finally {
        if (originalDefault?.id) await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: originalDefault.id } }).catch(() => {});
    }
});
