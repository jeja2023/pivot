'use strict';
/* global window, document, performance */
const { test, expect } = require('@playwright/test');

for (const width of [1440, 390]) test(`产物修订和公开只读分享在 ${width}px 下可用`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => /\/artifact-(?:viewer|renderer)\.js/.test(entry.name)))).toBeFalsy();
    const created = await page.evaluate(async () => {
        const response = await window.Pivot.legacy.apiFetch('/api/artifacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '共享验收原稿', type: 'markdown', content: '## 原始正文\n\n只读分享材料。' }) });
        if (!response.ok) throw new Error('创建验收产物失败');
        return (await response.json()).data;
    });
    await page.evaluate(id => window.Pivot.openArtifact(id), created.id);
    const dialog = page.locator('#pivot-artifact-modal-overlay');
    await expect(dialog).toHaveClass(/active/);
    await expect(dialog.locator('#pivot-artifact-header-title')).toHaveText('共享验收原稿');
    await dialog.locator('[data-tab="source"]').click();
    await dialog.locator('#pivot-artifact-source-editor').fill('## 修订正文\n\n只读分享材料。');
    await dialog.locator('#pivot-artifact-btn-save-version').click();
    await expect(dialog.locator('#pivot-artifact-version-pill')).toHaveText('v2');
    await expect(dialog.locator('#pivot-artifact-pane-preview')).toContainText('修订正文');
    await page.keyboard.press('Escape'); await expect(dialog).not.toHaveClass(/active/);
    expect(await page.evaluate(() => window.Pivot.ArtifactViewer.currentArtifact)).toBeNull();
    const share = await page.evaluate(async id => {
        const response = await window.Pivot.legacy.apiFetch(`/api/artifacts/${id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 60 }) });
        return (await response.json()).data;
    }, created.id);
    await page.goto(share.shareUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#artifact-share-title')).toHaveText('共享验收原稿');
    await expect(page.locator('#artifact-share-content')).toContainText('修订正文');
    await expect(page.locator('#artifact-share-status')).toHaveText('公开分享 · 只读内容');
    await expect(page.getByRole('button', { name: '保存新版本' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});
