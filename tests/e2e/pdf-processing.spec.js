'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const { PDFDocument } = require('pdf-lib');
const fs = require('node:fs/promises');

test('PDF 工具从页面合并文件，刷新后仍可下载完整结果', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    await page.goto('/chat');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
    await page.locator('#auth-submit').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'pdf-tools' }));
    await expect(page.locator('#pdf-tools-form')).toBeVisible();
    const inputs = [];
    for (const name of ['first.pdf', 'second.pdf']) {
        const pdf = await PDFDocument.create(); pdf.addPage([300, 200]);
        inputs.push({ name, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
    }
    await page.locator('#pdf-operation-select').selectOption('merge');
    await page.locator('#pdf-files-input').setInputFiles(inputs);
    const creation = page.waitForResponse(response => response.url().endsWith('/api/apps/pdf-tools/jobs') && response.request().method() === 'POST');
    await page.locator('#pdf-submit-btn').click();
    const response = await creation;
    expect(response.ok()).toBeTruthy();
    const jobId = (await response.json()).job.id;
    await expect.poll(async () => {
        const detail = await page.request.get(`/api/apps/pdf-tools/jobs/${jobId}`);
        return detail.ok() ? (await detail.json()).job.status : '';
    }, { timeout: 45_000 }).toBe('succeeded');
    await page.reload();
    await page.waitForFunction(() => Boolean(window.Pivot?.moduleApi('workspaces.navigation')));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'pdf-tools' }));
    const button = page.locator(`[data-pdf-job-download="${jobId}"]`).first();
    await expect(button).toBeVisible();
    const download = page.waitForEvent('download');
    await button.click();
    const file = await download;
    expect((await PDFDocument.load(await fs.readFile(await file.path()))).getPageCount()).toBe(2);
});
