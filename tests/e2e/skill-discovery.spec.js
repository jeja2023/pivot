'use strict';

/* global window */
const { expect, test } = require('@playwright/test');

test('技能目录按授权发现并在暂停发布后拒绝旧契约', async ({ page }) => {
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    expect(csrf).toBeTruthy();
    const headers = { 'x-csrf-token': csrf };
    const suffix = Date.now().toString(36);
    const name = `e2e-skill-${suffix}`;
    const markdown = ['---', 'schemaVersion: 1', `id: e2e.skill.${suffix}`, `name: ${name}`, 'version: 1.0.0', 'title: 财务发现测试', 'description: 搜索测试技能', 'tags:', '  - 财务', 'capabilities:', '  - knowledge.search', 'tools:', '  - rag.search', 'inputs:', '  query:', '    type: string', 'outputs:', '  result:', '    type: string', '---', '', '# 指引', '仅使用授权数据。'].join('\n');
    const created = await page.request.post('/api/agents/skills/source', { headers, data: { markdown } });
    expect(created.status(), await created.text()).toBe(201);
    const version = (await created.json()).version;
    const validated = await page.request.post(`/api/agents/skills/versions/${version.id}/validate`, { headers, data: {} });
    expect(validated.status(), await validated.text()).toBe(200);
    const published = await page.request.post(`/api/agents/skills/versions/${version.id}/publish`, { headers, data: { scope: 'personal' } });
    expect(published.status(), await published.text()).toBe(200);
    const release = (await published.json()).release;
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench());
    await expect(page.locator('#agent-workbench-modal')).toBeVisible();
    await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
    await page.locator('[data-agent-cp-subview="governance"]').click();
    await page.locator('[data-agent-harness-nav="skills"]').click();
    await page.locator('#agent-open-capability-catalog-btn').click();
    await page.locator('#agent-skill-discovery-query').fill(name);
    await page.locator('#agent-skill-discovery-domain').fill('财务');
    await page.locator('#agent-skill-discovery-capability').fill('knowledge.search');
    await page.locator('#agent-skill-discovery-form button[type="submit"]').click();
    const results = page.locator('#agent-skill-discovery-results');
    await expect(results).toContainText('财务发现测试');
    await results.getByRole('button', { name: '查看契约' }).click();
    const detail = page.locator('#agent-skill-discovery-detail');
    await expect(detail).toContainText('rag.search');
    await detail.getByText('输入契约').click();
    await expect(detail).toContainText('query');
    const paused = await page.request.post(`/api/agents/skills/releases/${release.id}/pause`, { headers, data: { reason: '浏览器测试' } });
    expect(paused.status(), await paused.text()).toBe(200);
    await results.getByRole('button', { name: '查看契约' }).click();
    await expect(detail).toContainText('技能不存在或当前用户无权访问');
});
