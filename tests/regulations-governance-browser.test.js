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
        await expect(page.locator('#regulations-quality-body')).toContainText('元数据治理待办');
        await expect(page.locator('#regulations-quality-body')).toContainText('层级缺失 1 · 来源缺失 1 · 审核未通过 1');
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
        await expect(page.locator('#regulations-bookmarks-body')).toContainText('暂无法规收藏');
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

test('管理/效力列使用元数据审核状态，普通用户不显示质量概览', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const adminPage = await createPage(browser, { includeAdvanced: true });
        const status = await adminPage.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.renderRegulationStatusCell({
            status: 'active',
            current_effect_status: 'effective',
            current_review_status: 'pending',
            metadata_review_status: 'approved',
            current_index_status: 'vector_ready'
        }));
        assert.match(status, /元数据审核：已审核/);
        assert.match(status, />已审核</);
        assert.doesNotMatch(status, />待审核</);
        await adminPage.close();

        const userPage = await createPage(browser, {
            includeAdvanced: true,
            user: { username: 'ordinary-user', role: 'user', permissionTier: 'user', isAdmin: false }
        });
        await expect(userPage.locator('#regulations-quality-btn')).toHaveCount(0);
        await userPage.close();
    } finally {
        await browser.close();
    }
});

test('法规管理员可从质量概览进入待治理队列并完成版本审核', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true, user: { username: 'manager', role: 'admin', permissionTier: 'manager' } });
        await page.locator('#regulations-quality-btn').click();
        const worklist = page.locator('[data-regulation-governance-worklist="version"]');
        await expect(worklist).toHaveText('处理版本');
        await worklist.click();
        await expect(page.locator('#regulations-quality-panel')).toBeHidden();
        await expect(page.locator('#regulations-folder-index')).toContainText('待治理法规 · 治理队列');
        await expect(page.locator('#regulations-doc-list')).toContainText('测试法规 1');
        await expect(page.locator('#regulations-doc-list')).not.toContainText('测试法规 2');
        assert.ok((await page.evaluate(() => window.testDocumentListUrls)).some(url => url.includes('governanceScope=version')));

        await page.locator('[data-regulation-governance-document="1"]').click();
        await expect(page.locator('#regulations-edit-form')).toBeVisible();
        await page.locator('#regulations-edit-form [name="effectStatus"]').selectOption('effective');
        await page.locator('#regulations-edit-form [name="reviewStatus"]').selectOption('approved');
        await page.locator('#regulations-edit-form button[type="submit"]').click();
        await expect.poll(() => page.evaluate(() => window.testDocuments.find(item => item.id === 1)?.current_review_status)).toBe('approved');
        await expect.poll(() => page.evaluate(() => window.testDocuments.find(item => item.id === 1)?.current_effect_status)).toBe('effective');
        await page.close();
    } finally {
        await browser.close();
    }
});

test('元数据审核在同一工作台并排展示法规原文和审核表单', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true, user: { username: 'manager', role: 'admin', permissionTier: 'manager' } });
        await page.locator('#regulations-quality-btn').click();
        await page.locator('[data-regulation-governance-worklist="metadata"]').click();
        await page.locator('[data-regulation-document-governance="1"]').click();

        const panel = page.locator('#regulations-detail-panel');
        const form = page.locator('#regulations-edit-form');
        const evidence = page.locator('#regulations-detail-body');
        await expect(panel).toHaveClass(/regulations-metadata-review-mode/);
        await expect(form).toBeVisible();
        await expect(form).toContainText('审核法规元数据');
        await expect(evidence).toContainText('法规原文');
        await expect(evidence).toContainText('测试法规原文，用于核验元数据');
        await expect(page.locator('.regulations-review-evidence-head')).toContainText('审核依据');
        assert.equal(await page.evaluate(() => window.getComputedStyle(document.getElementById('regulations-detail-content')).display), 'grid');

        await form.locator('[data-regulation-cancel-inline]').click();
        await expect(panel).not.toHaveClass(/regulations-metadata-review-mode/);
        await expect(form).toBeHidden();
        await page.close();
    } finally {
        await browser.close();
    }
});

