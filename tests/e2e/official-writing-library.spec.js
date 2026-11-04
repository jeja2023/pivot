'use strict';
/* global window, runOfficialWritingAiTask */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const JSZip = require('jszip');

async function login(page) {
    const response = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' } });
    expect(response.ok()).toBeTruthy();
    return { 'x-csrf-token': (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value };
}

test('公文摘要真正分页，检索筛选，文档详情与产物绑定按用户隔离', async ({ page, browser }) => {
    test.setTimeout(90_000);
    const headers = await login(page);
    const prefix = `audit-${Date.now()}`;
    const ids = [];
    for (let index = 0; index < 23; index++) {
        const id = `${prefix}-${index}`; ids.push(id);
        const response = await page.request.put(`/api/apps/official-writing/documents/${id}`, { headers,
            data: { title: `${prefix}-${String(index).padStart(2, '0')}`, manualTitle: true, version: 0,
                state: { docType: index % 2 ? '通知' : '报告', draft: `关于工作的通知\n正文${index}\n某单位\n2026年11月4日`, source: '本篇事实材料' } } });
        expect(response.ok(), await response.text()).toBeTruthy();
    }
    const list = await (await page.request.get(`/api/apps/official-writing/documents?query=${prefix}&limit=10&page=2&sort=title`)).json();
    expect(list.total).toBe(23); expect(list.data).toHaveLength(10);
    expect(list.data.every(doc => !Object.hasOwn(doc, 'state'))).toBeTruthy();
    expect(list.data[0].title).toBe(`${prefix}-10`);
    const filtered = await (await page.request.get(`/api/apps/official-writing/documents?query=${prefix}&docType=${encodeURIComponent('通知')}&limit=50`)).json();
    expect(filtered.total).toBe(11);
    expect(filtered.data.every(doc => doc.summary.docType === '通知')).toBeTruthy();
    const first = (await (await page.request.get(`/api/apps/official-writing/documents/${ids[0]}`)).json()).document;
    const legacyList = (await (await page.request.get('/api/apps/official-writing/documents')).json()).data;
    expect(legacyList.find(doc => doc.id === ids[0]).state.draft).toContain('正文0');
    const oldClient = await page.request.put(`/api/apps/official-writing/documents/${ids[0]}`, { headers, data: { title: first.title, state: { draft: '不应覆盖' }, version: first.version } });
    expect(oldClient.status()).toBe(409);
    const exportA = await page.request.post(`/api/apps/official-writing/documents/${ids[0]}/export-artifact`, { headers, data: { version: first.version } });
    expect(exportA.ok(), await exportA.text()).toBeTruthy();
    const idA = (await exportA.json()).artifactId;
    const second = (await (await page.request.get(`/api/apps/official-writing/documents/${ids[1]}`)).json()).document;
    const exportB = await page.request.post(`/api/apps/official-writing/documents/${ids[1]}/export-artifact`, { headers, data: { version: second.version, artifactId: idA } });
    expect(exportB.ok(), await exportB.text()).toBeTruthy();
    expect((await exportB.json()).artifactId).not.toBe(idA);
    const replay = await page.request.post(`/api/apps/official-writing/documents/${ids[0]}/export-artifact`, { headers, data: { version: first.version } });
    expect((await replay.json()).artifactId).toBe(idA);
    expect((await (await page.request.get(`/api/apps/official-writing/documents/${ids[0]}`)).json()).document.artifactId).toBe(idA);
    const stale = await page.request.post(`/api/apps/official-writing/documents/${ids[0]}/export-artifact`, { headers, data: { version: 999 } });
    expect(stale.status()).toBe(409);
    const username = `owuser${Date.now()}`;
    expect((await page.request.post('/api/admin/users', { headers, data: { username, password: 'WritingTest123!', nickname: '公文隔离验收', unit: 'QA', role: 'user' } })).ok()).toBeTruthy();
    const other = await browser.newContext();
    try {
        const request = await other.newPage();
        await request.goto('/chat');
        const logged = await request.request.post('/api/auth/login', { data: { username, password: 'WritingTest123!' } });
        expect(logged.ok()).toBeTruthy();
        const token = (await other.cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        expect((await request.request.get(`/api/apps/official-writing/documents/${ids[0]}`)).status()).toBe(404);
        expect((await request.request.post(`/api/apps/official-writing/documents/${ids[0]}/export-artifact`, { headers: { 'x-csrf-token': token }, data: { version: first.version } })).status()).toBe(404);
    } finally { await other.close(); }
});

test('完整应用逐字输入、空行保存、撤销重做与 AI 预览不覆盖新编辑', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    await page.goto('/chat');
    await page.waitForFunction(() => !!window.Pivot?.moduleApi('workspaces.navigation'));
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'official-writing' }));
    await page.locator('#official-writing-create-doc-btn').click();
    await page.locator('#official-writing-create-title').fill('新版输入与预览验收');
    await page.locator('#official-writing-create-confirm-btn').click();
    const draft = page.locator('#official-writing-draft-surface');
    await draft.click(); await page.keyboard.type('abc'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.type('def');
    await expect(draft).toHaveText('abc\n\ndef');
    await page.keyboard.press('Control+z');
    expect(await page.locator('#official-writing-draft').inputValue()).toBe('abc\n\n');
    await page.keyboard.press('Control+y'); await expect(draft).toHaveText('abc\n\ndef');
    await page.locator('#official-writing-back-to-library-btn').click();
    const saved = (await (await page.request.get(`/api/apps/official-writing/documents?query=${encodeURIComponent('新版输入与预览验收')}`)).json()).data[0];
    await expect.poll(async () => (await (await page.request.get(`/api/apps/official-writing/documents/${saved.id}`)).json()).document.state.draft).toBe('abc\n\ndef');
    await page.getByRole('button', { name: '编辑', exact: true }).first().click();
    let release;
    let received;
    const held = new Promise(resolve => { received = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/apps/official-writing/ai', async route => {
        received(); await gate;
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"AI生成结果"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' });
    });
    try {
        await page.evaluate(() => { window.aiAcceptance = runOfficialWritingAiTask('draft'); });
        await held;
        await page.locator('#official-writing-result-close-btn').click();
        await draft.fill('等待时新写的正文');
        release();
        await page.evaluate(() => window.aiAcceptance);
        await expect(draft).toContainText('等待时新写的正文');
        await page.locator('#official-writing-result-apply-btn').click();
        await expect(draft).toContainText('等待时新写的正文');
        await expect(page.locator('#toast-container')).toContainText('原文已变化');
    } finally { release(); }
});

