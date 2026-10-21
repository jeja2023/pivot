'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    let api;
    const context = vm.createContext({ window: { Pivot: { exposeModule(_name, value) { api = value; } } } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/chat-task-state.js'), 'utf8'), context);
    return api;
}

function feed(status, seq, events = [], extra = {}) {
    return { run: { id: 'run', session_id: 'session', status, updated_at: '2026-10-20T08:00:00+08:00' },
        cursor: { eventSeq: seq }, nextAfter: seq, events, ...extra };
}

test('开始、完成和乱序历史合并到同一操作，重复事件不增加记录或倒退状态', () => {
    const api = harness();
    const state = api.create('run', 'session');
    const event = (seq, status) => ({ id: `event:${seq}`, seq, kind: 'tool', operationId: 'one', status, at: `2026-10-20T08:00:0${seq}+08:00` });
    api.applyFeed(state, feed('running', 3, [event(2, 'running'), event(3, 'completed')]));
    api.applyFeed(state, feed('running', 3, [event(2, 'running'), event(3, 'completed')]));
    api.applyFeed(state, feed('running', 3, [event(1, 'preparing')]), { history: true });
    assert.equal(api.records(state).length, 1);
    assert.equal(api.records(state)[0].status, 'completed');
    assert.equal(api.records(state)[0].firstSeq, 1);
    assert.equal(api.applyFeed(state, feed('planning', 1)), false);
    api.applyFeed(state, feed('completed', 5));
    api.applyFeed(state, feed('running', 5, [event(1, 'preparing')]), { history: true });
    assert.equal(state.run.status, 'completed');
});

test('审批、等待提交和终态不会被模型流覆盖，模型输出结束不等于执行成功', () => {
    const api = harness();
    for (const status of ['approval_required', 'needs_input', 'awaiting_commit', 'completed', 'cancelled']) {
        const state = api.create('run', 'session');
        api.applyFeed(state, feed(status, 3));
        assert.equal(api.applyStreaming(state, { completed: true, partialToolCalls: [{ name: 'write' }] }), false);
        assert.equal(state.run.status, status);
    }
    const running = api.create('run', 'session');
    api.applyFeed(running, feed('running', 1));
    assert.equal(api.applyStreaming(running, { completed: true, partialToolCalls: [{ name: 'write' }] }), true);
    assert.equal(running.run.status, 'running');
    assert.doesNotMatch(api.summary(running), /完成/);
});

test('断线保留已确认状态，跨会话数据无效，未返回操作结果不会被标记完成', () => {
    const api = harness();
    const state = api.create('run', 'session');
    api.applyFeed(state, feed('running', 2, [{ id: 'e', seq: 2, kind: 'tool', operationId: 'op', status: 'running' }]));
    state.connection = 'unavailable';
    assert.match(api.summary(state), /无法确认/);
    assert.equal(state.run.status, 'running');
    assert.equal(api.applyFeed(state, { ...feed('completed', 3), run: { id: 'run', session_id: 'other' } }), false);
    api.applyFeed(state, feed('cancelled', 4));
    assert.equal(api.records(state)[0].status, 'uncertain');
});
