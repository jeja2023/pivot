'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');

test('已命名的新公文即使正文为空也能刷新恢复', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'official-writing' }));
    await page.locator('#official-writing-create-doc-btn').click();
    await page.locator('#official-writing-create-title').fill('空正文公文');
    const saved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/apps/official-writing/documents/'));
    await page.locator('#official-writing-create-confirm-btn').click();
    expect((await saved).ok()).toBeTruthy();
    await page.reload();
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'official-writing' }));
    await expect(page.locator('#official-writing-home-doc-table-body')).toContainText('空正文公文');
});

test('公文保存期间继续编辑不会丢失正文，刷新后可导出', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'official-writing' }));
    await page.locator('#official-writing-create-doc-btn').click();
    await page.locator('#official-writing-create-title').fill('保存竞态回归');
    await page.locator('#official-writing-create-confirm-btn').click();
    const draft = page.locator('#official-writing-draft-surface');
    await expect(draft).toBeVisible();
    await expect.poll(async () => (await (await page.request.get('/api/apps/official-writing/documents')).json()).data.some(doc => doc.title === '保存竞态回归')).toBe(true);
    let release;
    let received;
    const held = new Promise(resolve => { received = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let paused = false;
    await page.route('**/api/apps/official-writing/documents/*', async route => {
        if (route.request().method() !== 'PUT' || paused || route.request().postDataJSON()?.title !== '保存竞态回归') return route.continue();
        paused = true;
        const response = await route.fetch();
        received();
        await gate;
        await route.fulfill({ response });
    });
    try {
        await draft.fill('保存中的第一版正文');
        await held;
        await draft.fill('保存期间修改后的最终正文');
        release();
        await expect.poll(async () => {
            const data = await (await page.request.get('/api/apps/official-writing/documents')).json();
            return data.data?.find(doc => doc.title === '保存竞态回归')?.state?.draft;
        }, { timeout: 15_000 }).toBe('保存期间修改后的最终正文');
        await page.reload();
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'official-writing' }));
        const row = page.locator('#official-writing-home-doc-table-body tr').filter({ hasText: '保存竞态回归' });
        await row.getByRole('button', { name: '编辑' }).click();
        await expect(draft).toContainText('保存期间修改后的最终正文');
        await page.getByLabel('展开导出操作').click();
        const download = page.waitForEvent('download');
        await page.locator('#official-writing-export-text-btn').click();
        const saved = await download;
        expect(await fs.readFile(await saved.path(), 'utf8')).toContain('保存期间修改后的最终正文');
    } finally { release(); }
});

test('其他窗口更新后拒绝覆盖，保留当前页面正文', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const id = `conflict_${Date.now()}`;
    const url = `/api/apps/official-writing/documents/${id}`;
    const first = await page.request.put(url, { headers, data: { title: '窗口冲突回归', manualTitle: true, state: { draft: '初稿' }, version: 0 } });
    expect(first.ok()).toBeTruthy();
    const document = (await first.json()).document;
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'official-writing' }));
    const row = page.locator('#official-writing-home-doc-table-body tr').filter({ hasText: '窗口冲突回归' });
    await row.getByRole('button', { name: '编辑' }).click();
    const updated = await page.request.put(url, { headers, data: { title: document.title, manualTitle: true, state: { draft: '另一窗口的正文' }, version: document.version } });
    expect(updated.ok()).toBeTruthy();
    const replay = await page.request.put(url, { headers, data: { title: document.title, manualTitle: true, state: { draft: '另一窗口的正文' }, version: document.version } });
    expect(replay.ok()).toBeTruthy();
    expect((await replay.json()).document.version).toBe((await updated.json()).document.version);
    const staleCreate = await page.request.put(url, { headers, data: { title: document.title, manualTitle: true, state: { draft: '不应覆盖' }, version: 0 } });
    expect(staleCreate.status()).toBe(409);
    const conflict = page.waitForResponse(response => response.url().endsWith(url) && response.request().method() === 'PUT');
    const draft = page.locator('#official-writing-draft-surface');
    await draft.fill('当前窗口未保存正文');
    expect((await conflict).status()).toBe(409);
    await expect(page.locator('#toast-container')).toContainText('公文已在其他窗口更新');
    await expect(draft).toContainText('当前窗口未保存正文');
    const documents = (await (await page.request.get('/api/apps/official-writing/documents')).json()).data;
    expect(documents.find(item => item.id === id).state.draft).toBe('另一窗口的正文');
});

test('公文首次保存尚未到达服务器时删除不会复活文档', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'official-writing' }));
    await page.locator('#official-writing-create-doc-btn').click();
    await page.locator('#official-writing-create-title').fill('删除竞态回归');
    let release;
    let received;
    const held = new Promise(resolve => { received = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let paused = false;
    let targetUrl = '';
    await page.route('**/api/apps/official-writing/documents/*', async route => {
        if (route.request().method() !== 'PUT' || paused || route.request().postDataJSON()?.title !== '删除竞态回归') return route.continue();
        paused = true;
        targetUrl = route.request().url();
        received();
        await gate;
        await route.continue();
    });
    try {
        await page.locator('#official-writing-create-confirm-btn').click();
        await held;
        await page.locator('#official-writing-draft-surface').fill('即将删除的正文');
        await page.evaluate(() => { window.Pivot.legacy.showConfirm = async () => true; });
        await page.locator('#official-writing-back-to-library-btn').click();
        const row = page.locator('#official-writing-home-doc-table-body tr').filter({ hasText: '删除竞态回归' });
        await row.getByRole('button', { name: '删除' }).click();
        const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url() === targetUrl);
        const put = page.waitForResponse(response => response.request().method() === 'PUT' && response.url() === targetUrl);
        release();
        const putResponse = await put;
        const deleteResponse = await deleted;
        expect(putResponse.status(), `保存结果: ${await putResponse.text()}`).toBe(200);
        expect(deleteResponse.status(), `删除结果: ${await deleteResponse.text()}`).toBe(200);
        await expect(row).toHaveCount(0);
        await page.reload();
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'official-writing' }));
        await expect(page.locator('#official-writing-home-doc-table-body')).not.toContainText('删除竞态回归');
    } finally { release(); }
});
