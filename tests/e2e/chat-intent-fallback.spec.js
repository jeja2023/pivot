'use strict';
/* global window */
const { test, expect } = require('@playwright/test');

test('前置意图超时后脚本请求继续文本回复，刷新保留结果且不新建任务', async ({ page }) => {
    test.setTimeout(60000);
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const name = `意图降级回归模型${Date.now()}`;
    expect((await page.request.post('/api/models', { headers, data: { name, url: process.env.E2E_MODEL_URL, model_name: 'e2e-real-model' } })).ok()).toBeTruthy();
    const model = (await (await page.request.get('/api/models?limit=100')).json()).data.find(item => item.name === name);
    expect((await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: model.id } })).ok()).toBeTruthy();
    const session = await (await page.request.post('/api/sessions', { headers, data: { title: '意图超时文本降级' } })).json();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
    await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
    await expect(page.locator('#model-selector')).toHaveValue(String(model.id));
    await page.locator('#user-input').fill('生成一个贪吃蛇的python脚本 E2E_SEMANTIC_DELAY');
    const response = page.waitForResponse(value => value.url().endsWith('/api/chat') && value.request().method() === 'POST');
    await page.locator('#send-btn').click();
    await expect(page.locator('#message-container')).toContainText('真实 E2E 流式回答', { timeout: 30000 });
    const events = await (await response).text();
    expect(events).not.toContain('无法可靠判断'); expect(events).not.toContain('"automatic_execution"');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
    await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
    await expect(page.locator('#message-container .message.assistant')).toHaveCount(1);
    await expect(page.locator('#message-container .message.assistant')).toContainText('真实 E2E 流式回答');
});
