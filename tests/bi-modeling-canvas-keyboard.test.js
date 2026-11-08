'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function canvas({ owner = true, lifecycle = 'draft', layout = { x: 194, y: 287 } } = {}) {
    const handlers = {}, node = { id: 'fact', role: 'fact', name: '订单', grainKeys: ['order'] };
    const element = { dataset: { modelingGraphNode: 'fact' }, focus() {} };
    const svg = { querySelectorAll() { return [element]; } };
    const state = { selected: { isOwner: owner, lifecycle }, draft: { nodes: [node], relations: [] }, canvasLayout: layout ? { fact: { ...layout } } : {} };
    let changes = 0;
    const modeling = { state, columns: () => [], changed() { changes++; }, render() {}, capture: () => () => true };
    const context = { window: { Pivot: { legacy: { PivotDataAnalysis: { modeling, esc: String, state: { datasets: [] }, toast() {} } } }, addEventListener() {} }, document: { getElementById() { return svg; } }, MouseEvent: function () {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../client/chat/data-analysis/modeling-canvas.js'), 'utf8'), context);
    modeling.bindCanvas({ addEventListener(name, handler) { (handlers[name] ||= []).push(handler); } });
    return { state, changes: () => changes, press(key) {
        const event = { key, target: { closest(selector) { return selector === '[data-modeling-graph-node]' ? element : null; } }, preventDefault() {} };
        for (const handler of handlers.keydown) handler(event);
    } };
}

test('方向键移动已保存布局与默认布局，始终只修改独立位置而不改写模型语义', () => {
    for (const initial of [{ x: 194, y: 287 }, null]) {
        const view = canvas({ layout: initial }), before = JSON.stringify(view.state.draft), origin = initial || { x: 35, y: 35 };
        for (const [key, x, y] of [['ArrowRight', 10, 0], ['ArrowDown', 10, 10], ['ArrowLeft', 0, 10], ['ArrowUp', 0, 0]]) {
            view.press(key);
            assert.equal(view.state.canvasLayout.fact.x, origin.x + x);
            assert.equal(view.state.canvasLayout.fact.y, origin.y + y);
            assert.equal(JSON.stringify(view.state.draft), before);
        }
        assert.equal(view.changes(), 4);
    }
});

test('方向键遵守画布位置上下限，归档与共享只读模型不能修改位置或语义', () => {
    const low = canvas({ layout: { x: 20, y: 20 } }); low.press('ArrowLeft'); low.press('ArrowUp');
    assert.equal(low.state.canvasLayout.fact.x, 20); assert.equal(low.state.canvasLayout.fact.y, 20);
    const high = canvas({ layout: { x: 6000, y: 6000 } }); high.press('ArrowRight'); high.press('ArrowDown');
    assert.equal(high.state.canvasLayout.fact.x, 6000); assert.equal(high.state.canvasLayout.fact.y, 6000);
    for (const options of [{ owner: false }, { lifecycle: 'archived' }]) {
        const view = canvas(options), before = JSON.stringify(view.state);
        view.press('ArrowRight'); view.press('ArrowDown');
        assert.equal(JSON.stringify(view.state), before); assert.equal(view.changes(), 0);
    }
});
