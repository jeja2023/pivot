'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    applyControlMessagesToWorkingState,
    buildWorkingStatePrompt,
    createTaskWorkingState,
    recordWorkingObservation
} = require('../server/services/agent-working-state');

test('working state preserves task constraints and deduplicates applied control messages', () => {
    const initial = createTaskWorkingState({ constraints: ['只用已授权资料'], deliverables: [{ kind: 'docx' }] }, '生成周报');
    const updated = applyControlMessagesToWorkingState(initial, [{ message_id: 'm1', message_type: 'steer', payload: { instruction: '不要发送，先预览' } }]);
    const repeated = applyControlMessagesToWorkingState(updated, [{ message_id: 'm1', message_type: 'steer', payload: { instruction: '不要发送，先预览' } }]);
    assert.equal(updated.constraints.some(item => item.text === '不要发送，先预览'), true);
    assert.equal(repeated.constraints.filter(item => item.text === '不要发送，先预览').length, 1);
    assert.match(buildWorkingStatePrompt(repeated), /只用已授权资料/);
});

test('working state records bounded observations as evidence', () => {
    const state = recordWorkingObservation({}, { tool: 'rag.search', output: { text: '找到三条资料' } }, {}, '检索资料');
    assert.equal(state.evidence[0].source, 'rag.search');
    assert.match(state.evidence[0].text, /找到三条资料/);
});
