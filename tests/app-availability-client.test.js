const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createHarness(fetchCatalog) {
    const modules = {};
    const clicks = [];
    const toasts = [];
    const state = { active: '', returnedHome: 0 };
    const window = { Pivot: {
        legacy: { currentUser: { id: 1 } },
        exposeModule(name, api) { modules[name] = api; }
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/apps-workbench-availability.js'), 'utf8'), {
        window,
        document: {
            hidden: false,
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            addEventListener(_type, callback) { clicks.push(callback); }
        },
        API_BASE: '/api', apiFetch: fetchCatalog, setInterval() {}, renderAppsGrid() {},
        getStoredAppsActiveApp: () => state.active,
        showAppsHome() { state.active = ''; state.returnedHome += 1; },
        showToast(message) { toasts.push(message); }
    });
    return { api: modules['apps.availability'], window, clicks, state, toasts };
}

const response = (apps, canManage = false) => ({ ok: true, json: async () => ({ apps, canManage }) });

test('应用目录的迟到响应不能恢复上一账号的卡片和管理权限', async () => {
    const requests = [];
    const harness = createHarness(() => new Promise(resolve => requests.push(resolve)));
    const oldRequest = harness.api.refresh();
    harness.window.Pivot.legacy.currentUser = { id: 2 };
    const newRequest = harness.api.refresh();
    requests[1](response([]));
    assert.equal(await newRequest, true);
    requests[0](response([{ id: 'ocr', enabled: false }], true));
    assert.equal(await oldRequest, false);
    assert.equal(harness.api.visibleApps([{ id: 'ocr' }]).length, 0);
    const count = requests.length;
    harness.clicks[0]({ target: { closest: () => ({ dataset: { appToggle: 'ocr' } }) } });
    assert.equal(requests.length, count);
});

test('目录请求失败时隐藏旧卡片，禁止打开，成功重试后恢复', async () => {
    let failing = false;
    const harness = createHarness(async () => {
        if (failing) throw new Error('网络不可用');
        return response([{ id: 'ocr', enabled: true }]);
    });
    await harness.api.refresh();
    assert.equal(harness.api.isEnabled('ocr'), true);
    failing = true;
    assert.equal(await harness.api.refresh(), false);
    assert.equal(harness.api.isEnabled('ocr'), false);
    await assert.rejects(harness.api.ensureEnabled('ocr'), /无法确认应用状态/);
    failing = false;
    assert.equal(await harness.api.refresh(), true);
    await harness.api.ensureEnabled('ocr');
});

test('应用关闭后同步退出正在显示的应用，保留全局开关的读取结果', async () => {
    const harness = createHarness(async () => response([], true));
    harness.state.active = 'ocr';
    assert.equal(await harness.api.refresh(), true);
    assert.equal(harness.state.returnedHome, 1);
    assert.equal(harness.state.active, '');
    assert.equal(harness.api.isEnabled('ocr'), false);
    assert.match(harness.toasts[0], /已关闭/);
});
