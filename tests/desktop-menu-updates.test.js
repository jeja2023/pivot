'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const updateErrors = require('../client/common/desktop-update-errors');

const source = fs.readFileSync(path.join(__dirname, '../client/chat/desktop-menu.js'), 'utf8');

function createMenuHarness({ initialState, checkResult } = {}) {
    function element() {
        const classes = new Set();
        const listeners = new Map();
        return {
            children: [], dataset: {}, style: {},
            classList: {
                add: (...names) => names.forEach(name => classes.add(name)),
                remove: (...names) => names.forEach(name => classes.delete(name)),
                contains: name => classes.has(name)
            },
            addEventListener: (name, callback) => listeners.set(name, callback),
            dispatch: (name, event) => listeners.get(name)?.(event),
            appendChild(child) { this.children.push(child); },
            replaceChildren() { this.children = []; },
            setAttribute() {},
            getBoundingClientRect: () => ({ left: 8, bottom: 40 })
        };
    }
    const toasts = [];
    const menu = element();
    const brand = element();
    const body = element();
    menu.querySelector = () => brand;
    brand.dataset.desktopMenu = 'pivot';
    let updateListener;
    let installs = 0;
    const desktopApi = {
        onUpdateEvent(callback) { updateListener = callback; },
        async installUpdate() { installs += 1; },
        async checkForUpdates() { return checkResult; }
    };
    if (initialState) desktopApi.getUpdateStatus = () => initialState;
    vm.runInNewContext(source, {
        window: { pivotDesktop: desktopApi, Pivot: { module: () => updateErrors }, innerWidth: 1280, innerHeight: 800, addEventListener() {} },
        document: { documentElement: element(), body, getElementById: () => menu, createElement: element, addEventListener() {} },
        showToast: (message, type) => toasts.push({ message, type }),
        console
    });
    const click = target => ({ target: { closest: () => target }, preventDefault() {}, stopPropagation() {} });
    return {
        toasts, brand,
        emit: state => updateListener({ enabled: true, updateInfo: { version: '0.7.148' }, ...state }),
        updateAction() {
            menu.dispatch('click', click(brand));
            const popover = body.children[0];
            const action = popover.children.find(child => child.dataset.desktopAction === 'check-updates');
            return { popover, action };
        },
        installFromMenu() {
            const { popover, action } = this.updateAction();
            assert.equal(action.children[0].textContent, '重启并安装更新');
            popover.dispatch('click', click(action));
        },
        installed: () => installs
    };
}

test('桌面更新的下载完成通知不被同版本下载通知去重，且仍可从菜单安装', async () => {
    const menu = createMenuHarness();
    menu.emit({ status: 'available' });
    menu.emit({ status: 'downloading', progress: { percent: 100 } });
    menu.emit({ status: 'downloaded' });
    menu.emit({ status: 'downloaded' });
    assert.equal(menu.toasts.filter(item => item.message.includes('正在后台下载')).length, 1);
    assert.equal(menu.toasts.filter(item => item.message.includes('已下载完毕')).length, 1);
    assert.equal(menu.brand.classList.contains('is-ready'), true);
    menu.installFromMenu();
    await Promise.resolve();
    assert.equal(menu.installed(), 1);
});

test('重新加载服务端页面后提示旧客户端中已经下载完成的更新', async () => {
    const menu = createMenuHarness({ initialState: Promise.resolve({ enabled: true, status: 'downloaded', updateInfo: { version: '0.7.148' } }) });
    await Promise.resolve();
    assert.equal(menu.toasts.filter(item => item.message.includes('已下载完毕')).length, 1);
    assert.equal(menu.brand.classList.contains('is-ready'), true);
});

test('迟到的初始更新状态不能覆盖新的错误事件或误报安装就绪', async () => {
    let resolveInitial;
    const menu = createMenuHarness({ initialState: new Promise(resolve => { resolveInitial = resolve; }) });
    menu.emit({ status: 'error', error: '更新包签名校验失败' });
    resolveInitial({ enabled: true, status: 'downloaded', updateInfo: { version: '0.7.148' } });
    await Promise.resolve();
    assert.equal(menu.toasts.filter(item => item.message.includes('已下载完毕')).length, 0);
    assert.equal(menu.toasts.some(item => item.message.includes('签名校验未通过')), true);
    assert.equal(menu.brand.classList.contains('is-ready'), false);
});

test('下载到百分之百仍显示正在校验，只有下载完成事件才提供安装入口', () => {
    const menu = createMenuHarness();
    menu.emit({ status: 'downloading', progress: { percent: 100 } });
    const { action } = menu.updateAction();
    assert.equal(action.children[0].textContent, '正在校验更新...');
    assert.equal(action.children[1].textContent, '校验中');
    assert.equal(menu.brand.classList.contains('is-ready'), false);
    assert.equal(menu.installed(), 0);
});

test('旧客户端的更新源 404 原始错误仅显示一次短提示，不展示请求头或堆栈', async () => {
    const error = 'Cannot find channel "latest.yml" update info: HttpError: 404 Not Found\nmethod: GET url: http://private-updates.test/downloads/latest.yml\nHeaders: secret-header\nat createHttpError (C:\\Users\\private-user\\app.asar)';
    const state = { enabled: true, status: 'error', error, updateInfo: { version: '0.7.155' } };
    const menu = createMenuHarness({ checkResult: state });
    menu.emit(state);
    menu.emit(state);
    const { action, popover } = menu.updateAction();
    popover.dispatch('click', { target: { closest: () => action }, preventDefault() {}, stopPropagation() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(menu.toasts.length, 1);
    assert.match(menu.toasts[0].message, /latest\.yml.*HTTP 404/);
    assert.ok(menu.toasts[0].message.length < 120);
    assert.doesNotMatch(menu.toasts[0].message, /secret-header|private-user|private-updates|createHttpError|Headers:/);
    menu.emit({ status: 'checking' });
    menu.emit(state);
    assert.equal(menu.toasts.length, 2);
});
