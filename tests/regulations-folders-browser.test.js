/* global window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规分类目录先显示虚拟文件夹，进入文件夹后展示动态目录和分类内法规', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true });
        await page.evaluate(async () => {
            const ns = window.Pivot.legacy.PivotRegulationsInternal;
            await ns.loadCategoryFolders();
        });
        await expect(page.locator('#regulations-folder-directory')).toBeVisible();
        await expect(page.locator('#regulations-folder-directory')).toContainText('法律');
        await expect(page.locator('#regulations-doc-table-wrap')).toBeHidden();
        await page.locator('[data-regulation-folder-category="法律"]').click();
        await expect(page.locator('#regulations-folder-index')).toContainText('法律 · 分类目录');
        await expect(page.locator('#regulations-doc-table-wrap')).toBeVisible();
        await expect(page.locator('#regulations-doc-list')).toContainText('测试法规 1');
        await expect(page.locator('#regulations-doc-list')).not.toContainText('测试法规 2');
        await page.locator('[data-regulation-folder-back]').click();
        await expect(page.locator('#regulations-folder-directory')).toBeVisible();
        await expect(page.locator('#regulations-folder-index')).toBeHidden();
        await expect(page.locator('#regulations-doc-table-wrap')).toBeHidden();
        assert.equal(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.activeFolder), null);

        // 再次进入分类并通过顶栏“分类目录”按钮返回，验证分类索引条目均正常隐藏
        await page.locator('[data-regulation-folder-category="法律"]').click();
        await expect(page.locator('#regulations-folder-index')).toBeVisible();
        await page.locator('#regulations-folders-btn').click();
        await expect(page.locator('#regulations-folder-directory')).toBeVisible();
        await expect(page.locator('#regulations-folder-index')).toBeHidden();
        await expect(page.locator('#regulations-doc-table-wrap')).toBeHidden();
        assert.equal(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.activeFolder), null);

        await page.close();
    } finally {
        await browser.close();
    }
});
