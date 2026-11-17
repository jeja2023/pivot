'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('迟到的评论响应不会覆盖新文稿或更新的评论结果', async () => {
    const badge = { textContent: '', classList: { toggle() {} } };
    const pending = [];
    let api;
    const response = comments => ({ ok: true, clone() { return { json: async () => ({ comments }) }; } });
    const sandbox = {
        document: { getElementById: id => id === 'presentation-comments-badge' ? badge : null },
        apiFetch: async (url, options = {}) => {
            if (options.method === 'DELETE') return response([]);
            if (!url.endsWith('/comments')) return response([]);
            return await new Promise(resolve => pending.push({ url, resolve }));
        },
        clearInterval() {}, console,
        window: { addEventListener() {}, setInterval() { return 1; }, Pivot: {
            moduleApi: () => ({ isVisible: () => false }), exposeModule: (_name, value) => { api = value; }
        } }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/apps-workbench-presentations-collab.js'), 'utf8'), sandbox);
    api.startPresenceHeartbeat('first');
    const old = api.loadComments('first');
    api.startPresenceHeartbeat('second');
    const current = api.loadComments('second');
    pending[1].resolve(response([{ status: 'open' }]));
    await current;
    pending[0].resolve(response(Array.from({ length: 9 }, () => ({ status: 'open' }))));
    await old;
    assert.equal(badge.textContent, '1');
    const older = api.loadComments('second');
    const newer = api.loadComments('second');
    pending[3].resolve(response([{ status: 'open' }, { status: 'open' }]));
    await newer;
    pending[2].resolve(response([{ status: 'open' }]));
    await older;
    assert.equal(badge.textContent, '2');
    api.stopPresenceHeartbeat();
});

test('旧文稿迟到的撤权和更新响应不会改变当前文稿', async () => {
    let api;
    const sandbox = { window: { Pivot: { exposeModule: (_name, value) => { api = value; } } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/apps-workbench-presentations-realtime.js'), 'utf8'), sandbox);
    const old = { id: 'one' };
    let active = old;
    let rejectOld;
    let revoked = 0;
    const pending = api.fetchCurrent({ active: old, getActive: () => active,
        request: () => new Promise((_resolve, reject) => { rejectOld = reject; }), onRevoked: () => { revoked += 1; } });
    active = { id: 'two' };
    rejectOld(Object.assign(new Error('已撤权'), { status: 404 }));
    await assert.rejects(pending, /已撤权/);
    assert.equal(revoked, 0);
    const current = active;
    await assert.rejects(api.fetchCurrent({ active: current, getActive: () => active,
        request: async () => { throw Object.assign(new Error('暂时失败'), { status: 500 }); }, onRevoked: () => { revoked += 1; } }), /暂时失败/);
    assert.equal(revoked, 0);
    await assert.rejects(api.fetchCurrent({ active: current, getActive: () => active,
        request: async () => { throw Object.assign(new Error('已撤权'), { status: 403 }); }, onRevoked: () => { revoked += 1; } }), /已撤权/);
    assert.equal(revoked, 1);
    let resolveOld;
    const oldData = api.fetchCurrent({ active: current, getActive: () => active,
        request: () => new Promise(resolve => { resolveOld = resolve; }), onRevoked() {} });
    active = { id: 'three' };
    resolveOld({ presentation: { id: 'two' } });
    assert.equal(await oldData, null);
});

test('分析来源版本变化独立提示，迟到的来源错误不影响新文稿', async () => {
    let api, active = { id: 'report' }, notice = '', revoked = 0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/apps-workbench-presentations-realtime.js'), 'utf8'), {
        window: { Pivot: { exposeModule: (_name, value) => { api = value; } } }
    });
    const original = active;
    const error = Object.assign(new Error('数据已变化，请重新生成汇报。'), { status: 409, code: 'PRESENTATION_ANALYSIS_STALE' });
    const options = { active: original, getActive: () => active, onRevoked: () => { revoked++; }, onSourceUnavailable: value => { notice = value.message; } };
    await assert.rejects(api.fetchCurrent({ ...options, request: async () => { throw error; } }), /数据已变化/);
    assert.match(notice, /重新生成汇报/); assert.equal(revoked, 0);
    active = { id: 'other' }; notice = '';
    await assert.rejects(api.fetchCurrent({ ...options, request: async () => { throw error; } }), /数据已变化/);
    assert.equal(notice, '');
});

test('重载鉴权完成前发起应用直达时等待鉴权，且登录后恢复不再覆盖显式工作区切换', async () => {
    const noop = () => {};
    const modules = new Map();
    let resolveAuth;
    const authGate = new Promise(resolve => { resolveAuth = resolve; });
    const openedCalls = [];
    const sessionStore = new Map([['pivot_main_workspace_view', 'apps']]);
    const body = { attributes: new Map(), setAttribute(k, v) { this.attributes.set(k, v); }, classList: { toggle: noop, add: noop, remove: noop }, dataset: {} };
    const panel = () => ({ classList: { toggle: noop, add: noop, remove: noop }, setAttribute: noop, removeAttribute: noop, contains: () => false, parentElement: null });
    const panels = new Map([['apps-workbench-modal', panel()], ['personal-workbench-modal', panel()]]);
    const sandbox = {
        API_BASE: '/api',
        console,
        Date,
        setInterval: () => 1,
        sessionStorage: { getItem: k => sessionStore.get(k) || '', setItem: (k, v) => sessionStore.set(k, v), removeItem: k => sessionStore.delete(k) },
        document: {
            hidden: false,
            body,
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementById: id => panels.get(id) || null,
            addEventListener: noop,
            dispatchEvent: noop
        },
        apiFetch: async url => {
            assert.equal(url, '/api/apps/catalog');
            return { ok: true, json: async () => ({ canManage: false, apps: [{ id: 'presentations', enabled: true }] }) };
        },
        renderAppsGrid: noop,
        getStoredAppsActiveApp: () => 'presentations',
        showAppsHome: noop,
        showToast: noop,
        escapeAppsHtml: String,
        PivotSafeHtml: { setHtml: noop },
        window: {
            addEventListener: noop,
            matchMedia: () => ({ matches: false }),
            Pivot: {
                legacy: { currentUser: null },
                api: { waitForInitialAuth: () => authGate },
                exposeModule: (name, value) => modules.set(name, value),
                moduleApi: name => modules.get(name) || {},
                loadScripts: async () => {
                    modules.set('workspaces.implementations', {
                        openAppsWorkbench: async (options = {}) => openedCalls.push(options),
                        openPersonalWorkbench: async () => openedCalls.push({ personal: true })
                    });
                }
            }
        }
    };
    sandbox.window.Pivot.moduleApi('workspaces.templateLoader').ensureWorkspaceMarkup = noop;
    modules.set('workspaces.templateLoader', { ensureWorkspaceMarkup: async () => {} });
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/apps-workbench-availability.js'), 'utf8'), sandbox);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/app-workspaces.js'), 'utf8'), sandbox);

    const nav = modules.get('workspaces.navigation');
    const availability = modules.get('apps.availability');
    const explicitOpen = nav.openAppsWorkbench({ app: 'presentations', presentationId: 'pres-123' });
    const refreshPromise = availability.refresh();
    sandbox.window.Pivot.legacy.currentUser = { id: 7 };
    resolveAuth();
    assert.equal(await refreshPromise, true);
    assert.equal(availability.isEnabled('presentations'), true);
    await explicitOpen;
    await sandbox.window.Pivot.legacy.restoreMainWorkspaceAfterLogin();
    assert.deepEqual(openedCalls, [{ app: 'presentations', presentationId: 'pres-123' }]);
});
