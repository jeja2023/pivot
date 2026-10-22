/* global window -- 浏览器执行上下文 */
const { test, expect } = require('@playwright/test');

test('Responses 结束快照不重复正文，流式完成和刷新历史均只显示一次', async ({ page }) => {
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const headers = { 'x-csrf-token': csrf };
    const name = `回复重复回归 ${Date.now()}`;
    const createdModel = await page.request.post('/api/models', { headers, data: { name, url: process.env.E2E_MODEL_URL,
        model_name: 'gpt-5.6-e2e-stream-snapshot', supports_reasoning: 1, chat_thinking_enabled: 0 } });
    expect(createdModel.ok()).toBeTruthy();
    const list = await (await page.request.get('/api/models?limit=100')).json();
    const model = list.data.find(item => item.name === name);
    expect(model).toBeTruthy();
    const originalDefault = list.data.find(item => Number(item.is_default) === 1);
    try {
        expect((await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: model.id } })).ok()).toBeTruthy();
        const createdSession = await page.request.post('/api/sessions', { headers, data: { title: '回复内容去重回归' } });
        expect(createdSession.ok()).toBeTruthy();
        const session = await createdSession.json();
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#app')).toBeVisible();
        await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
        await expect(page.locator('#model-selector')).toHaveValue(String(model.id));
        await page.locator('#user-input').fill('你好，请解释一次普通对话。');
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chat');
        await page.locator('#send-btn').click();
        const response = await responsePromise;
        expect(response.ok()).toBeTruthy();
        await response.finished();
        const expected = 'Responses 流式回复只显示一次。';
        const streamed = (await response.text()).split(/\r?\n/).filter(line => line.startsWith('data: {'))
            .map(line => JSON.parse(line.slice(6))).filter(event => !event.type && typeof event.content === 'string')
            .map(event => event.content).join('');
        expect(streamed).toBe(expected);
        await expect(page.locator('#message-container .message.assistant .text-body')).toHaveText(expected);
        const history = await (await page.request.get(`/api/sessions/${session.id}`)).json();
        const answers = history.messages.filter(message => message.role === 'assistant');
        expect(answers).toHaveLength(1);
        expect(answers[0].content).toBe(expected);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
        await expect(page.locator('#message-container .message.assistant .text-body')).toHaveText(expected);
    } finally {
        if (originalDefault?.id) {
            await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: originalDefault.id } }).catch(() => {});
        }
    }
});
