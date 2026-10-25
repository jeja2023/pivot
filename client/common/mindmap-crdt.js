'use strict';
/* global require */
// 以节点及字段为合并单元；树结构在每次接收后重新校验，不能绕过深度、容量与引用约束。
const Y = require('yjs');
const schema = require('./mindmap-document');
const MAX_STATE_BYTES = 16 * 1024 * 1024;
function create() { return new Y.Doc(); }
function maps(doc) { return { meta: doc.getMap('meta'), nodes: doc.getMap('nodes'), relations: doc.getMap('relations'), summaries: doc.getMap('summaries') }; }
function assign(map, key, value) {
    if (value === undefined) { if (map.has(key)) map.delete(key); }
    else if (map.get(key) !== value) map.set(key, value);
}
function reconcile(target, values) {
    for (const key of target.keys()) if (!Object.hasOwn(values, key)) target.delete(key);
    for (const [key, value] of Object.entries(values)) assign(target, key, value);
}
function write(doc, input, origin = 'local') {
    const document = schema.normalize(input); const shared = maps(doc); const nodes = new Map();
    function flatten(node, parent = '', order = 0) {
        const style = document.presentation.nodes[node.id] || {};
        nodes.set(node.id, { text: node.text, parent, order, ...Object.fromEntries(Object.entries(style).map(([key, value]) => [`style:${key}`, JSON.stringify(value)])) });
        node.children.forEach((child, index) => flatten(child, node.id, index));
    }
    flatten(document.tree);
    doc.transact(() => {
        reconcile(shared.meta, { root: document.tree.id, layout: document.presentation.layout, theme: document.presentation.themeId, ...(document.presentation.customTheme ? { customTheme: JSON.stringify(document.presentation.customTheme) } : {}), ...(document.source ? { source: JSON.stringify(document.source) } : {}) });
        for (const id of shared.nodes.keys()) if (!nodes.has(id)) shared.nodes.delete(id);
        for (const [id, fields] of nodes) {
            let node = shared.nodes.get(id); if (!(node instanceof Y.Map)) { node = new Y.Map(); shared.nodes.set(id, node); }
            reconcile(node, fields);
        }
        reconcile(shared.relations, Object.fromEntries(document.relations.map(line => [`${line.from}:${line.to}`, JSON.stringify(line)])));
        reconcile(shared.summaries, Object.fromEntries(document.summaries.map(summary => [summary.id, JSON.stringify(summary)])));
    }, origin);
}
function read(doc) {
    const shared = maps(doc); const records = new Map(); const styles = {};
    if (shared.nodes.size > schema.LIMITS.nodes || shared.relations.size > schema.LIMITS.relations || shared.summaries.size > 60) throw schema.error('合并后的节点、关系或概要数量超过限制，请另存本地副本。', 'MINDMAP_MERGE_INVALID', 409);
    for (const [id, value] of shared.nodes) {
        if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw schema.error('协作节点标识无效。');
        if (!(value instanceof Y.Map)) throw schema.error('协作节点结构无效。');
        const fields = value.toJSON(); const style = {};
        for (const [key, value] of Object.entries(fields)) if (key.startsWith('style:')) style[key.slice(6)] = JSON.parse(value);
        styles[id] = style; records.set(id, { id, text: fields.text, children: [], parent: fields.parent, order: fields.order });
    }
    const root = records.get(shared.meta.get('root')); if (!root || root.parent !== '') throw schema.error('协作中心主题无效，请重载或另存副本。', 'MINDMAP_MERGE_INVALID', 409);
    for (const node of records.values()) if (node !== root) {
        const parent = records.get(node.parent); if (!parent || parent === node) throw schema.error('协作中出现已删除的父节点或循环移动，请另存本地副本。', 'MINDMAP_MERGE_INVALID', 409);
        parent.children.push(node);
    }
    const seen = new Set();
    function tree(node, depth = 0) {
        if (seen.has(node.id) || depth > schema.LIMITS.depth) throw schema.error('协作合并后的结构存在循环或层级过深，请另存本地副本。', 'MINDMAP_MERGE_INVALID', 409);
        seen.add(node.id); node.children.sort((a, b) => Number(a.order) - Number(b.order) || a.id.localeCompare(b.id));
        return { id: node.id, text: node.text, children: node.children.map(child => tree(child, depth + 1)) };
    }
    const rootTree = tree(root); if (seen.size !== records.size) throw schema.error('协作合并产生了无法连接的分支，请另存本地副本。', 'MINDMAP_MERGE_INVALID', 409);
    return schema.normalize({ schemaVersion: 1, tree: rootTree, presentation: { layout: shared.meta.get('layout'), themeId: shared.meta.get('theme'), nodes: styles, ...(shared.meta.has('customTheme') ? { customTheme: JSON.parse(shared.meta.get('customTheme')) } : {}) }, relations: [...shared.relations.values()].map(value => JSON.parse(value)).filter(line => records.has(line.from) && records.has(line.to)), summaries: [...shared.summaries.values()].map(value => JSON.parse(value)), ...(shared.meta.has('source') ? { source: JSON.parse(shared.meta.get('source')) } : {}) });
}
function encode(doc) { const state = Y.encodeStateAsUpdate(doc); if (state.length > MAX_STATE_BYTES) throw schema.error('协作历史超过容量限制，请另存副本继续编辑。', 'MINDMAP_CRDT_QUOTA', 409); return state; }
function apply(doc, update, origin = 'remote') { if (!(update instanceof Uint8Array) || update.length > MAX_STATE_BYTES) throw schema.error('协作更新格式无效或超过大小限制。'); Y.applyUpdate(doc, update, origin); encode(doc); }
function vector(doc) { return Y.encodeStateVector(doc); }
function update(doc, stateVector) { return Y.encodeStateAsUpdate(doc, stateVector); }
function undoManager(doc) { const shared = maps(doc); return new Y.UndoManager(Object.values(shared), { trackedOrigins: new Set(['local']), captureTimeout: 400 }); }
module.exports = { MAX_STATE_BYTES, create, write, read, encode, apply, vector, update, undoManager };
