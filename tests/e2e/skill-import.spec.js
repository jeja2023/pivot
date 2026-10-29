'use strict';
/* global document, window */
const { expect, test } = require('@playwright/test');

test('技能文件可预览并经原有验证和个人发布流程添加', async ({ page }) => {
    test.setTimeout(90000);
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench());
    await expect(page.locator('#agent-workbench-modal')).toBeVisible();
    await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
    await page.locator('[data-agent-cp-subview="governance"]').click();
    await page.locator('[data-agent-harness-nav="skills"]').click();
    const selector = page.locator('#agent-skill-import-tools');
    await expect(selector.locator('option[value="rag.search"]')).toHaveCount(1, { timeout: 15000 });
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(() => page.evaluate(() => {
            const modal = document.querySelector('#agent-workbench-modal');
            const form = document.querySelector('.agent-harness-skill-form-wrap');
            const rect = form.getBoundingClientRect();
            return modal.scrollWidth <= modal.clientWidth + 1 && rect.width > 0 && rect.right <= window.innerWidth + 1;
        })).toBe(true);
        await expect(page.locator('#agent-skill-import-preview')).toBeVisible();
    }
    await page.setViewportSize({ width: 1280, height: 844 });
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
    const denied = await page.request.post('/api/agents/skills/import/preview', { headers: { 'x-csrf-token': csrf }, data: { markdown: '# 操作', title: '无授权工具', tools: ['mcp.999999.fake'] } });
    expect(denied.status()).toBe(422);
    await page.locator('#agent-skill-import-source').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: summary\nallowed-tools: ignored\n---\n\n# 工作指引\n根据授权资料提供摘要。') });
    await page.locator('#agent-skill-import-title').fill('测试资料摘要');
    await selector.selectOption('rag.search');
    await page.locator('#agent-skill-import-preview').click();
    const preview = page.locator('#agent-skill-import-review');
    await expect(preview).toContainText('根据授权资料提供摘要');
    await expect(preview).toContainText('脚本、附件、依赖');
    await expect(preview).toContainText('knowledge.search');
    await expect(preview).toContainText('allowed-tools');
    await page.locator('#agent-skill-import-submit').click();
    await expect(page.locator('#agent-skill-import-status')).toContainText('个人技能已添加并发布', { timeout: 45000 });
    await expect(page.locator('#agent-harness-skill-list')).toContainText('测试资料摘要');
    const versions = await page.request.get('/api/agents/skills/versions?limit=100');
    const created = (await versions.json()).data.find(item => item.name.startsWith('imported-'));
    expect(created.status).toBe('published');
    const exported = await page.request.get(`/api/agents/skills/versions/${created.id}/source`);
    const markdown = (await exported.json()).markdown;
    expect(markdown).toContain('根据授权资料提供摘要');
    expect(markdown).not.toContain('allowed-tools');
});
