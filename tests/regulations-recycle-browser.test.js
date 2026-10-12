/* global window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('admin 可在法规回收站查看并恢复软删除法规', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true });
        await page.locator('#regulations-recycle-bin-btn').click();
        await expect(page.locator('#regulations-recycle-bin-body')).toContainText('已删除测试法规');
        await page.locator('[data-regulation-restore="91"]').evaluate(element => element.click());
        await expect(page.locator('#regulations-recycle-bin-body')).toContainText('回收站为空');
        assert.equal(await page.evaluate(() => window.testDocuments.some(item => item.id === 91)), true);
        await page.close();
    } finally {
        await browser.close();
    }
});
