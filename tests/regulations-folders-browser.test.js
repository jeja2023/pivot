/* global window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规分类目录先显示虚拟文件夹，支持新建/删除分类目录，进入文件夹后展示动态目录与分类法规', { timeout: 60000 }, async () => {
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
        // 顶栏不再有冗余的分类目录按钮
        await expect(page.locator('#regulations-folders-btn')).toHaveCount(0);

        // 新建分类目录流程
        await page.locator('#regulations-create-folder-btn').click();
        await expect(page.locator('#regulations-create-folder-panel')).toBeVisible();
        // 点击快捷推荐标签填充分类名称
        await page.locator('[data-regulation-preset-cat="地方性法规"]').click();
        await expect(page.locator('#regulations-new-folder-name')).toHaveValue('地方性法规');
        // 提交新建分类
        await page.locator('#regulations-create-folder-submit').click();
        await expect(page.locator('#regulations-create-folder-panel')).toBeHidden();
        await expect(page.locator('#regulations-folder-directory')).toContainText('地方性法规');

        // 进入具体分类后，分类索引栏内展示批量处理与返回按钮
        await page.locator('[data-regulation-folder-category="法律"]').click();
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
        assert.equal(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.batchMode), false);
        assert.equal(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.activeFolder), null);

        // 进入新建的空分类目录，验证删除分类按钮与导入此分类法规按钮
        await page.locator('[data-regulation-folder-category="地方性法规"]').click();
        await expect(page.locator('#regulations-folder-index')).toContainText('地方性法规 · 分类目录');
        await expect(page.locator('[data-regulation-folder-delete="地方性法规"]')).toBeVisible();
        await expect(page.locator('[data-regulation-import-folder="地方性法规"]')).toBeVisible();

        // 删除该自定义空分类
        await page.locator('[data-regulation-folder-delete="地方性法规"]').click();
        await expect(page.locator('#regulations-folder-directory')).toBeVisible();
        await expect(page.locator('#regulations-folder-directory')).not.toContainText('地方性法规');

        await page.close();
    } finally {
        await browser.close();
    }
});
