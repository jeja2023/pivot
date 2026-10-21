/* global window -- Playwright 浏览器端执行上下文 */
const path = require('node:path');
const { test, expect } = require('@playwright/test');

test('聊天知识问答等待补充时保留答案，继续同一运行只复用一张卡片', async ({ page }) => {
    const login = await page.request.post('/api/auth/login', {
        data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' }
    });
    expect(login.ok()).toBeTruthy();
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const created = await page.request.post('/api/sessions', { headers: { 'x-csrf-token': csrf }, data: { title: '知识问答状态回归' } });
    expect(created.ok()).toBeTruthy();
    const session = await created.json();
    let resumed = false;
    let detailReads = 0;
    const run = () => ({ id: 'run-knowledge-wait', status: 'needs_input', session_id: session.id, model_name: '知识问答模型',
        input_tokens: 12000, output_tokens: 2067, total_tokens: 14067, started_at: '2026-10-20 08:00:00', updated_at: '2026-10-20 08:02:10',
        final_answer: resumed ? '补充后的知识库答案。' : '已经生成的知识库答案。', error_message: '资料尚未覆盖补充条款，请补充来源后继续。' });
    await page.route(/\/api\/agents\/runs\/chat-active(?:\?.*)?$/, route => route.fulfill({
        json: { runs: new URL(route.request().url()).searchParams.get('sessionId') === String(session.id) ? [run(), run(), run()] : [] }
    }));
    await page.route('**/api/agents/runs/run-knowledge-wait/chat-feed?*', route => {
        detailReads += 1;
        return route.fulfill({ json: { run: { ...run(), waiting: true, terminal: false }, events: [], legacySteps: [],
            cursor: { eventSeq: resumed ? 2 : 1 }, nextAfter: resumed ? 2 : 1, older: { hasMore: false },
            artifacts: [], verification: { status: 'unknown' }, pollAfterMs: null } });
    });
    await page.route('**/api/agents/runs/run-knowledge-wait/resume', route => {
        resumed = true;
        return route.fulfill({ status: 202, json: { success: true, run: { ...run(), status: 'queued' } } });
    });
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible();
    await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
    await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
    const card = page.locator('[data-chat-agent-run-id="run-knowledge-wait"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('已经生成的知识库答案');
    await expect(card).toContainText('资料尚未覆盖补充条款');
    await expect(card).toContainText('累计模型用量 14067 Tokens');
    await expect(card).not.toContainText('正在规划任务');
    await page.evaluate(id => Promise.all(Array.from({ length: 3 }, () => window.Pivot.legacy.attachChatAgentRunsForSession(id))), session.id);
    await expect(card).toHaveCount(1);
    await page.waitForTimeout(250);
    const initialReads = detailReads;
    await page.waitForTimeout(1400);
    expect(detailReads).toBe(initialReads);
    await card.getByRole('button', { name: '从上次执行位置继续任务', exact: true }).click();
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('补充后的知识库答案');
    expect(detailReads).toBe(initialReads + 1);
    await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/knowledge-agent-waiting.png') });
});
