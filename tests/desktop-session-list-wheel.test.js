'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    normalizeSessionListViewport,
    shouldForwardSessionListWheel
} = require('../desktop/session-list-wheel');

const viewport = {
    active: true,
    scrollable: true,
    modalOpen: false,
    left: 0,
    top: 30,
    right: 288,
    bottom: 860
};

test('桌面侧栏滚轮桥只接管可滚动侧栏中的垂直 mouseWheel', () => {
    assert.equal(shouldForwardSessionListWheel({ type: 'mouseWheel', x: 120, y: 320, deltaY: 120 }, viewport), true);
    assert.equal(shouldForwardSessionListWheel({ type: 'mouseWheel', x: 400, y: 320, deltaY: 120 }, viewport), false);
    assert.equal(shouldForwardSessionListWheel({ type: 'mouseWheel', x: 120, y: 20, deltaY: 120 }, viewport), false);
    assert.equal(shouldForwardSessionListWheel({ type: 'mouseWheel', x: 120, y: 320, deltaY: 0 }, viewport), false);
});

test('桌面侧栏滚轮桥不会穿透弹窗、不可滚动列表或缩放手势', () => {
    assert.equal(shouldForwardSessionListWheel({ type: 'mouseWheel', x: 120, y: 320, deltaY: 120 }, { ...viewport, modalOpen: true }), false);
    assert.equal(shouldForwardSessionListWheel({ type: 'mouseWheel', x: 120, y: 320, deltaY: 120 }, { ...viewport, scrollable: false }), false);
    assert.equal(shouldForwardSessionListWheel({ type: 'mouseWheel', x: 120, y: 320, deltaY: 120, modifiers: ['control'] }, viewport), false);
});

test('桌面侧栏滚轮桥优先使用渲染器确认的会话列表指针状态', () => {
    const mismatchedCoordinates = { type: 'mouseWheel', x: 900, y: 120, deltaY: 120 };
    assert.equal(shouldForwardSessionListWheel(mismatchedCoordinates, { ...viewport, pointerInside: true }), true);
    assert.equal(shouldForwardSessionListWheel(mismatchedCoordinates, { ...viewport, pointerInside: false }), false);
});

test('桌面侧栏滚轮桥拒绝无效或反转的渲染器坐标', () => {
    assert.deepEqual(normalizeSessionListViewport({ active: true, scrollable: true, left: 20, top: 20, right: 10, bottom: 100 }), {
        active: false,
        scrollable: true,
        modalOpen: false,
        pointerInside: false,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0
    });
});

test('主进程与 preload 共同使用原生 mouseWheel 桥，并保留可拖动滚动条', () => {
    const root = path.resolve(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');
    assert.match(main, /before-mouse-event/);
    assert.match(main, /pivot-desktop:session-list-wheel/);
    assert.match(main, /event\.preventDefault\(\)/);
    assert.match(preload, /pivot-desktop:session-list-viewport/);
    assert.match(preload, /pivot-desktop:session-list-wheel/);
    assert.match(preload, /pointerInside: pointerInsideSessionList/);
    assert.match(preload, /pointerenter/);
    assert.match(preload, /pointerleave/);
    assert.match(preload, /scrollbar-width:\s*thin\s*!important/);
    assert.match(preload, /#session-list::\-webkit-scrollbar[\s\S]*?width:\s*(?:5px|6px|8px|10px)\s*!important/);
});
