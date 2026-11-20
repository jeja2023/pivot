'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function moduleUnderTest() {
    let api;
    vm.runInNewContext(fs.readFileSync('client/chat/apps-workbench-presentation-design.js', 'utf8'), {
        document: { getElementById: () => ({ setAttribute() {}, removeAttribute() {} }) },
        window: { Pivot: { moduleApi: () => null, exposeModule: (_name, value) => { api = value; } } }
    });
    return api;
}

test('视觉复核明确单页与未复核状态，内容或版本变化后不沿用通过提示', () => {
    const api = moduleUnderTest();
    const state = { editRevision: 4, active: { version: 2, validation: { visualReview: { status: 'passed', message: '第3页已通过', localRevision: 4, localVersion: 2 } } } };
    assert.equal(api.reviewMessage(state), '第3页已通过');
    state.editRevision++;
    assert.match(api.reviewMessage(state), /文稿已变化/);
    state.editRevision = 4; state.active.version = 3;
    assert.match(api.reviewMessage(state), /重新复核/);
    state.active.validation = {};
    assert.match(api.reviewMessage(state), /尚未/);
});

test('迟到的视觉检查响应不会覆盖已切换的文稿，模型不可用保留明确状态', async () => {
    const api = moduleUnderTest();
    const state = { editRevision: 0, active: { id: 'first', version: 1, validation: { issues: [] } }, selectedSlideId: 's1' };
    let resolve, rendered = false;
    const helpers = {
        requirePresentationAiModel: () => 'model', beginAiRequest: () => ({}), endAiRequest() {}, saveActive: async () => {},
        activeContent: () => ({ slides: [{ id: 's1' }] }), aiJsonOptions: value => value,
        requestJson: () => new Promise(done => { resolve = done; }), switchPanel() {}, renderIssues: () => { rendered = true; }, toast() {}, isAiAbort: () => false
    };
    const pending = api.runVisualReview(state, helpers);
    state.active = { id: 'second', version: 1, validation: { issues: [] } };
    resolve({ review: { status: 'passed', message: '已通过', issues: [], slideId: 's1' } });
    await pending;
    assert.equal(rendered, false); assert.equal(state.active.validation.visualReview, undefined);
    helpers.requestJson = async () => ({ review: { status: 'unavailable', message: '尚未进行视觉复核：模型不可用', issues: [], slideId: 's1' } });
    await api.runVisualReview(state, helpers);
    assert.equal(state.active.validation.visualReview.status, 'unavailable');
    assert.match(api.reviewMessage(state), /模型不可用/);
});

test('同一大纲重试沿用草稿，修改大纲使用新草稿标识', async () => {
    let api;
    const button = { classList: { add() {} } };
    vm.runInNewContext(fs.readFileSync('client/chat/apps-workbench-presentations-generation.js', 'utf8'), {
        document: { getElementById: () => button },
        window: { Pivot: { exposeModule: (_name, value) => { api = value; } } },
        crypto: require('node:crypto').webcrypto
    });
    const state = { pendingCreate: { topic: '项目报告' } }, submitted = [], opened = [], notices = [];
    let conflict = false;
    const { generateSlides } = api.create(state, {
        requestJson: async (url, options) => {
            assert.match(url, /\/ai\/slides$/);
            const { body, controller } = options;
            submitted.push(body.draftId);
            if (conflict) throw Object.assign(new Error('旧草稿对应另一份大纲'), { code: 'PRESENTATION_GENERATION_PLAN_CHANGED' });
            controller.abort();
            throw controller.signal.reason;
        },
        beginAiRequest: () => new AbortController(), endAiRequest() {}, aiJsonOptions: (body, controller) => ({ body, controller }),
        isAiAbort: (_error, controller) => controller.signal.aborted, openPresentation: id => opened.push(id),
        toast: message => notices.push(message),
    });
    const original = { title: '项目报告', slides: [{ title: '概况' }] };
    const modified = { ...original, slides: [{ title: '调整后的概况' }] };
    await generateSlides(original);
    await generateSlides(original);
    await generateSlides(modified);
    assert.equal(submitted[0], submitted[1]);
    assert.notEqual(submitted[1], submitted[2]);
    conflict = true;
    await generateSlides(modified);
    assert.equal(state.pendingCreate.draftId, undefined);
    assert.match(notices.at(-1), /再次点击“生成页面”/);
    assert.deepEqual(opened, []);
});

test('改写确认期间有新编辑时保留当前页，只有未变更的页面可接受建议', async () => {
    let api, editBeforeConfirm = true, applied = 0;
    const state = { activeEpoch: 1, active: { id: 'doc', content: { title: '报告', slides: [{ id: 's1', text: '原文' }] } } };
    vm.runInNewContext(fs.readFileSync('client/chat/apps-workbench-presentations-generation.js', 'utf8'), {
        document: { getElementById: () => ({ value: '整理要点' }) },
        window: { Pivot: { exposeModule: (_name, value) => { api = value; }, legacy: { showConfirm: async () => {
            if (editBeforeConfirm) state.active.content.slides[0].text = '用户刚修改';
            return true;
        } } } }
    });
    const { rewriteCurrentSlide } = api.create(state, {
        beginAiRequest: () => new AbortController(), endAiRequest() {}, aiJsonOptions: body => body,
        activeSlide: () => state.active.content.slides[0], canEdit: () => true, flush: async () => true, requireModel: () => '1',
        requestJson: async (_url, body) => {
            assert.equal(body.slide.id, 's1');
            return { proposal: { presentation: { slides: [{ id: 'proposal', text: '模型建议' }] } } };
        },
        isAiAbort: () => false, formatChangeImpact: () => '', recordHistory: () => { applied++; }, renderEditor() {}, toast() {}
    });
    await rewriteCurrentSlide();
    assert.equal(state.active.content.slides[0].text, '用户刚修改');
    assert.equal(applied, 0);
    editBeforeConfirm = false;
    await rewriteCurrentSlide();
    assert.equal(state.active.content.slides[0].text, '模型建议');
    assert.equal(state.active.content.slides[0].id, 's1');
    assert.equal(applied, 1);
});
