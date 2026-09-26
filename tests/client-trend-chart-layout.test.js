const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('趋势图保留数据并在布局、缩放变化后重绘', () => {
    const source = read('client/chat/stats.js');

    assert.match(source, /const trendChartStates = new Map\(\)/);
    assert.match(source, /new window\.ResizeObserver/);
    assert.match(source, /state\.data = Array\.isArray\(data\) \? data : \[\]/);
    assert.match(source, /canvas\.style\.visibility = 'hidden'/);
    assert.match(source, /canvas\.style\.visibility = 'visible'/);
    assert.match(source, /pivot:settings-workspace-scale-applied/);
    assert.match(source, /buildTrendChartLabelIndexes\(values\.length, chartW, 76\)/);
});

test('设置画布缩放完成会通知依赖实际尺寸的图表', () => {
    const source = read('client/chat/workspace-settings-scale.js');

    assert.match(source, /function notifySettingsWorkspaceScaleApplied/);
    assert.match(source, /new window\.CustomEvent\('pivot:settings-workspace-scale-applied'/);
    assert.match(source, /notifySettingsWorkspaceScaleApplied\(\{ layoutWidth, scale, stageWidth, stageHeight: scaledHeight \}\)/);
});

test('趋势图首帧宽度为零时会在容器完成布局后重绘', () => {
    const frames = new Map();
    const parent = { clientWidth: 0 };
    let nextFrame = 0;
    let resizeCallback = null;
    const canvas = {
        parentElement: parent,
        style: {},
        getAttribute(name) { return name === 'height' ? '260' : null; },
        getContext() {
            return {
                setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fill() {}, arc() {}, fillRect() {},
                measureText() { return { width: 12 }; }, fillText() {},
                set strokeStyle(_value) {}, set lineWidth(_value) {}, set fillStyle(_value) {}, set font(_value) {}, set textAlign(_value) {}, set textBaseline(_value) {}
            };
        }
    };
    const window = {
        devicePixelRatio: 1,
        Pivot: { legacy: {} },
        requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        addEventListener() {},
        ResizeObserver: class { constructor(callback) { resizeCallback = callback; } observe() {} disconnect() {} }
    };
    const context = {
        window,
        document: {
            getElementById(id) { return id === 'usage-trend-chart' ? canvas : null; },
            addEventListener() {}
        },
        formatTokenCount: String,
        Map,
        Set,
        Math,
        Number,
        String,
        Array
    };
    vm.runInNewContext(`${read('client/chat/stats.js')}\nwindow.__trendChart = { renderTrendChart };`, context);
    const flushFrames = () => {
        while (frames.size) {
            const callbacks = [...frames.values()];
            frames.clear();
            callbacks.forEach(callback => callback());
        }
    };

    window.__trendChart.renderTrendChart('usage-trend-chart', [{ day: '2026-09-01', tokens: 12 }]);
    flushFrames();
    assert.equal(canvas.width, undefined);
    assert.equal(canvas.style.visibility, 'hidden');

    parent.clientWidth = 840;
    resizeCallback([{ contentRect: { width: 840 } }]);
    flushFrames();
    assert.equal(canvas.width, 840);
});
