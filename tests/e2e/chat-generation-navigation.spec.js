/* global window, document */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { queryOne } = require('../../server/db/client');

test('普通回复切换会话仍继续，切回恢复部分正文，另一会话发送与停止互不影响', async ({ page }) => {
    test.setTimeout(90000);
    const streams = new Map();
    const provider = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const input = JSON.parse(body || '{}');
            const text = JSON.stringify(input.messages || []);
            if (input.stream !== true) {
                const intent = text.includes('你是对话下一步决策器');
                const result = intent ? JSON.stringify({ action: 'direct_answer', objective: '解释测试内容', requiredCapabilities: [],
                    evidenceRefs: ['current_message'], routing: { knowledge: 'none', tools: 'none' } }) : '生成测试';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: result } }] })); return;
            }
            const key = text.includes('甲会话独立生成') ? 'a' : 'b';
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${key === 'a' ? '甲' : '乙'}第一段正文。${'生成中的说明内容。'.repeat(24)}` } }] })}\n\n`);
            const state = { res, closed: false };
            res.on('close', () => { state.closed = true; }); streams.set(key, state);
        });
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const headers = { 'x-csrf-token': csrf };
    const user = await queryOne("SELECT id FROM users WHERE username='admin'");
    const model = await queryOne("INSERT INTO models(user_id,name,url,model_name,status,max_concurrent) VALUES (?,'会话生成回归',?,'navigation-test','active',2) RETURNING id", [user.id, `http://127.0.0.1:${provider.address().port}/v1`]);
    const ids = [];
    try {
        for (const title of ['甲会话', '乙会话']) {
            const response = await page.request.post('/api/sessions', { headers, data: { title } });
            expect(response.ok()).toBeTruthy(); ids.push((await response.json()).id);
        }
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#app')).toBeVisible();
        await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('chat.generations').run));
        await page.evaluate(id => { document.getElementById('model-selector').value = String(id); }, model.id);
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), ids[0]);
        await page.locator('#user-input').fill('请解释甲会话独立生成的含义');
        await page.locator('#send-btn').click();
        await expect(page.locator('.message.assistant .text-body')).toContainText('甲第一段正文');
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), ids[1]);
        expect(streams.get('a').closed).toBe(false);
        await expect(page.locator('#send-btn')).toBeVisible();
        await page.locator('#user-input').fill('请解释乙会话独立生成的含义');
        await page.locator('#send-btn').click();
        await expect(page.locator('.message.assistant .text-body')).toContainText('乙第一段正文');
        expect(streams.get('a').closed).toBe(false);
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), ids[0]);
        await expect(page.locator('.message.assistant .text-body')).toContainText('甲第一段正文');
        expect(await page.locator('.message.assistant').count()).toBe(1);
        await expect(page.locator('#stop-btn')).toBeVisible();
        streams.get('a').res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `甲第二段正文。${'继续补充的说明内容。'.repeat(24)}` } }] })}\n\n`);
        await expect(page.locator('.message.assistant .text-body')).toContainText('甲第二段正文');
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), ids[1]);
        await page.locator('#stop-btn').click();
        await expect.poll(() => streams.get('b').closed).toBe(true);
        await expect.poll(async () => (await queryOne("SELECT content FROM messages WHERE session_id=? AND role='assistant' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [ids[1]]))?.content).toContain('乙第一段正文');
        await expect(page.locator('.message.assistant .text-body')).toContainText('乙第一段正文');
        expect(streams.get('a').closed).toBe(false);
        streams.get('a').res.end('data: {"choices":[{"delta":{"content":"，甲完整结束"}}]}\n\ndata: [DONE]\n\n');
        await expect.poll(async () => (await queryOne("SELECT content FROM messages WHERE session_id=? AND role='assistant' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [ids[0]]))?.content).toContain('甲完整结束');
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), ids[0]);
        for (const text of ['甲第一段正文', '甲第二段正文', '甲完整结束']) await expect(page.locator('.message.assistant .text-body')).toContainText(text);
        await expect(page.locator('.message.assistant')).toHaveCount(1);
        await expect(page.locator('#send-btn')).toBeVisible();
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), ids[1]);
        await expect(page.locator('.message.assistant .text-body')).toContainText('乙第一段正文');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#app')).toBeVisible();
        await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), ids[1]);
        await expect(page.locator('.message.assistant .text-body')).toContainText('乙第一段正文');
        await expect(page.locator('.message.assistant .text-body')).toContainText('生成已中止');
        await expect(page.locator('.message.assistant')).toHaveCount(1);
        await fs.mkdir(path.resolve('output/chat-generations'), { recursive: true });
        await page.screenshot({ path: path.resolve('output/chat-generations/stopped-session-after-reload.png'), fullPage: true });
        await page.evaluate(id => window.Pivot.legacy.selectSession(id), ids[0]);
        await fs.mkdir(path.resolve('output/chat-generations'), { recursive: true });
        await page.screenshot({ path: path.resolve('output/chat-generations/completed-session.png'), fullPage: true });
    } finally {
        for (const stream of streams.values()) stream.res.destroy();
        provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    }
});
