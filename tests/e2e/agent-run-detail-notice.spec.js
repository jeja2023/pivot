/* global window */
'use strict';
const { test, expect } = require('@playwright/test');

test('任务详情只展示一个可操作的完整记录提示，失败可重试且切换任务不串数据', async ({ page }) => {
    test.setTimeout(90000);
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const runs = ['detail-a', 'detail-b', 'detail-c', 'detail-d'].map(id => ({ id, title: `任务 ${id}`, goal: `目标 ${id}`, status: 'cancelled', run_mode: 'standard', tool_policy: 'builtin_only', metadata: {}, created_at: '2026-11-17 10:00:00' }));
    let fullRequests = 0, failFull = true, failOverview = true;
    await page.route(/\/api\/agents\/runs\?.*$/, route => route.fulfill({ json: { data: runs, total: runs.length, page: 1, limit: 20 } }));
    await page.route(/\/api\/agents\/runs\/detail-[abcd](?:\?.*)?$/, async route => {
        const url = new URL(route.request().url()), id = url.pathname.split('/').at(-1), run = runs.find(item => item.id === id);
        const overview = url.searchParams.get('view') === 'overview';
        if (overview && id === 'detail-c' && failOverview) { failOverview = false; return route.fulfill({ status: 503, json: { error: '详情暂不可用' } }); }
        if (id === 'detail-d') await new Promise(resolve => setTimeout(resolve, 1200));
        if (!overview) {
            fullRequests++;
            if (failFull) { failFull = false; return route.fulfill({ status: 503, json: { error: '完整记录暂不可用' } }); }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return route.fulfill({ json: { run, steps: [{ id: 1, step_index: 1, type: 'plan', title: overview ? '最近记录' : '完整记录', status: 'success' }],
            dagNodes: [], progress: { stepCount: 1, roundCount: 1, maxSteps: 30 }, trace: null, checkpoints: { total: 0 },
            diagnosticsDeferred: overview, warnings: overview ? [{ code: 'DIAGNOSTICS_DEFERRED' }] : [] } });
    });
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench({ tab: 'tasks' }));
    await page.waitForFunction(() => typeof window.Pivot.legacy.openAgentRun === 'function');
    await page.evaluate(() => window.Pivot.legacy.openAgentRun('detail-a'));
    const detail = page.locator('#agent-tasks-detail-container'), notice = detail.locator('[data-agent-detail-notice]');
    await expect(detail).toBeVisible();
    await expect(notice).toHaveCount(1);
    await expect(notice.getByRole('button', { name: '加载完整记录与诊断' })).toBeEnabled();
    for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(() => notice.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await expect(notice.getByRole('button', { name: '加载完整记录与诊断' })).toBeVisible();
    }
    await page.setViewportSize({ width: 1366, height: 844 });
    await notice.getByRole('button', { name: '加载完整记录与诊断' }).focus();
    await page.evaluate(async () => { for (let i = 0; i < 3; i++) await window.Pivot.legacy.openAgentRun('detail-a', { silent: true }); });
    await expect(notice).toHaveCount(1);
    await expect(notice.getByRole('button', { name: '加载完整记录与诊断' })).toBeFocused();
    await notice.getByRole('button', { name: '加载完整记录与诊断' }).click();
    await expect(notice).toContainText('完整记录暂不可用');
    await expect(detail.locator('#agent-pane-overview')).toContainText('目标 detail-a');
    await expect(detail.locator('#agent-detail-breadcrumb')).toBeVisible();
    await expect(notice.getByRole('button', { name: '重试加载完整记录' })).toBeEnabled();
    await notice.getByRole('button', { name: '重试加载完整记录' }).click();
    await page.evaluate(() => window.Pivot.legacy.openAgentRun('detail-a', { silent: true }));
    await expect(notice).toHaveCount(0);
    await expect.poll(() => fullRequests).toBe(2);
    await detail.getByRole('tab', { name: /执行步骤/ }).click();
    await expect(detail.locator('#agent-pane-steps')).toContainText('完整记录');
    await page.evaluate(() => { window.detailReruns = 0; window.Pivot.legacy.rerunAgentRun = () => { window.detailReruns++; }; });
    await detail.locator('#agent-detail-header-actions [data-agent-rerun]').click();
    expect(await page.evaluate(() => window.detailReruns)).toBe(1);
    await page.evaluate(() => window.Pivot.legacy.openAgentRun('detail-b'));
    await expect(notice).toHaveCount(1);
    await expect(detail.locator('#agent-pane-overview')).toContainText('目标 detail-b');
    await expect(detail.locator('#agent-pane-overview')).not.toContainText('目标 detail-a');
    await page.evaluate(() => window.Pivot.legacy.openAgentRun('detail-c'));
    await expect(detail.locator('#agent-pane-overview')).toContainText('详情暂不可用');
    await expect(detail.locator('#agent-detail-breadcrumb')).toBeVisible();
    await expect(detail.locator('#agent-pane-overview')).not.toContainText('目标 detail-b');
    await detail.getByRole('button', { name: '重试加载', exact: true }).click();
    await expect(detail.locator('#agent-pane-overview')).toContainText('目标 detail-c');
    await detail.locator('#agent-breadcrumb-back-btn').click();
    await expect(detail).toBeHidden();
    await expect(notice).toHaveCount(0);
    const delayed = page.waitForRequest(request => request.url().includes('/api/agents/runs/detail-d'));
    await page.evaluate(() => { void window.Pivot.legacy.openAgentRun('detail-d'); });
    await delayed;
    await detail.locator('#agent-breadcrumb-back-btn').click();
    await page.waitForTimeout(1500);
    await expect(detail).toBeHidden();
    await expect(notice).toHaveCount(0);
    await page.evaluate(() => window.Pivot.legacy.openAgentRun('detail-b', { workflowPreview: true }));
    const modal = page.locator('#agent-run-detail-modal');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: '加载完整记录与诊断' }).click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-agent-detail-notice]')).toHaveCount(0);
    await expect(modal.locator('#agent-run-detail')).toContainText('完整记录');
});
