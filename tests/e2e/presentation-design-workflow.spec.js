'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const { compileDesignPlan } = require('../../server/services/presentations/presentation-design-compiler');
const { getBuiltInTemplate } = require('../../server/services/presentations/presentation-templates');

test('整稿排版先给建议，确认应用后保存；视觉复核可取消、重启并保留进度', async ({ page }) => {
    test.setTimeout(90000);
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const name = `PPT视觉验收模型${Date.now()}`;
    expect((await page.request.post('/api/models', { headers, data: { name, url: process.env.E2E_MODEL_URL, model_name: 'ppt-e2e-vision-slow', supports_vision: 1 } })).ok()).toBeTruthy();
    const model = (await (await page.request.get('/api/models?limit=100')).json()).data.find(item => item.name === name);
    await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: model.id } });
    const { presentation: content } = await compileDesignPlan({ title: '整稿设计流程验收', slides: [
        { title: '完整保留材料', layout: 'content', points: ['先核对真实资料', '再形成具体安排'] },
        { title: '分步推进工作', layout: 'process', points: ['明确处理范围', '复核交付结果'] }
    ] }, getBuiltInTemplate('learning-studio'));
    const created = await page.request.post('/api/apps/presentations', { headers, data: { title: content.title, templateId: 'learning-studio', content } });
    expect(created.ok()).toBeTruthy();
    let document = (await created.json()).presentation;
    document.content.slides[0].elements.find(element => element.id === 'title').height = 5;
    const changed = await page.request.put(`/api/apps/presentations/${document.id}/content`, { headers, data: { title: document.title, baseVersion: document.version, content: document.content, autoSave: true } });
    expect(changed.ok()).toBeTruthy();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(id => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations', presentationId: id }), document.id);
    await expect(page.locator('#presentation-title-input')).toHaveValue('整稿设计流程验收');
    await page.locator('[data-presentation-panel="ai"]').click();
    await page.locator('#presentation-deck-layout-btn').click();
    const status = page.locator('#presentation-design-task-status');
    await expect(status).toContainText('优化建议', { timeout: 15000 });
    const untouched = (await (await page.request.get(`/api/apps/presentations/${document.id}`)).json()).presentation;
    expect(untouched.content.slides[0].elements.find(element => element.id === 'title').height).toBe(5);
    await status.getByRole('button', { name: '应用排版优化建议' }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/apps/presentations/${document.id}`)).json()).presentation.content.slides[0].elements.find(element => element.id === 'title').height, { timeout: 15000 }).toBeGreaterThan(5);
    await page.locator('[data-presentation-panel="ai"]').click();
    await page.locator('#presentation-ai-model').selectOption(String(model.id));
    await page.locator('#presentation-deck-review-btn').click();
    await expect(status.getByRole('button', { name: '停止整稿检查' })).toBeVisible();
    await status.getByRole('button', { name: '停止整稿检查' }).click();
    await expect(status).toContainText('已取消');
    await page.locator('#presentation-deck-review-btn').click();
    await expect(status).toContainText('已复核 2 页', { timeout: 20000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(id => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'presentations', presentationId: id }), document.id);
    await page.locator('[data-presentation-panel="ai"]').click();
    await expect(page.locator('#presentation-design-task-status')).toContainText('已复核 2 页');
    await page.screenshot({ path: 'output/ppt-upgrade-acceptance/工作台流程验收.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#presentation-design-task-status').screenshot({ path: 'output/ppt-upgrade-acceptance/窄屏检查进度.png' });
});
