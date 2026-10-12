/* global window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规导入任务可在排队时取消，并可从失败或取消状态重新提交', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true });
        await page.evaluate(() => {
            window.testImportJobs = [{
                id: 8, sourceName: '待导入法规.txt', status: 'queued', stage: 'queued', progress: 0,
                attempts: 0, result: {}, errorMessage: ''
            }];
        });
        await page.locator('#regulations-open-upload-btn').click();
        await expect(page.locator('#regulations-import-jobs')).toContainText('待导入法规.txt');
        await page.locator('[data-regulation-import-cancel="8"]').click();
        await expect(page.locator('#regulations-import-jobs')).toContainText('已取消');
        await expect(page.locator('[data-regulation-import-retry="8"]')).toBeVisible();
        assert.equal(await page.evaluate(() => window.testImportJobs[0].status), 'cancelled');
        await page.locator('[data-regulation-import-retry="8"]').click();
        await expect(page.locator('#regulations-import-jobs')).toContainText('排队中');
        assert.equal(await page.evaluate(() => window.testImportJobs[0].status), 'queued');
        await page.close();
    } finally {
        await browser.close();
    }
});
