'use strict';
/* global window -- 浏览器执行上下文 */
const { test, expect } = require('@playwright/test');

test('停止流式生成后输入恢复可用并可切换模型继续对话', async ({ page }) => {
    test.setTimeout(60_000);
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const name = `停止生成测试${Date.now()}`;
    for (const [label, modelName] of [['slow', 'pivot-e2e-slow-response'], ['fast', 'e2e-real-model']]) {
        const created = await page.request.post('/api/models', { headers, data: { name: `${name}-${label}`, url: process.env.E2E_MODEL_URL, model_name: modelName } });
        expect(created.ok()).toBeTruthy();
    }
    const list = (await (await page.request.get('/api/models?limit=100')).json()).data;
    const slow = list.find(item => item.name === `${name}-slow`);
    const fast = list.find(item => item.name === `${name}-fast`);
    const previous = list.find(item => Number(item.is_default) === 1);
    try {
        expect((await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: slow.id } })).ok()).toBeTruthy();
        const session = await (await page.request.post('/api/sessions', { headers, data: { title: '停止生成回归' } })).json();
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
        await expect(page.locator('#model-selector')).toHaveValue(String(slow.id));
        await page.locator('#user-input').fill('请说明基础概念。');
        await page.locator('#send-btn').click();
        await expect(page.locator('#stop-btn')).toBeVisible();
        await expect(page.locator('#message-container')).toContainText('开始生成', { timeout: 20_000 });
        await page.locator('#stop-btn').click();
        await expect(page.locator('#send-btn')).toBeVisible();
        await page.evaluate(id => window.Pivot.legacy.selectDropdownModel(id, true), fast.id);
        await expect(page.locator('#model-selector')).toHaveValue(String(fast.id));
        await page.locator('#user-input').fill('请再次说明。');
        await page.locator('#send-btn').click();
        await expect(page.locator('#message-container')).toContainText('真实 E2E 流式回答', { timeout: 20_000 });
    } finally {
        if (previous?.id) await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: previous.id } }).catch(() => {});
    }
});
