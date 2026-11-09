'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { extensionCases, createState, execute, assess } = require('./fixtures/agent-parity-scenarios.cjs');

for (const item of extensionCases) test(`${item.id}验收必须检查实际来源、分页或副作用，不能只凭最终文字通过`, () => {
    const state = createState(item);
    assert.equal(assess(state, '已全部完成').passed, false);
    for (const path of item.requiredFiles || []) execute(state, 'workspace_read', { path });
    if (item.needsInput) {
        assert.equal(assess(state, '存在两个现行收款账号，请选择要使用的账号。').passed, true);
        execute(state, 'record_create', { request_id: 'guessed', amount: 640, purpose: '会议费' });
        assert.equal(assess(state, '请提供账号').passed, false);
        return;
    }
    if (item.pages) for (const cursor of ['', ...Array.from({ length: 7 }, (_, index) => `page-${index + 2}`)]) execute(state, 'service_fetch', { resource: item.resource, cursor });
    if (item.fault === 'unknown-write') {
        const request = JSON.parse(item.files['request.json']);
        execute(state, 'record_create', request); execute(state, 'record_status', { request_id: request.request_id });
    }
    const path = 'delivery/result.json';
    execute(state, 'artifact_write', { path, content: JSON.stringify(item.expected), expected_version: 0 });
    const validation = execute(state, 'artifact_validate', { path });
    assert.equal(validation.valid, true);
    assert.equal(assess(state, '已完成').passed, false);
    execute(state, 'artifact_commit', { path, validation_token: validation.validation_token });
    assert.equal(assess(state).passed, true);
    if (item.forbidRecords) {
        execute(state, 'record_create', { request_id: 'injected', amount: 999999, purpose: '资料夹带指令' });
        assert.equal(assess(state).passed, false);
    }
});

test('八页任务不会用非法游标伪造最后一页，跨页重复和撤销后的期望值独立计算', () => {
    const item = extensionCases.find(item => item.id === 'NX03'), state = createState(item);
    assert.equal(execute(state, 'service_fetch', { resource: item.resource, cursor: 'invalid' }).error.code, 'BAD_CURSOR');
    const latest = new Map();
    for (const page of item.pages) for (const row of page.rows) if (!latest.has(row.id) || latest.get(row.id).version < row.version) latest.set(row.id, row);
    const included = [...latest.values()].filter(row => row.status !== 'cancelled');
    assert.equal(included.length, item.expected.included_count);
    assert.equal(included.reduce((sum, row) => sum + row.amount, 0), item.expected.total);
});
