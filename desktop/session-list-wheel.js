'use strict';

const MAX_VIEWPORT_COORDINATE = 100000;

function finiteCoordinate(value) {
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= MAX_VIEWPORT_COORDINATE ? number : null;
}

function normalizeSessionListViewport(value = {}) {
    const left = finiteCoordinate(value.left);
    const top = finiteCoordinate(value.top);
    const right = finiteCoordinate(value.right);
    const bottom = finiteCoordinate(value.bottom);
    const validBounds = left !== null && top !== null && right !== null && bottom !== null
        && right > left && bottom > top;

    return {
        active: value.active === true && validBounds,
        scrollable: value.scrollable === true,
        modalOpen: value.modalOpen === true,
        pointerInside: value.pointerInside === true,
        left: validBounds ? left : 0,
        top: validBounds ? top : 0,
        right: validBounds ? right : 0,
        bottom: validBounds ? bottom : 0
    };
}

function hasVerticalWheelDelta(input = {}) {
    const deltaY = Number(input.deltaY);
    return Number.isFinite(deltaY) && deltaY !== 0;
}

function shouldForwardSessionListWheel(input = {}, viewport = {}) {
    const state = normalizeSessionListViewport(viewport);
    if (input.type !== 'mouseWheel' || !state.active || !state.scrollable || state.modalOpen) return false;
    if (!hasVerticalWheelDelta(input)) return false;

    const modifiers = Array.isArray(input.modifiers) ? input.modifiers : [];
    if (modifiers.includes('control') || modifiers.includes('ctrl') || modifiers.includes('meta') || modifiers.includes('command')) {
        return false;
    }

    const x = finiteCoordinate(input.x);
    const y = finiteCoordinate(input.y);
    if (x === null || y === null) return false;

    // Windows 显示缩放、无边框窗口与合成层切换时，主进程得到的 wheel 坐标
    // 可能与渲染进程的 CSS 像素不一致。渲染进程已经通过 pointerenter 明确
    // 确认光标位于会话列表时，优先信任该状态；坐标命中仍作为无 hover 状态下的兜底。
    return state.pointerInside || (x >= state.left && x <= state.right && y >= state.top && y <= state.bottom);
}

module.exports = {
    normalizeSessionListViewport,
    shouldForwardSessionListWheel
};
