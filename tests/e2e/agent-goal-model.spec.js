'use strict';

/* global document, window */
const { expect, test } = require('@playwright/test');
const path = require('node:path');
const { prepareGoalTestModel } = require('../helpers/agent-goal-e2e-model');

async function openGoals(page) {
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    await prepareGoalTestModel(page);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench());
    await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
    await page.locator('[data-agent-cp-subview="goals"]').click();
    await expect(page.locator('#agent-goals-panel')).toBeVisible();
}

for (const width of [1440, 390]) test(`持续目标模型绑定在 ${width}px 下可创建、编辑和测试运行`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await openGoals(page);
    await page.locator('#agent-goal-create').click();
    const model = page.locator('#agent-goal-model');
    await expect(model).toBeEnabled();
    await expect(model).not.toHaveValue('');
    const modelId = Number(await model.inputValue());
    const title = `持续目标模型验证-${width}-${Date.now()}`;
    await page.locator('#agent-goal-title').fill(title);
    await page.locator('#agent-goal-goal').fill('请直接回复：目标模型绑定验证完成。');
    await page.locator('#agent-goal-trigger').selectOption('manual');
    await page.locator('#agent-goal-kind').selectOption('monitor');
    await model.scrollIntoViewIfNeeded();
    const bounds = await model.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: path.resolve(__dirname, `../../output/agent-goal-model-${width}.png`) });
    const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents/goals' && response.request().method() === 'POST');
    await page.locator('#agent-goal-submit').click();
    const created = await createdResponse;
    expect(created.status(), await created.text()).toBe(201);
    const goal = (await created.json()).goal;
    expect(goal.authorizationSpec.modelId).toBe(modelId);
    await expect(page.locator('#agent-goal-modal')).toBeHidden();
    await page.locator(`[data-agent-goal-action="edit"][data-agent-goal-id="${goal.id}"]`).click();
    await expect(model).toBeEnabled();
    await expect(model).toHaveValue(String(modelId));
    await expect(page.locator('#agent-goal-kind')).toHaveValue('monitor');
    const updatedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/agents/goals/${goal.id}` && response.request().method() === 'PATCH');
    await page.locator('#agent-goal-submit').click();
    const updated = await updatedResponse;
    expect(updated.status(), await updated.text()).toBe(200);
    expect((await updated.json()).goal.authorizationSpec.modelId).toBe(modelId);
    await expect(page.locator('#agent-goal-modal')).toBeHidden();
    await page.locator(`[data-agent-goal-action="edit"][data-agent-goal-id="${goal.id}"]`).click();
    await expect(model).toBeEnabled();
    const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents/goals/preview' && response.request().method() === 'POST');
    await page.locator('#agent-goal-preview').click();
    const preview = await previewResponse;
    expect(preview.status(), await preview.text()).toBe(202);
    const run = (await preview.json()).run;
    expect(Number(run.model_id)).toBe(modelId);
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const headers = { 'x-csrf-token': csrf };
    const cancelled = await page.request.post(`/api/agents/runs/${run.id}/cancel`, { headers, data: {} });
    expect(cancelled.ok(), await cancelled.text()).toBeTruthy();
    const removed = await page.request.delete(`/api/agents/goals/${goal.id}`, { headers });
    expect(removed.ok(), await removed.text()).toBeTruthy();
});
