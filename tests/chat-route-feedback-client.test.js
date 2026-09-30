'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../client/chat/engine-streaming.js'), 'utf8');

test('路由修正以对话内选择面板提交，不依赖原生 prompt 或用户输入内部动作 ID', () => {
    assert.match(source, /function showRouteFeedbackForm\(/);
    assert.match(source, /chat-route-feedback-form/);
    assert.match(source, /routeFeedbackActionLabel/);
    assert.match(source, /decision-feedback/);
    assert.doesNotMatch(source, /window\.prompt\(`请输入“序号:动作ID”提交路由修正/);
});
