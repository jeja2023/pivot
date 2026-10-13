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
        await expect(page.locator('#regulations-folders-btn')).toHaveClass(/is-active/);

        // 在总目录点击“分类目录”按钮，给出已在首页提示而不会失效
        await page.locator('#regulations-folders-btn').click();
        assert.equal(await page.evaluate(() => window.testToasts.at(-1)?.message), '当前已在分类目录首页');

        // 进入具体分类后，顶栏“分类目录”取消高亮，分类索引栏内展示批量处理与返回按钮
        await page.locator('[data-regulation-folder-category="法律"]').click();
        await expect(page.locator('#regulations-folders-btn')).not.toHaveClass(/is-active/);
        await expect(page.locator('#regulations-folder-index')).toContainText('法律 · 分类目录');
        const batchBtn = page.locator('#regulations-folder-index #regulations-batch-mode-btn');
        await expect(batchBtn).toBeVisible();
        await expect(batchBtn).toHaveText('批量处理');
        await expect(page.locator('#regulations-doc-table-wrap')).toBeVisible();
        await expect(page.locator('#regulations-doc-list')).toContainText('测试法规 1');
        await expect(page.locator('#regulations-doc-list')).not.toContainText('测试法规 2');

        // 在分类目录内开启批量处理
        await batchBtn.click();
        await expect(batchBtn).toHaveText('退出批量处理');
        await expect(page.locator('#regulations-batch-actions')).toBeVisible();

        // 点击返回分类目录，退出批量模式并隐藏具体分类横幅与表格
        await page.locator('[data-regulation-folder-back]').click();
        await expect(page.locator('#regulations-folder-directory')).toBeVisible();
        await expect(page.locator('#regulations-folder-index')).toBeHidden();
        await expect(page.locator('#regulations-doc-table-wrap')).toBeHidden();
        await expect(page.locator('#regulations-folders-btn')).toHaveClass(/is-active/);
        assert.equal(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.batchMode), false);
        assert.equal(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.activeFolder), null);

        // 再次进入分类并通过顶栏“分类目录”按钮返回，验证分类索引条目均正常隐藏
        await page.locator('[data-regulation-folder-category="法律"]').click();
        await expect(page.locator('#regulations-folder-index')).toBeVisible();
        await page.locator('#regulations-folders-btn').click();
        await expect(page.locator('#regulations-folder-directory')).toBeVisible();
        await expect(page.locator('#regulations-folder-index')).toBeHidden();
        await expect(page.locator('#regulations-doc-table-wrap')).toBeHidden();
        await expect(page.locator('#regulations-folders-btn')).toHaveClass(/is-active/);
        assert.equal(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.activeFolder), null);

        await page.close();
    } finally {
        await browser.close();
    }
});
