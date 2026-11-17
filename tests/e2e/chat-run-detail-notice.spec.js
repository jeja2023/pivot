/* global window */
'use strict';
const { test, expect } = require('@playwright/test');

test('对话任务详情的完整记录提示可阅读、重试，刷新和切换不会产生重复内容', async ({ page }) => {
    test.setTimeout(90000);
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    let fullCount = 0, fail = true;
    await page.route(/\/api\/agents\/runs\/chat-detail-[ab](?:\?.*)?$/, async route => {
        const url = new URL(route.request().url()), id = url.pathname.split('/').at(-1), overview = url.searchParams.get('view') === 'overview';
        if (!overview) {
            fullCount++;
            if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: '完整记录暂不可用' } }); }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return route.fulfill({ json: { run: { id, title: `对话任务 ${id}`, goal: `独立目标 ${id}`, status: 'cancelled', run_mode: 'standard', tool_policy: 'builtin_only', metadata: {} },
            steps: [{ id: 1, step_index: 1, type: 'plan', title: overview ? '最近执行记录' : '完整执行记录', status: 'success' }],
            dagNodes: [], progress: { stepCount: 1, roundCount: 1, maxSteps: 30 }, trace: null, checkpoints: { total: 0 },
            diagnosticsDeferred: overview, warnings: overview ? [{ code: 'DIAGNOSTICS_DEFERRED' }] : [] } });
    });
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.ensureWorkspaceScripts));
    await page.evaluate(async () => { await window.Pivot.legacy.ensureWorkspaceScripts('agent'); });
    await page.evaluate(() => window.Pivot.moduleApi('agent.detailLoader').openFromChat('chat-detail-a'));
    const modal = page.locator('#agent-run-detail-modal'), detail = modal.locator('#agent-run-detail'), notice = detail.locator('[data-agent-detail-notice]');
    await expect(modal).toBeVisible();
    await expect(notice).toHaveCount(1);
    const button = notice.getByRole('button', { name: '加载完整记录与诊断' });
    for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(button).toBeVisible();
        await expect.poll(() => notice.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await page.setViewportSize({ width: 1366, height: 844 });
    await button.focus();
    await page.evaluate(async () => { for (let i = 0; i < 3; i++) await window.Pivot.legacy.openAgentRun('chat-detail-a', { silent: true }); });
    await expect(notice).toHaveCount(1);
    await expect(button).toBeFocused();
    await button.click();
    await expect(notice).toContainText('完整记录暂不可用');
    await expect(detail).toContainText('独立目标 chat-detail-a');
    await notice.getByRole('button', { name: '重试加载完整记录' }).click();
    await page.evaluate(() => window.Pivot.legacy.openAgentRun('chat-detail-a', { silent: true }));
    await expect(notice).toHaveCount(0);
    await expect(detail).toContainText('完整执行记录');
    expect(fullCount).toBe(2);
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => window.Pivot.moduleApi('agent.detailLoader').openFromChat('chat-detail-b'));
    await expect(modal).toBeVisible();
    await expect(notice).toHaveCount(1);
    await expect(detail).toContainText('独立目标 chat-detail-b');
    await expect(detail).not.toContainText('独立目标 chat-detail-a');
});
