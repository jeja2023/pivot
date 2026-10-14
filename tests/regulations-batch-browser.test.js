/* global document, window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');
const createBatchPage = (browser, options = {}) => createPage(browser, { ...options, batchMode: true });

test('法规批量删除浏览器交互与布局', { timeout: 60000 }, async t => {
    const browser = await chromium.launch({ headless: true });
    try {
        await t.test('多选、全选、取消选择与取消确认', async () => {
            const page = await createBatchPage(browser);
            const button = page.locator('#regulations-batch-delete-btn');
            await expect(button).toBeDisabled();
            await page.locator('[data-regulation-select="1"]').check();
            await expect(page.locator('#regulations-selected-count')).toHaveText('已选 1 项');
            assert.equal(await page.locator('#regulations-select-all').evaluate(input => input.indeterminate), true);
            await page.locator('#regulations-select-all').check();
            await expect(page.locator('[data-regulation-select]:checked')).toHaveCount(3);
            await page.locator('#regulations-clear-selection-btn').click();
            await expect(page.locator('[data-regulation-select]:checked')).toHaveCount(0);
            await page.locator('[data-regulation-select="1"]').check();
            await page.evaluate(() => { window.testConfirmed = false; });
            await button.click();
            await expect(button).toBeEnabled();
            assert.deepEqual(await page.evaluate(() => window.testRequests), []);
            await expect(page.locator('[data-regulation-select="1"]')).toBeChecked();
            await page.close();
        });

        await t.test('部分失败保留选择、显示原因并关闭已删除文档的详情', async () => {
            const page = await createBatchPage(browser);
            await page.evaluate(() => {
                window.testFailures = [2];
                const ns = window.Pivot.legacy.PivotRegulationsInternal;
                ns.state.activeId = 1;
                ns.state.matches = [{ document_id: 1 }, { document_id: 2 }];
                document.getElementById('regulations-detail-panel').classList.remove('hidden');
            });
            await page.locator('[data-regulations-close-detail]').click();
            await page.locator('#regulations-select-all').check();
            await page.locator('#regulations-batch-delete-btn').click();
            await expect(page.locator('#regulations-batch-result-panel')).toBeVisible();
            await expect(page.locator('#regulations-batch-result-body')).toContainText('测试法规 2');
            await expect(page.locator('#regulations-batch-result-body')).toContainText('删除失败，请稍后重试');
            await expect(page.locator('[data-regulation-select]')).toHaveCount(1);
            await expect(page.locator('[data-regulation-select="2"]')).toBeChecked();
            assert.deepEqual(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.matches), [{ document_id: 2 }]);
            assert.equal(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.activeId), '');
            await page.locator('[data-regulations-close-batch-result]').click();
            await page.evaluate(() => { window.testFailures = []; });
            await page.locator('#regulations-batch-delete-btn').click();
            await expect(page.locator('#regulations-doc-list')).toContainText('暂无法规文档');
            await expect(page.locator('#regulations-select-all')).toBeDisabled();
            await expect(page.locator('#regulations-batch-delete-btn')).toBeDisabled();
            await page.close();
        });

        await t.test('请求失败可重试，刷新失败仍应用成功的删除结果', async () => {
            const page = await createBatchPage(browser);
            await page.locator('[data-regulation-select="1"]').check();
            await page.evaluate(() => { window.testRequestError = true; });
            await page.locator('#regulations-batch-delete-btn').click();
            await expect(page.locator('#regulations-batch-delete-btn')).toBeEnabled();
            await expect(page.locator('[data-regulation-select="1"]')).toBeChecked();
            await page.evaluate(() => { window.testRequestError = false; window.testRefreshError = true; });
            await page.locator('#regulations-batch-delete-btn').click();
            await expect(page.locator('[data-regulation-select="1"]')).toHaveCount(0);
            await expect(page.locator('#regulations-selected-count')).toHaveText('已选 0 项');
            assert.equal(await page.evaluate(() => window.testToasts.at(-1).message), '删除结果已保存，但列表刷新失败，请点击刷新重试');
            await page.close();
        });

        await t.test('翻页保留选择，上传忙碌时和确认等待时阻止重复批量操作', async () => {
            const page = await createBatchPage(browser);
            await page.locator('[data-regulation-select="1"]').check();
            await page.evaluate(async () => {
                const ns = window.Pivot.legacy.PivotRegulationsInternal;
                ns.state.pageSize = 2;
                await ns.loadDocuments({ page: 2 });
            });
            await expect(page.locator('#regulations-selected-count')).toHaveText('已选 1 项（当前页 0 项）');
            await page.locator('[data-regulation-select="3"]').check();
            await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.setBusy(true));
            await expect(page.locator('#regulations-batch-delete-btn')).toBeDisabled();
            await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.setBusy(false));
            await page.evaluate(() => {
                const ns = window.Pivot.legacy.PivotRegulationsInternal;
                window.testConfirmationPromise = new Promise(resolve => { window.testResolveConfirmation = resolve; });
                ns.deleteSelectedDocuments();
                ns.deleteSelectedDocuments();
            });
            await expect(page.locator('#regulations-batch-delete-btn')).toBeDisabled();
            assert.deepEqual(await page.evaluate(() => window.testRequests), []);
            await page.evaluate(() => window.testResolveConfirmation(true));
            await expect(page.locator('#regulations-selected-count')).toHaveText('已选 0 项');
            assert.deepEqual(await page.evaluate(() => window.testRequests), [[1, 3]]);
            assert.equal(await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.page), 1);
            await page.close();
        });

        await t.test('可一键全选当前分类范围，而不受当前页限制', async () => {
            const page = await createBatchPage(browser);
            await page.evaluate(() => {
                const ns = window.Pivot.legacy.PivotRegulationsInternal;
                ns.state.activeFolder = { title: '法律', category: '法律', isUncategorized: false };
                ns.syncDocumentSelection();
            });
            await expect(page.locator('#regulations-select-folder-btn')).toHaveText('全选“法律”');
            await page.locator('#regulations-select-folder-btn').click();
            await expect(page.locator('#regulations-selected-count')).toHaveText('已选 2 项');
            assert.deepEqual(await page.evaluate(() => [...window.Pivot.legacy.PivotRegulationsInternal.state.selectedDocumentIds].sort()), ['1', '3']);
            await page.close();
        });

        await t.test('批量处理可将当前分类加入可恢复的向量重建队列', async () => {
            const page = await createBatchPage(browser);
            await page.evaluate(() => {
                const ns = window.Pivot.legacy.PivotRegulationsInternal;
                ns.state.activeFolder = { title: '法律', category: '法律', isUncategorized: false };
                ns.syncDocumentSelection();
            });
            await expect(page.locator('#regulations-reindex-scope-btn')).toHaveText('重建“法律”向量');
            await page.locator('#regulations-reindex-scope-btn').click();
            assert.deepEqual(await page.evaluate(() => window.testReindexRequests), [{ category: '法律' }]);
            await expect(page.locator('#regulations-selected-count')).toHaveText('已选 0 项');
            assert.match(await page.evaluate(() => window.testToasts.at(-1).message), /已排队 2 个当前版本/);
            await page.close();
        });

        await t.test('普通用户和业务管理员不显示批量删除，admin 的窄屏工具栏不溢出', async () => {
            for (const user of [{ username: 'ordinary', role: 'user' }, { username: 'manager', role: 'admin', permissionTier: 'manager' }]) {
                const page = await createPage(browser, { user });
                await expect(page.locator('[data-regulation-select]')).toHaveCount(0);
                await expect(page.locator('#regulations-batch-delete-btn')).toHaveCount(0);
                await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.deleteSelectedDocuments());
                assert.deepEqual(await page.evaluate(() => window.testRequests), []);
                await page.close();
            }
            for (const width of [1280, 390]) {
                const page = await createBatchPage(browser, { width });
                const rects = await page.locator('.regulations-batch-actions').evaluate(element => {
                    const toolbar = element.getBoundingClientRect();
                    return [...element.children]
                        .filter(child => !child.classList.contains('hidden') && window.getComputedStyle(child).display !== 'none')
                        .map(child => {
                            const rect = child.getBoundingClientRect();
                            return { left: rect.left, right: rect.right, toolbarLeft: toolbar.left, toolbarRight: toolbar.right };
                        });
                });
                assert.ok(rects.every(rect => rect.left >= rect.toolbarLeft && rect.right <= rect.toolbarRight));
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
                await page.close();
            }
        });
    } finally {
        await browser.close();
    }
});
