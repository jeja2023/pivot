const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium, expect } = require('@playwright/test');
const { createPage } = require('./helpers/regulations-browser');

test('法规导入预设区分全国人大常委会法律解释和两高联合司法解释', { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await createPage(browser, { includeAdvanced: true });
        await page.locator('#regulations-open-upload-btn').click();

        await page.locator('[data-preset="legalInterpretation"]').click();
        const form = page.locator('#regulations-upload-form');
        await expect(form.locator('[name="legalLevel"]')).toHaveValue('法律解释');
        await expect(form.locator('[name="category"]')).toHaveValue('法律解释');
        await expect(form.locator('[name="issuingBody"]')).toHaveValue('全国人民代表大会常务委员会');

        await page.locator('[data-preset="jointInterpretation"]').click();
        await expect(form.locator('[name="legalLevel"]')).toHaveValue('司法解释');
        await expect(form.locator('[name="category"]')).toHaveValue('司法解释');
        await expect(form.locator('[name="issuingBody"]')).toHaveValue('最高人民法院、最高人民检察院');
        assert.equal(await form.locator('[name="jurisdiction"]').inputValue(), '全国');
        await page.close();
    } finally {
        await browser.close();
    }
});
