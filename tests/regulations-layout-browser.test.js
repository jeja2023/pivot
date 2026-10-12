/* global window, document -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规查询主视图、面板与卡片容器在不同视口下均全宽撑满显示', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const viewportWidth = 1440;
        const page = await createPage(browser, { width: viewportWidth, includeAdvanced: true });
        await page.evaluate(async () => {
            const ns = window.Pivot.legacy.PivotRegulationsInternal;
            await ns.loadCategoryFolders();
        });

        const widths = await page.evaluate(() => {
            const body = document.querySelector('.apps-workspace-body');
            const view = document.getElementById('regulations-view');
            const panel = document.querySelector('.regulations-panel');
            const main = document.querySelector('.regulations-main');
            return {
                body: body.getBoundingClientRect().width,
                view: view.getBoundingClientRect().width,
                panel: panel.getBoundingClientRect().width,
                main: main.getBoundingClientRect().width
            };
        });

        assert.equal(widths.body, viewportWidth, '宿主容器宽度应撑满视口');
        assert.equal(widths.view, widths.body, '法规主视图宽度应撑满宿主');
        assert.equal(widths.panel, widths.view, '法规面板宽度应撑满视图');
        assert.equal(widths.main, widths.panel, '法规主内容卡片应撑满面板，不局限在左侧');

        await page.close();
    } finally {
        await browser.close();
    }
});
