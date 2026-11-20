'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(id) {
    return { id, value: '', checked: false, innerText: '', innerHTML: '', classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, replaceChildren() {} };
}

function createSandbox(sessionsByUser, respond) {
    const elements = new Map(['user-record-session-select', 'user-record-include-deleted', 'user-record-refresh-btn', 'user-records-title',
        'user-records-modal', 'user-records-body', 'pagination-userRecords'].map(id => [id, element(id)]));
    const requests = [];
    const select = elements.get('user-record-session-select');
    const sandbox = {
        console,
        URLSearchParams,
        document: { getElementById: id => elements.get(id) || null, querySelector: () => null, addEventListener() {} },
        window: { Pivot: { legacy: {} } },
        PivotSafeHtml: { setHtml(target, html) { target.innerHTML = html; target.options = [...html.matchAll(/value="([^"]*)"/g)].map(match => match[1]); } },
        pageState: { limit: 15 },
        API_BASE: '/api',
        authHeaders: () => ({}),
        escapeHtml: value => String(value ?? ''),
        showToast() {},
        renderTableMessage() {},
        renderPagination() {},
        formatDateToCN: value => String(value),
        formatTokenCount: value => String(value),
        isSuperAdminUser: () => true,
        requestAnimationFrame: callback => callback(),
        setTimeout: () => 0,
        apiFetch: async url => {
            requests.push(url);
            const pending = respond?.(url);
            if (pending) return await pending;
            const sessionMatch = /admin\/users\/(\d+)\/sessions/.exec(url);
            if (sessionMatch) return { ok: true, json: async () => ({ data: sessionsByUser[sessionMatch[1]] || [] }) };
            return { ok: true, json: async () => ({ data: [], total: 0 }) };
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/chat/users.js'), 'utf8'), sandbox);
    return { legacy: sandbox.window.Pivot.legacy, sandbox, requests, select, body: elements.get('user-records-body') };
}

test('管理员重新打开用户记录弹窗时默认显示全部会话，不沿用上次选择的会话', async () => {
    const { legacy, requests, select } = createSandbox({ 1: [{ id: 's1', title: 'Python五子棋代码', msg_count: 4 }, { id: 's2', title: '新对话', msg_count: 5 }] });

    await legacy.openUserRecords({ id: 1, username: 'test', nickname: '测试用户' });
    // 模拟管理员在上一次查看中选中了某个具体会话。
    select.value = 's1';
    legacy.closeUserRecordsModal();
    assert.equal(select.value, '');

    requests.length = 0;
    await legacy.openUserRecords({ id: 1, username: 'test', nickname: '测试用户' });
    assert.equal(select.value, '');
    const messageRequest = requests.find(url => url.includes('/messages'));
    assert.ok(messageRequest, '应请求消息列表');
    assert.ok(!messageRequest.includes('sessionId='), '默认请求不应携带会话筛选');
});

test('切换用户时立即请求新用户的全部会话，迟到响应不能回填旧记录', async () => {
    const old = {};
    const response = data => ({ ok: true, json: async () => ({ data, total: data.length }) });
    const { legacy, requests, select, body } = createSandbox({ 2: [{ id: 'new', title: '新用户会话' }] }, url => {
        const stale = /\/users\/1\/(sessions|messages)\?/.exec(url);
        if (stale) return new Promise(resolve => { old[stale[1]] = resolve; });
        if (url.includes('/users/2/messages')) return response([{ user_content: '新用户的记录' }]);
    });
    const first = legacy.openUserRecords({ id: 1, username: 'first' });
    select.value = 'old';
    await legacy.openUserRecords({ id: 2, username: 'second' });
    assert.equal(select.value, '');
    assert.match(requests.find(url => url.includes('/users/2/messages')), /\?includeDeleted=true&page=1&limit=15$/);

    old.sessions(response([{ id: 'old', title: '旧用户会话' }]));
    old.messages(response([{ user_content: '旧用户的记录' }]));
    await first;
    assert.doesNotMatch(select.innerHTML, /旧用户会话/);
    assert.match(select.innerHTML, /新用户会话/);
    assert.doesNotMatch(body.innerHTML, /旧用户的记录/);
    assert.match(body.innerHTML, /新用户的记录/);
});

test('弹窗内刷新会话选项保留明确选中的会话', async () => {
    const { legacy, select, requests } = createSandbox({ 1: [{ id: 's1', title: '会话一' }] });
    await legacy.openUserRecords({ id: 1, username: 'test' });
    select.value = 's1';
    await legacy.loadUserRecordSessions();
    await legacy.loadUserRecordMessages(2);
    assert.equal(select.value, 's1');
    assert.match(requests.at(-1), /page=2&limit=15&sessionId=s1$/);
});

test('非超级管理员打开用户记录时不发出查询', async () => {
    const { legacy, requests, sandbox } = createSandbox({});
    sandbox.isSuperAdminUser = () => false;
    await legacy.openUserRecords({ id: 1, username: 'test' });
    assert.deepEqual(requests, []);
});
