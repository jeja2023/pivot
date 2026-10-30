'use strict';
/* global window -- 浏览器执行上下文 */
const { test, expect } = require('@playwright/test');
const { Client } = require('pg');
const JSZip = require('jszip');

test('文本附件经上传和解析进入模型上下文，刷新后仍可打开', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(login.ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const name = `附件模型${Date.now()}`;
    expect((await page.request.post('/api/models', { headers, data: { name, url: process.env.E2E_MODEL_URL, model_name: 'e2e-real-model' } })).ok()).toBeTruthy();
    const model = (await (await page.request.get('/api/models?limit=100')).json()).data.find(item => item.name === name);
    expect((await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: model.id } })).ok()).toBeTruthy();
    const session = await (await page.request.post('/api/sessions', { headers, data: { title: '附件回归' } })).json();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
    await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
    await page.locator('#file-input').setInputFiles({ name: '独立样本.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E_ATTACHMENT_独立样本文本', 'utf8') });
    await expect(page.locator('#attachment-preview')).toContainText('独立样本.txt');
    await page.locator('#user-input').fill('请根据附件回答。');
    await page.locator('#send-btn').click();
    await expect(page.locator('#message-container')).toContainText('已收到附件中的独立样本文本。', { timeout: 30_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
    await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
    const link = page.locator('#message-container [data-attachment-preview]').filter({ hasText: '独立样本.txt' }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.locator('#attachment-preview-modal')).toBeVisible();
    await expect(page.locator('#attachment-preview-content')).toContainText('E2E_ATTACHMENT_独立样本文本');
});

test('损坏的文档被拒绝，保留输入并可替换后继续发送', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const name = `附件恢复模型${Date.now()}`;
    expect((await page.request.post('/api/models', { headers, data: { name, url: process.env.E2E_MODEL_URL, model_name: 'e2e-real-model' } })).ok()).toBeTruthy();
    const model = (await (await page.request.get('/api/models?limit=100')).json()).data.find(item => item.name === name);
    expect((await page.request.put('/api/settings/default-model', { headers, data: { default_model_id: model.id } })).ok()).toBeTruthy();
    const session = await (await page.request.post('/api/sessions', { headers, data: { title: '附件失败恢复' } })).json();
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Pivot?.legacy?.selectSession));
    await page.evaluate(id => window.Pivot.legacy.selectSession(id), session.id);
    await page.locator('#file-input').setInputFiles({ name: '不支持.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid') });
    await expect(page.locator('#toast-container')).toContainText('所选文件类型不受支持');
    await expect(page.locator('#attachment-preview')).not.toContainText('不支持.exe');
    await page.locator('#file-input').setInputFiles({ name: '损坏.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]) });
    await page.locator('#user-input').fill('请根据附件回答。');
    const upload = page.waitForResponse(response => response.url().includes('/api/upload?') && response.request().method() === 'POST');
    await page.locator('#send-btn').click();
    expect((await upload).status()).toBe(422);
    await expect(page.locator('#toast-container')).toContainText('无法读取文档内容');
    await expect(page.locator('#user-input')).toHaveValue('请根据附件回答。');
    await expect(page.locator('#attachment-preview')).toContainText('损坏.docx');
    await expect(page.locator('#message-container')).not.toContainText('请根据附件回答。');
    await page.getByRole('button', { name: '移除附件' }).click();
    await page.locator('#file-input').setInputFiles({ name: '替换.txt', mimeType: 'text/plain', buffer: Buffer.from('E2E_ATTACHMENT_独立样本文本', 'utf8') });
    await page.locator('#send-btn').click();
    await expect(page.locator('#message-container')).toContainText('已收到附件中的独立样本文本。', { timeout: 30_000 });
});

test('损坏的表格和 PDF 不被记为成功附件', async ({ page }) => {
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离测试环境');
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const session = await (await page.request.post('/api/sessions', { headers, data: { title: '损坏附件验证' } })).json();
    const archive = new JSZip();
    archive.file('unrelated.txt', 'not an Office document');
    const fakeOffice = await archive.generateAsync({ type: 'nodebuffer' });
    for (const file of [
        { name: '损坏.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]) },
        { name: '伪装.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: fakeOffice },
        { name: '伪装.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fakeOffice },
        { name: '损坏.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nnot a pdf') }
    ]) {
        const response = await page.request.post(`/api/upload?sessionId=${encodeURIComponent(session.id)}`, { headers, multipart: { file } });
        expect(response.status()).toBe(422);
        expect(await response.json()).toMatchObject({ code: 'DOCUMENT_EXTRACTION_FAILED' });
    }
    const schema = String(process.env.PG_TEST_SCHEMA || '');
    expect(schema).toMatch(/^pivot_e2e_[a-z0-9_]+$/);
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        await client.query(`SET search_path TO "${schema}", public`);
        const result = await client.query('SELECT COUNT(*)::int AS count FROM attachments WHERE session_id = $1', [session.id]);
        expect(result.rows[0].count).toBe(0);
    } finally { await client.end(); }
});
