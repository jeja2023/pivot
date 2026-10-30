'use strict';
/* global window */
const { test, expect } = require('@playwright/test');
const { PDFDocument } = require('pdf-lib');
const http = require('node:http');
const { Client } = require('pg');

test('OCR 页面可处理部分失败并重试，已成功页保持不变', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    let calls = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }
        req.resume();
        req.on('end', () => {
            calls += 1;
            res.writeHead(calls === 2 ? 503 : 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(calls === 2 ? { error: '模拟第二页暂时失败' } : { text: `测试识别第${calls}次`, confidence: 0.98 }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await page.goto('/chat');
        await page.locator('#username').fill('admin');
        await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
        await page.locator('#auth-submit').click();
        await expect(page.locator('#app')).toBeVisible();
        const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
        const url = `http://127.0.0.1:${server.address().port}`;
        const settings = await page.request.put('/api/apps/ocr/settings', { headers, data: { serviceUrl: url } });
        expect(settings.ok()).toBeTruthy();
        expect((await settings.json()).settings.serviceUrl).toBe(url);
        const schema = String(process.env.PG_TEST_SCHEMA || '');
        expect(schema).toMatch(/^pivot_e2e_[a-z0-9_]+$/);
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        await client.connect();
        try {
            await client.query(`SET search_path TO "${schema}", public`);
            const row = await client.query("SELECT value FROM app_settings WHERE key = 'document_processing_ocr_service_url'");
            expect(row.rows[0]?.value).toBe(url);
        } finally { await client.end(); }
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'ocr' }));
        await expect(page.locator('#ocr-upload-form')).toBeVisible();
        const pdf = await PDFDocument.create(); pdf.addPage([300, 200]); pdf.addPage([300, 200]);
        await page.locator('#ocr-file-input').setInputFiles({ name: 'ocr-retry.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
        const created = page.waitForResponse(response => response.url().endsWith('/api/apps/ocr/jobs') && response.request().method() === 'POST');
        await page.locator('#ocr-submit-btn').click();
        const creation = await created;
        expect(creation.ok()).toBeTruthy();
        const id = (await creation.json()).job.id;
        const getDetail = async () => (await (await page.request.get(`/api/apps/ocr/jobs/${id}`)).json());
        await expect.poll(async () => (await getDetail()).job.status, { timeout: 45_000 }).toBe('partial_success');
        const partial = await getDetail();
        expect(partial.pages.find(item => item.pageNumber === 1).text).toBe('测试识别第1次');
        await page.locator(`[data-ocr-job-open="${id}"]`).click();
        await expect(page.locator(`[data-ocr-job-retry="${id}"]`)).toBeVisible();
        const retry = page.waitForResponse(response => response.url().endsWith(`/api/apps/ocr/jobs/${id}/retry`) && response.request().method() === 'POST');
        await page.locator(`[data-ocr-job-retry="${id}"]`).click();
        expect((await retry).ok()).toBeTruthy();
        await expect.poll(async () => (await getDetail()).job.status, { timeout: 45_000 }).toBe('succeeded');
        const final = await getDetail();
        expect(final.pages.find(item => item.pageNumber === 1).text).toBe('测试识别第1次');
        expect(final.pages.find(item => item.pageNumber === 2).text).toBe('测试识别第3次');
        expect(calls).toBe(3);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
