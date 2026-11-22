'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const service = require('../server/services/presentations/presentation-service');
const { queryOne } = require('../server/db/client');

async function startApi(t, call) {
    const user = await queryOne('SELECT * FROM users ORDER BY id LIMIT 1');
    t.mock.method(require('../server/routes/apps/helpers'), 'resolveAppsModel', async () =>
        ({ id: 1, model_name: 'fixture', name: '测试模型', context_window_tokens: 256000 }));
    t.mock.method(require('../server/services/model-text-call'), 'callModelTextWithBudget', async options => ({
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, ...await call(options)
    }));
    const routerPath = require.resolve('../server/routes/apps/presentations');
    delete require.cache[routerPath];
    const app = express(), passthrough = (_req, _res, next) => next();
    app.use(express.json(), require(routerPath).createPresentationsRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        uploadLimiter: passthrough, upload: { single: () => passthrough }
    }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code, error: error.message }));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    t.after(() => delete require.cache[routerPath]);
    const request = async (path, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/apps/presentations${path}`, body === undefined
            ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
    };
    return { user, request };
}

test('真实改写路由按文稿保存的设计模板生成语义页，并拒绝批准页', { skip: !process.env.DATABASE_URL }, async t => {
    let calls = 0;
    const { user, request } = await startApi(t, ({ messages, jsonObject }) => {
        calls++;
        assert.equal(jsonObject, true);
        assert.match(messages[1].content, /不输出 elements/);
        return { content: JSON.stringify({ title: '设计文稿', slides: [{ title: '改写页', layout: 'content', points: ['保留真实要点'] }] }) };
    });
    const document = await service.createPresentation(user, { title: '设计文稿', templateId: 'executive-clean' });
    const slide = document.content.slides[0], body = {
        presentationId: document.id, templateId: 'business-blue', templateVersion: 9999, model: '1',
        slide: { id: slide.id }, instruction: '整理成要点'
    };
    const result = await request('/ai/rewrite', body);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const proposal = result.data.proposal.presentation;
    assert.equal(proposal.template.id, document.template.id);
    assert.equal(proposal.template.version, document.template.version);
    assert.equal(proposal.slides.length, 1);
    assert.ok(proposal.slides[0].elements.some(element => element.content?.text.includes('保留真实要点')));
    await service.reviewPresentationSlide(user, document.id, slide.id, true);
    const denied = await request('/ai/rewrite', body);
    assert.equal(denied.status, 409);
    assert.equal(denied.data.code, 'PRESENTATION_SLIDE_APPROVED');
    assert.equal(calls, 1);
});

test('分批路由保存成功页，失败页可补齐，改动后的大纲由原草稿拒绝', { skip: !process.env.DATABASE_URL }, async t => {
    const batches = [];
    let fillMissing = false;
    const { request } = await startApi(t, ({ messages }) => {
        const outline = JSON.parse(messages[1].content.split('\n').find(line => line.startsWith('大纲：')).slice(3));
        const ids = outline.slides.map(page => page.outlinePageId);
        batches.push(ids);
        return { content: JSON.stringify({ slides: outline.slides.map(page => ({
            outlinePageId: page.outlinePageId, title: page.title,
            ...(page.layoutHint === 'chart'
                ? { layout: 'chart', ...(fillMissing ? { chart: { type: 'bar', columns: ['指标', '值'], rows: [['营收', 120]] } } : {}) }
                : { layout: 'content', points: ['已确认要点'] })
        })) }) };
    });
    const draftId = 'pptgen_' + crypto.randomBytes(16).toString('hex');
    const outline = { title: '经营分析', slides: [{ title: '概况' }, { title: '营收', layoutHint: 'chart' }, { title: '行动' }] };
    const body = { draftId, title: outline.title, outline, templateId: 'executive-clean', model: '1' };
    const partial = await request('/ai/slides', body);
    assert.equal(partial.status, 422, JSON.stringify(partial.data));
    assert.equal(partial.data.code, 'PRESENTATION_SLIDE_COVERAGE_INCOMPLETE');
    const saved = await request('/' + draftId);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual(saved.data.presentation.content.slides.map(slide => slide.id), ['outline_page_1', 'outline_page_3']);
    assert.deepEqual(saved.data.presentation.generation.pending.map(page => page.id), ['outline_page_2']);
    const blocked = await request('/' + draftId + '/export', { format: 'pdf' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'PRESENTATION_GENERATION_INCOMPLETE');
    const changed = await request('/ai/slides', { ...body, outline: { ...outline, slides: [{ title: '其他大纲' }] } });
    assert.equal(changed.status, 409);
    assert.equal(changed.data.code, 'PRESENTATION_GENERATION_PLAN_CHANGED');
    fillMissing = true;
    const filled = await request('/' + draftId + '/ai/fill-missing', { model: '1' });
    assert.equal(filled.status, 200, JSON.stringify(filled.data));
    const complete = await request('/' + draftId);
    assert.deepEqual(complete.data.presentation.content.slides.map(slide => slide.id), ['outline_page_1', 'outline_page_2', 'outline_page_3']);
    assert.deepEqual(complete.data.presentation.generation.pending, []);
    assert.deepEqual(batches, [['outline_page_1', 'outline_page_2', 'outline_page_3'], ['outline_page_2'], ['outline_page_2']]);
    const { draftId: _draftId, ...proposalRequest } = body;
    const proposal = await request('/ai/slides', proposalRequest);
    assert.equal(proposal.status, 200, JSON.stringify(proposal.data));
    assert.equal(proposal.data.proposal.generatedPages, 3);
    assert.ok(proposal.data.proposal.presentation.slides[1].elements.some(element => element.type === 'chart'));
});

test('补页路由仅在显式确认后允许缺图页用正文，并保留已保存页面', { skip: !process.env.DATABASE_URL }, async t => {
    const { request } = await startApi(t, ({ messages }) => {
        const outline = JSON.parse(messages[1].content.split('\n').find(line => line.startsWith('大纲：')).slice(3));
        return { content: JSON.stringify({ slides: outline.slides.map(page => ({
            outlinePageId: page.outlinePageId, title: page.title, layout: 'content', points: ['已确认要点']
        })) }) };
    });
    const draftId = 'pptgen_' + crypto.randomBytes(16).toString('hex');
    const outline = { title: '规划', slides: [{ title: '概况' }, { title: '图片资料', layoutHint: 'image-focus' }] };
    const path = '/' + draftId;
    const partial = await request('/ai/slides', { draftId, outline, templateId: 'executive-clean', model: '1' });
    assert.equal(partial.status, 422, JSON.stringify(partial.data));
    const before = (await request(path)).data.presentation;
    assert.deepEqual(before.generation.pending.map(page => page.id), ['outline_page_2']);
    const strict = await request(path + '/ai/fill-missing', { model: '1' });
    assert.equal(strict.data.code, 'PRESENTATION_SLIDE_COVERAGE_INCOMPLETE');
    const approved = await request(path + '/ai/fill-missing', { model: '1', allowTextFallback: true });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.match(approved.data.warnings.join('\n'), /已按确认改用正文/);
    const after = (await request(path)).data.presentation;
    assert.deepEqual(after.generation.pending, []);
    assert.deepEqual(after.content.slides[0], before.content.slides[0]);
});

test('标准导出路由登记包含可见表格的 PDF', { skip: !process.env.DATABASE_URL }, async t => {
    const { user, request } = await startApi(t, () => assert.fail('导出不调用模型'));
    const document = await service.createPresentation(user, { title: '数据表', templateId: 'business-blue' });
    const content = document.content;
    content.slides[0].elements.push({
        id: 'table', type: 'table', x: 88, y: 410, width: 900, height: 220,
        columns: ['指标', '数值'], rows: [['收入', '120 万元']]
    });
    await service.savePresentationContent(user, document.id, { baseVersion: document.version, content });
    const result = await request('/' + document.id + '/export', { format: 'pdf' });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const { rendition } = result.data;
    assert.equal(rendition.format, 'pdf');
    assert.equal(rendition.mime_type, 'application/pdf');
    const { buffer } = await require('../server/services/agent-artifact-cas').readBuffer({
        ref: rendition.storage_ref, tenantId: Number(rendition.tenant_id), tenantScoped: true
    });
    assert.equal((await require('pdf-lib').PDFDocument.load(buffer)).getPageCount(), 1);
});
