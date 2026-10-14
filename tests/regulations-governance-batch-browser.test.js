/* global window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规质量治理队列支持全选、批量处理与引用批量审核', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true, user: { username: 'manager', role: 'admin', permissionTier: 'manager' } });
        const closeBatchResult = async () => {
            if (await page.locator('#regulations-batch-result-panel').isVisible()) await page.locator('[data-regulations-close-batch-result]').click();
        };
        const openQuality = async () => {
            if (await page.locator('#regulations-quality-panel').isHidden()) await page.locator('#regulations-quality-btn').click();
        };
        const openDocumentWorklist = async scope => {
            await openQuality();
            await page.locator(`[data-regulation-governance-worklist="${scope}"]`).click();
            await page.locator('#regulations-batch-mode-btn').click();
            await page.locator('#regulations-select-folder-btn').click();
        };

        await openDocumentWorklist('metadata');
        await expect(page.locator('#regulations-selected-count')).toHaveText('已选 1 项');
        await page.locator('#regulations-governance-batch-action-btn').click();
        await page.locator('[data-regulation-batch-field="legalLevel"]').check();
        await page.getByLabel('批量法规层级').fill('法律');
        await page.locator('[data-regulation-batch-field="officialSourceUrl"]').check();
        await page.getByLabel('批量权威来源地址').fill('https://authority.example/one');
        await page.locator('[data-regulation-batch-field="metadataReviewStatus"]').check();
        await page.getByLabel('批量元数据审核状态').selectOption('approved');
        await page.locator('#regulations-batch-save-btn').click();
        await expect.poll(() => page.evaluate(() => window.testDocuments.find(item => item.id === 1)?.metadata_review_status)).toBe('approved');
        assert.equal(await page.evaluate(() => window.testDocuments.find(item => item.id === 1)?.official_source_url), 'https://authority.example/one');
        await closeBatchResult();

        await openDocumentWorklist('maintainer');
        await expect(page.locator('#regulations-selected-count')).toHaveText('已选 2 项');
        await page.locator('#regulations-governance-batch-action-btn').click();
        await page.locator('[data-regulation-batch-field="maintainerUserId"]').check();
        await page.getByLabel('批量维护人').selectOption('1');
        await page.locator('#regulations-batch-save-btn').click();
        await expect.poll(() => page.evaluate(() => window.testDocuments.filter(item => [1, 3].includes(item.id)).every(item => Number(item.maintainer_user_id) === 1))).toBe(true);
        await closeBatchResult();

        await openDocumentWorklist('version');
        await expect(page.locator('#regulations-selected-count')).toHaveText('已选 2 项');
        await page.locator('#regulations-governance-batch-action-btn').click();
        await page.locator('[data-regulation-batch-field="effectStatus"]').check();
        await page.getByLabel('批量效力状态').selectOption('effective');
        await page.locator('[data-regulation-batch-field="reviewStatus"]').check();
        await page.getByLabel('批量版本审核状态').selectOption('approved');
        await page.locator('#regulations-batch-save-btn').click();
        await expect.poll(() => page.evaluate(() => window.testDocuments.filter(item => [1, 3].includes(item.id)).every(item => item.current_effect_status === 'effective' && item.current_review_status === 'approved'))).toBe(true);
        await closeBatchResult();

        await openDocumentWorklist('index');
        await page.locator('#regulations-governance-batch-action-btn').click();
        await expect.poll(() => page.evaluate(() => window.testDocuments.find(item => item.id === 1)?.current_index_status)).toBe('retry_wait');
        await expect(page.locator('#regulations-batch-result-body')).toContainText('加入索引队列');
        await closeBatchResult();

        await openDocumentWorklist('location');
        await page.locator('#regulations-governance-batch-action-btn').click();
        await expect.poll(() => page.evaluate(() => window.testDocuments.find(item => item.id === 3)?.location_missing)).toBe(false);
        await expect(page.locator('#regulations-batch-result-body')).toContainText('定位重建');
        await closeBatchResult();

        await openQuality();
        await page.locator('[data-regulation-citation-governance="unresolved"]').click();
        await page.locator('[data-regulation-citation-select-all]').check();
        await page.locator('[data-regulation-citation-review-selected="rejected"]').click();
        await expect.poll(() => page.evaluate(() => window.testCitationLinks.find(item => item.id === 801)?.review_status)).toBe('rejected');
        await page.locator('[data-regulations-close-citation-governance]').click();

        await openQuality();
        await page.locator('[data-regulation-citation-governance="review"]').click();
        await page.locator('[data-regulation-citation-select-all]').check();
        await page.locator('[data-regulation-citation-review-selected="approved"]').click();
        await expect.poll(() => page.evaluate(() => window.testCitationLinks.find(item => item.id === 802)?.review_status)).toBe('approved');
        await page.close();
    } finally {
        await browser.close();
    }
});
