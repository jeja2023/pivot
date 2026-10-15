/* global document, window -- 浏览器测试执行上下文 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规筛选和问答范围在浏览器端提交明确的后端参数', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true });
        await page.locator('#regulations-open-search-btn').click();
        await page.locator('#regulations-issuing-body-filter').fill('国务院');
        await page.locator('#regulations-status-filter').selectOption('active');
        await page.locator('#regulations-search-btn').click();
        const params = await page.evaluate(() => {
            const query = new URL(window.testSearchRequest, 'http://pivot.test').searchParams;
            return { issuingBody: query.get('issuingBody'), status: query.get('status') };
        });
        assert.equal(params.issuingBody, '国务院');
        assert.equal(params.status, 'active');
        await expect(page.locator('#regulations-modal-search-results')).toContainText('测试法规 1');
        await page.locator('[data-regulations-close-search]').click();
        await expect(page.locator('#regulations-query')).toHaveValue('');

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
            document.getElementById('regulations-detail-panel').classList.remove('hidden');
        });
        await page.locator('[data-article-ask="11"]').click();
        await expect(page.locator('#regulations-ai-scope')).toHaveValue('document');
        await page.locator('#regulations-ai-question').fill('本条如何执行？');
        await page.locator('#regulations-ai-btn').click();
        const aiRequest = await page.evaluate(() => window.testAiRequest);
        assert.equal(aiRequest.documentId, 1);
        await page.close();
    } finally {
        await browser.close();
    }
});

test('法规检索期间禁用检索按钮，关闭弹窗会清空并取消检索词', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true });
        await page.locator('#regulations-open-search-btn').click();
        await page.locator('#regulations-query').fill('三年以下有期徒刑');
        await page.evaluate(() => { window.testSearchDeferred = true; });
        await page.locator('#regulations-search-btn').click();
        await expect(page.locator('#regulations-search-btn')).toBeDisabled();
        await expect(page.locator('#regulations-search-btn')).toHaveText('检索中…');
        await expect(page.locator('#regulations-modal-search-results')).toContainText('正在检索法规条文');

        await page.locator('[data-regulations-close-search]').click();
        await expect(page.locator('#regulations-search-panel')).toBeHidden();
        await expect(page.locator('#regulations-query')).toHaveValue('');
        await expect.poll(() => page.evaluate(() => window.Pivot.legacy.PivotRegulationsInternal.state.query)).toBe('');
        await expect(page.locator('#regulations-search-btn')).toBeEnabled();
        await page.evaluate(() => window.testReleaseSearch?.());
        await page.close();
    } finally {
        await browser.close();
    }
});
