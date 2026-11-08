'use strict';

const { canonicalJson } = require('./canonical');
const { biError } = require('./errors');

function normalizeCanvasLayout(value, definition) {
    if (value === undefined) return undefined;
    canonicalJson(value);
    const nodes = new Set(definition.nodes.map(node => node.id));
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length > 9) throw biError('ANALYSIS_MODEL_LAYOUT_INVALID', '关系图布局格式无效，请重新打开模型后重试。');
    const result = Object.create(null);
    for (const [nodeId, position] of Object.entries(value)) {
        if (!nodes.has(nodeId) || !position || Array.isArray(position) || typeof position !== 'object' || Object.keys(position).sort().join(',') !== 'x,y' || ![position.x, position.y].every(value => Number.isFinite(value) && Math.abs(value) <= 100000)) {
            throw biError('ANALYSIS_MODEL_LAYOUT_INVALID', '关系图布局只能包含当前模型节点及有效坐标，请重新调整布局。');
        }
        result[nodeId] = { x: position.x, y: position.y };
    }
    return result;
}

module.exports = { normalizeCanvasLayout };
