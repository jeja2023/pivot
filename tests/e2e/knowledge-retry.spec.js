'use strict';
const { test, expect } = require('@playwright/test');
const { Client } = require('pg');

test('失败文档的批量重试返回实际调度数量并重新建立索引', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离 PostgreSQL 测试库');
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const upload = await page.request.post('/api/rag/upload', { headers, multipart: { file: { name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('重试后应恢复的独立测试内容。', 'utf8') } } });
    expect(upload.ok()).toBeTruthy();
    const docId = (await upload.json()).docId;
    await expect.poll(async () => {
        const response = await page.request.get(`/api/rag/docs/${docId}`);
        return response.ok() && (await response.json()).chunks?.length > 0;
    }, { timeout: 30_000 }).toBe(true);
    const schema = String(process.env.PG_TEST_SCHEMA || '');
    expect(schema).toMatch(/^pivot_e2e_[a-z0-9_]+$/);
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query("UPDATE knowledge_docs SET status = 'error' WHERE id = $1", [docId]);
    } finally { await client.end(); }
    const retry = await page.request.post('/api/rag/docs/retry-failed', { headers });
    expect(retry.ok()).toBeTruthy();
    expect(await retry.json()).toMatchObject({ success: true, total: 1, scheduled: 1, alreadyProcessing: 0 });
    await expect.poll(async () => {
        const response = await page.request.get(`/api/rag/docs/${docId}`);
        if (!response.ok()) return false;
        const doc = await response.json();
        return ['ready', 'lexical_ready'].includes(doc.doc?.status) && doc.chunks?.some(chunk => chunk.content.includes('重试后应恢复'));
    }, { timeout: 30_000 }).toBe(true);
    const debug = await page.request.post('/api/rag/debug-query', { headers, data: { query: '重试后应恢复' } });
    expect(debug.ok()).toBeTruthy();
    const debugBody = await debug.json();
    expect(debugBody.queue).toMatchObject({ pending: expect.any(Number), running: expect.any(Number), maxConcurrent: expect.any(Number) });
    const history = await page.request.get('/api/rag/debug-query/history');
    expect(history.ok()).toBeTruthy();
    const entry = (await history.json()).data.find(item => item.query === '重试后应恢复');
    expect(entry?.queue).toEqual(debugBody.queue);
});

test('重复导入生成独立文档，删除其中一份后不会影响另一份的检索', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(process.env.PIVOT_E2E_ISOLATED !== 'true', '需要隔离 PostgreSQL 测试库');
    expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } })).ok()).toBeTruthy();
    const headers = { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
    const file = { name: '重复资料.txt', mimeType: 'text/plain', buffer: Buffer.from('紫藤项目唯一验证条款：所有成员应按计划登记检查结果。', 'utf8') };
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
        const response = await page.request.post('/api/rag/upload', { headers, multipart: { file } });
        expect(response.ok()).toBeTruthy();
        ids.push((await response.json()).docId);
    }
    expect(ids[0]).not.toBe(ids[1]);
    const chunks = [];
    for (const id of ids) {
        await expect.poll(async () => {
            const response = await page.request.get(`/api/rag/docs/${id}`);
            if (!response.ok()) return false;
            const detail = await response.json();
            if (detail.chunks?.length) chunks.push(detail.chunks[0].id);
            return detail.chunks?.length > 0;
        }, { timeout: 30_000 }).toBe(true);
    }
    const query = async () => (await (await page.request.post('/api/rag/debug-query', { headers, data: { query: '紫藤项目唯一验证条款' } })).json()).matches.map(item => String(item.chunkId));
    await expect.poll(query, { timeout: 15_000 }).toEqual(expect.arrayContaining(chunks.map(String)));
    expect((await page.request.delete(`/api/rag/docs/${ids[0]}`, { headers })).ok()).toBeTruthy();
    expect((await page.request.get(`/api/rag/docs/${ids[0]}`)).status()).toBe(404);
    expect((await page.request.get(`/api/rag/docs/${ids[1]}`)).ok()).toBeTruthy();
    await expect.poll(async () => {
        const matched = await query();
        return matched.includes(String(chunks[1])) && !matched.includes(String(chunks[0]));
    }, { timeout: 15_000 }).toBe(true);
});