test('公文 AI 经真实路由调用受控模型并保留流式完成标记', async ({ page }) => {
    test.setTimeout(60_000);
    const headers = await login(page);
    const name = `公文模型-${Date.now()}`;
    expect((await page.request.post('/api/models', { headers, data: { name, url: process.env.E2E_MODEL_URL, model_name: 'e2e-official-writing' } })).ok()).toBeTruthy();
    const models = (await (await page.request.get('/api/models?limit=100')).json()).data;
    const model = models.find(model => model.name === name);
    const response = await page.request.post('/api/apps/official-writing/ai', { headers, data: {
        mode: 'draft', model: model.id, stream: true, docType: '通知', title: '年度安排', requirements: '生成简洁初稿', source: '本年度检查工作安排。'
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = await response.text();
    expect(body).toContain('data:');
    expect(body).toContain('finish_reason');
    expect(body).toContain('[DONE]');
    expect(body).not.toContain('<think>');
});

test('公文真实导出预览、PDF 与 DOCX 下载保留发文要素且复用本篇产物', async ({ page }) => {
    test.setTimeout(90_000);
    const headers = await login(page);
    const fontStatus = await (await page.request.get('/api/apps/official-writing/format')).json();
    test.skip(!fontStatus.available, '服务端未安装公文指定字体，跳过真实导出预览与 PDF/DOCX 下载');
    const id = `export-${Date.now()}`;
    const saved = await page.request.put(`/api/apps/official-writing/documents/${id}`, { headers, data: { title: '公文导出验收', version: 0, manualTitle: true,
        state: { docType: '通知', draft: '关于年度检查的通知\n各单位：\n请认真落实年度检查工作。\n示例局\n2026年11月4日',
            meta: { issuingOrg: '示例局', secrecy: '秘密★1年', issuer: '张某', cc: '各直属单位', printer: '示例局办公室', printDate: '2026年11月5日' },
            attachments: [{ id: 'one', name: '年度检查反馈表', content: '一、反馈情况\n(一)检查项目\n1. 年度目标\n(1)完成情况' }] } } });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    await page.goto('/chat');
    await page.waitForFunction(() => !!window.Pivot?.moduleApi('workspaces.navigation'));
    await page.evaluate(docId => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'official-writing', docId }), id);
    await expect(page.locator('#official-writing-active-doc-title')).toHaveText('公文导出验收');
    for (const format of ['pdf', 'doc']) {
        await page.getByLabel('展开导出操作').click();
        await page.locator(`[data-official-writing-export="${format}"]`).click();
        await expect(page.locator('#official-writing-export-confirm-btn')).toBeEnabled({ timeout: 30_000 });
        await expect(page.locator('#official-writing-export-elements')).toContainText('抄送：各直属单位');
        await expect(page.locator('#official-writing-export-frame canvas').first()).toBeVisible();
        if (process.env.PIVOT_OFFICIAL_VISUAL_QA === 'true') await page.screenshot({ path: `.codex-tmp/ow-rendered/export-${format}.png` });
        const downloading = page.waitForEvent('download');
        await page.locator('#official-writing-export-confirm-btn').click();
        const download = await downloading;
        const buffer = await fs.readFile(await download.path());
        if (format === 'pdf') expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
        else {
            const zip = await JSZip.loadAsync(buffer);
            expect(await zip.file('word/document.xml').async('string')).toContain('抄送：各直属单位');
            expect(await zip.file('word/document.xml').async('string')).toContain('附件：年度检查反馈表');
            expect(await zip.file('word/document.xml').async('string')).toContain('方正仿宋_GBK');
            expect(await zip.file('word/document.xml').async('string')).toContain('w:linePitch="560"');
            expect(await zip.file('word/header1.xml').async('string')).toContain('秘密★1年');
        }
        await page.locator('#official-writing-export-close-btn').click();
    }
    const latest = (await (await page.request.get(`/api/apps/official-writing/documents/${id}`)).json()).document;
    expect(latest.artifactId).toMatch(/^\d+$/);
    const detail = await (await page.request.get(`/api/agents/artifacts/${latest.artifactId}/versions`)).json();
    expect(detail.versions || detail.data).toHaveLength(1);
});
