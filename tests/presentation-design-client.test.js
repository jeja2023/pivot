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
