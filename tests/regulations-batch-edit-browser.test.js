/* global window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规批量处理模式和批量修改', { timeout: 60000 }, async t => {
    const browser = await chromium.launch({ headless: true });
    try {
        await t.test('默认隐藏选择框和操作栏，退出模式清空选择', async () => {
            const page = await createPage(browser);
            const mode = page.locator('#regulations-batch-mode-btn');
            await expect(mode).toHaveText('批量处理');
            await expect(page.locator('#regulations-batch-actions')).toBeHidden();
            await expect(page.locator('#regulations-select-column')).toBeHidden();
            await expect(page.locator('[data-regulation-select]')).toHaveCount(0);
            assert.equal(await page.locator('#regulations-doc-list tr').first().locator('td').count(), 10);
            await mode.click();
            await expect(mode).toHaveText('退出批量处理');
            await expect(mode).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('#regulations-batch-actions')).toBeVisible();
            await page.locator('[data-regulation-select="1"]').check();
            await mode.click();
            await expect(page.locator('#regulations-batch-actions')).toBeHidden();
            await expect(page.locator('[data-regulation-select]')).toHaveCount(0);
            await mode.click();
            await expect(page.locator('#regulations-selected-count')).toHaveText('已选 0 项');
            await expect(page.locator('#regulations-batch-edit-btn')).toBeDisabled();
            await page.close();
        });

        await t.test('批量修改只应用勾选字段并保留其它元数据', async () => {
            const page = await createPage(browser, { batchMode: true });
            await page.locator('[data-regulation-select="1"]').check();
            await page.locator('[data-regulation-select="2"]').check();
            await page.locator('#regulations-batch-edit-btn').click();
            await expect(page.locator('#regulations-batch-edit-count')).toHaveText('将修改选中的 2 个文档');
            await expect(page.locator('#regulations-batch-save-btn')).toBeDisabled();
            await expect(page.getByLabel('批量分类')).toBeDisabled();
            await page.locator('[data-regulation-batch-field="category"]').check();
            await page.getByLabel('批量分类').fill('行政法规');
            await page.locator('[data-regulation-batch-field="issuingBody"]').check();
            await page.getByLabel('批量发布机构').fill('国务院');
            await page.locator('[data-regulation-batch-field="jurisdiction"]').check();
            await page.getByLabel('批量适用范围').fill('全国');
            await page.locator('[data-regulation-batch-field="jurisdiction"]').uncheck();
            await page.locator('#regulations-batch-save-btn').click();
            await expect(page.locator('#regulations-batch-edit-panel')).toBeHidden();
            await expect(page.locator('#regulations-batch-result-panel')).toBeVisible();
            await expect(page.locator('[data-regulation-batch-revert="测试批量记录-1"]')).toBeVisible();
            const result = await page.evaluate(() => ({ documents: window.testDocuments, requests: window.testUpdates, refreshed: window.testFacetsRefreshed }));
            assert.deepEqual(result.requests, [{ ids: [1, 2], patch: { category: '行政法规', issuingBody: '国务院' } }]);
            assert.equal(result.documents[0].jurisdiction, '全国');
            assert.equal(result.documents[1].jurisdiction, '北京市');
            assert.equal(result.documents[1].current_version_label, '2024 年修订');
            assert.equal(result.documents[1].title, '测试法规 2');
            assert.equal(result.documents[2].category, '法律');
            assert.equal(result.refreshed, true);
            await expect(page.locator('#regulations-doc-list')).toContainText('国务院');
            await expect(page.locator('#regulations-selected-count')).toHaveText('已选 0 项');
            await page.locator('[data-regulation-batch-revert="测试批量记录-1"]').click();
            assert.deepEqual(await page.evaluate(() => window.testBatchUndo), [{ batchId: '测试批量记录-1' }]);
            await expect(page.locator('#regulations-doc-list')).toContainText('发布机构 1');
            await page.close();
        });

        await t.test('可批量设置状态、清空文本字段并保留失败项以便重试', async () => {
            const page = await createPage(browser, { batchMode: true });
            await page.evaluate(() => { window.testFailures = [2]; });
            await page.locator('#regulations-select-all').check();
            await page.locator('#regulations-batch-edit-btn').click();
            await page.locator('[data-regulation-batch-field="issuingBody"]').check();
            await page.locator('[data-regulation-batch-field="jurisdiction"]').check();
            await page.getByLabel('批量适用范围').fill('全国');
            await page.locator('[data-regulation-batch-field="status"]').check();
            await page.getByLabel('批量状态').selectOption('archived');
            await page.locator('#regulations-batch-save-btn').click();
            await expect(page.locator('#regulations-batch-result-panel')).toBeVisible();
            await expect(page.locator('#regulations-batch-result-title')).toHaveText('批量修改结果');
            await expect(page.locator('#regulations-batch-result-body')).toContainText('测试法规 2');
            await page.locator('[data-regulations-close-batch-result]').click();
            await expect(page.locator('[data-regulation-select="2"]')).toBeChecked();
            await expect(page.locator('[data-regulation-select]:checked')).toHaveCount(1);
            const docs = await page.evaluate(() => window.testDocuments);
            assert.equal(docs[0].issuing_body, '');
            assert.equal(docs[0].status, 'archived');
            assert.equal(docs[1].issuing_body, '发布机构 2');
            assert.equal(docs[1].status, 'active');
            assert.equal(docs[2].jurisdiction, '全国');
            await page.locator('#regulations-batch-edit-btn').click();
            await expect(page.locator('#regulations-batch-edit-count')).toHaveText('将修改选中的 1 个文档');
            await expect(page.locator('[data-regulation-batch-field]:checked')).toHaveCount(0);
            await page.keyboard.press('Escape');
            await expect(page.locator('#regulations-batch-edit-panel')).toBeHidden();
            await page.close();
        });

        await t.test('请求失败保留填写内容，刷新失败仍显示已保存的修改', async () => {
            const page = await createPage(browser, { batchMode: true });
            await page.locator('[data-regulation-select="1"]').check();
            await page.locator('#regulations-batch-edit-btn').click();
            await page.locator('[data-regulation-batch-field="category"]').check();
            await page.getByLabel('批量分类').fill('司法解释');
            await page.evaluate(() => { window.testRequestError = true; });
            await page.locator('#regulations-batch-save-btn').click();
            await expect(page.locator('#regulations-batch-save-btn')).toBeEnabled();
            await expect(page.locator('#regulations-batch-edit-panel')).toBeVisible();
            await expect(page.getByLabel('批量分类')).toHaveValue('司法解释');
            await page.evaluate(() => { window.testRequestError = false; window.testRefreshError = true; });
            await page.locator('#regulations-batch-save-btn').click();
            await expect(page.locator('#regulations-batch-edit-panel')).toBeHidden();
            await expect(page.locator('#regulations-doc-list')).toContainText('司法解释');
            assert.equal(await page.evaluate(() => window.testToasts.at(-1).message), '修改结果已保存，但列表刷新失败，请点击刷新重试');
            await page.close();
        });

        await t.test('业务管理员可批量修改，普通用户没有入口；窄屏弹窗控件可见', async () => {
            const regular = await createPage(browser, { user: { username: 'ordinary', role: 'user' } });
            await expect(regular.locator('#regulations-batch-mode-btn')).toHaveCount(0);
            await expect(regular.locator('#regulations-batch-edit-panel')).toHaveCount(0);
            await regular.close();
            const manager = await createPage(browser, { batchMode: true, user: { username: 'manager', role: 'admin', permissionTier: 'manager' } });
            await expect(manager.locator('#regulations-batch-delete-btn')).toHaveCount(0);
            await manager.locator('[data-regulation-select="1"]').check();
            await expect(manager.locator('#regulations-batch-edit-btn')).toBeEnabled();
            await manager.close();
            for (const width of [1280, 390]) {
                const page = await createPage(browser, { width, batchMode: true });
                await page.locator('[data-regulation-select="1"]').check();
                await page.locator('#regulations-batch-edit-btn').click();
                await expect(page.locator('[data-regulation-batch-field="status"]')).toBeVisible();
                const fits = await page.locator('#regulations-batch-edit-panel .workspace-modal').evaluate(modal => {
                    const rect = modal.getBoundingClientRect();
                    return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight
                        && modal.scrollWidth <= modal.clientWidth;
                });
                assert.equal(fits, true);
                await page.close();
            }
        });
    } finally {
        await browser.close();
    }
});
