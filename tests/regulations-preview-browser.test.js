/* global window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规导入预览可校正、合并并提交为持久化导入任务', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true });
        await page.locator('#regulations-open-upload-btn').click();
        await page.locator('#regulations-upload-file').setInputFiles({
            name: '预览法规.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('第一条 原始内容。\n第二条 原始内容。')
        });
        await page.locator('[data-regulation-preview]').click();
        await expect(page.locator('#regulations-preview-panel')).toBeVisible();
        await expect(page.locator('[data-preview-content]')).toHaveCount(2);
        await page.locator('[data-preview-label="0"]').fill('第一条（已校正）');
        await page.locator('[data-preview-content="0"]').fill('第一条 校正后的正文。');
        await page.locator('[data-preview-check="0"]').check();
        await page.locator('[data-preview-check="1"]').check();
        await page.locator('[data-preview-merge]').click();
        await expect(page.locator('[data-preview-content]')).toHaveCount(1);
        await expect(page.locator('[data-preview-content="0"]')).toContainText('第二条 原始内容。');
        await page.locator('[data-preview-confirm]').click();
        await expect(page.locator('#regulations-preview-panel')).toBeHidden();
        await expect(page.locator('#regulations-import-jobs')).toContainText('排队中');
        const request = await page.evaluate(() => window.testImportJobRequest);
        const reviewed = JSON.parse(request.find(([key]) => key === 'reviewedArticles')[1]);
        assert.equal(reviewed.length, 1);
        assert.equal(reviewed[0].articleLabel, '第一条（已校正）');
        assert.match(reviewed[0].content, /校正后的正文/);
        assert.match(reviewed[0].content, /第二条 原始内容/);
        await page.close();
    } finally {
        await browser.close();
    }
});
