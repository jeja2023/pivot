const { expect, test } = require('@playwright/test');

test.describe('Pivot browser smoke', () => {
    test('chat shell loads safe HTML and Pivot module namespace', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toBeVisible();
        await page.waitForFunction('() => Boolean(window.Pivot && window.Pivot.modules && window.Pivot.html)');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.ui"])');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.attachments"])');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.messageVirtualizer"])');
    });

    test('knowledge workspace exposes RAG debug controls', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#rag-debug-modal')).toHaveCount(1);
        await expect(page.locator('#rag-debug-history')).toHaveCount(1);
        await expect(page.locator('#rag-debug-results')).toHaveCount(1);
    });
});
