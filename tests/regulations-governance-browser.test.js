/* global document, window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规治理界面可查看质量、切换订阅并人工审核义务', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true });
        await page.evaluate(() => {
            const ns = window.Pivot.legacy.PivotRegulationsInternal;
            ns.state.activeId = 1;
            ns.state.detail = {
                document: { id: 1, title: '测试法规 1', status: 'active' },
                currentVersion: { id: 1, version_label: 'v1' },
                versions: [{ id: 1, version_label: 'v1' }],
                articles: [{ id: 11, article_label: '第一条', content: '第一条 测试正文。' }]
            };
            ns.renderDetail();
        });

        await page.locator('#regulations-quality-btn').click();
        await expect(page.locator('#regulations-quality-body')).toContainText('元数据待审核');
        await expect(page.locator('#regulations-quality-body')).toContainText('义务待审核');
        await page.locator('[data-regulations-close-quality]').click();
        await page.evaluate(() => document.getElementById('regulations-detail-panel').classList.remove('hidden'));

        const subscription = page.locator('[data-regulation-subscribe="1"]');
        await subscription.click();
        await expect(subscription).toHaveText('取消关注');
        assert.equal(await page.evaluate(() => window.testSubscriptionActive), true);
        await subscription.click();
        await expect(subscription).toHaveText('关注更新');
        assert.equal(await page.evaluate(() => window.testSubscriptionActive), false);

        const bookmark = page.locator('[data-regulation-bookmark="1"]');
        await bookmark.click();
        await expect(bookmark).toHaveText('取消收藏');
        await page.evaluate(() => document.getElementById('regulations-detail-panel').classList.add('hidden'));
        await page.locator('#regulations-bookmarks-btn').click();
        await expect(page.locator('#regulations-bookmarks-body')).toContainText('测试法规 1');
        await page.locator('[data-regulation-bookmark-topic="81"]').fill('人事');
        await page.locator('[data-regulation-bookmark-save="81"]').click();
        assert.equal(await page.evaluate(() => window.testBookmarks[0].topic), '人事');
        await page.locator('[data-regulation-bookmark-delete="81"]').click();
        await expect(page.locator('#regulations-bookmarks-body')).toContainText('暂无收藏');
        await page.locator('[data-regulations-close-bookmarks]').click();
        await page.evaluate(() => document.getElementById('regulations-detail-panel').classList.remove('hidden'));

        await page.locator('[data-regulation-ai-logs="1"]').click();
        await expect(page.locator('#regulations-ai-log-body')).toContainText('测试问答回答。');
        await expect(page.locator('#regulations-ai-log-body')).toContainText('测试法规 / v1 / 第一条');
        await page.locator('[data-regulations-close-ai-log]').click();

        await page.locator('[data-regulation-obligations="1"]').click();
        await expect(page.locator('#regulations-obligation-body')).toContainText('待审核');
        await page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.showRegulationObligations(1, 11));
        await expect(page.locator('select[name="ownerUserId"]')).toContainText('管理员 · 法务部');
        await page.locator('[data-regulations-close-obligation]').click();
        await page.locator('[data-regulation-obligations="1"]').click();
        await page.locator('[data-regulation-obligation-review="71"]').evaluate(element => element.click());
        await expect(page.locator('#regulations-obligation-body')).toContainText('已审核');
        assert.equal(await page.evaluate(() => window.testObligations[0].status), 'active');
        await page.close();
    } finally {
        await browser.close();
    }
});