test('质量概览其余治理项均可进入队列、执行操作并收敛待办', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true, user: { username: 'manager', role: 'admin', permissionTier: 'manager' } });
        const openQuality = async () => {
            if (await page.locator('#regulations-quality-panel').isHidden()) await page.locator('#regulations-quality-btn').click();
        };

        await openQuality();
        await page.locator('[data-regulation-governance-worklist="metadata"]').click();
        await expect(page.locator('#regulations-folder-index')).toContainText('元数据待审核法规 · 治理队列');
        await page.locator('[data-regulation-document-governance="1"]').click();
        await page.locator('#regulations-edit-form [name="legalLevel"]').fill('法律');
        await page.locator('#regulations-edit-form [name="officialSourceUrl"]').fill('https://authority.example/one');
        await page.locator('#regulations-edit-form [name="metadataReviewStatus"]').selectOption('approved');
        await page.locator('#regulations-edit-form button[type="submit"]').click();
        await expect.poll(() => page.evaluate(() => window.testDocuments.find(item => item.id === 1)?.metadata_review_status)).toBe('approved');
        await page.evaluate(() => document.getElementById('regulations-detail-panel')?.classList.add('hidden'));

        await openQuality();
        await page.locator('[data-regulation-governance-worklist="maintainer"]').click();
        await expect(page.locator('#regulations-folder-index')).toContainText('缺少维护人法规 · 治理队列');
        await page.locator('[data-regulation-document-governance="1"]').click();
        await page.locator('#regulations-edit-form [name="maintainerUserId"]').selectOption('1');
        await page.locator('#regulations-edit-form button[type="submit"]').click();
        await expect.poll(() => page.evaluate(() => Number(window.testDocuments.find(item => item.id === 1)?.maintainer_user_id || 0))).toBe(1);
        await page.evaluate(() => document.getElementById('regulations-detail-panel')?.classList.add('hidden'));

        await openQuality();
        await page.locator('[data-regulation-governance-worklist="index"]').click();
        await expect(page.locator('#regulations-folder-index')).toContainText('索引未完成法规 · 治理队列');
        await page.locator('[data-regulation-reindex-document="1"]').click();
        await expect.poll(() => page.evaluate(() => window.testDocuments.find(item => item.id === 1)?.current_index_status)).toBe('vector_ready');
        await page.evaluate(() => document.getElementById('regulations-detail-panel')?.classList.add('hidden'));

        await openQuality();
        await page.locator('[data-regulation-governance-worklist="location"]').click();
        await expect(page.locator('#regulations-folder-index')).toContainText('条文缺少定位法规 · 治理队列');
        await page.locator('[data-regulation-rebuild-locations-document="3"]').click();
        await expect.poll(() => page.evaluate(() => window.testDocuments.find(item => item.id === 3)?.location_missing)).toBe(false);

        await openQuality();
        await page.locator('[data-regulation-citation-governance="unresolved"]').click();
        await expect(page.locator('#regulations-citation-governance-body')).toContainText('《外部法规》第三条');
        await page.locator('[data-regulation-citation-review="rejected"][data-regulation-citation-id="801"]').click();
        await expect.poll(() => page.evaluate(() => window.testCitationLinks.find(item => item.id === 801)?.review_status)).toBe('rejected');

        await page.locator('[data-regulations-close-citation-governance]').click();
        await openQuality();
        await page.locator('[data-regulation-citation-governance="review"]').click();
        await page.locator('[data-regulation-citation-approve-high]').click();
        await expect.poll(() => page.evaluate(() => window.testCitationLinks.find(item => item.id === 802)?.review_status)).toBe('approved');
        await page.close();
    } finally {
        await browser.close();
    }
});
