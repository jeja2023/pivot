'use strict';

const { BI_POLICY } = require('./policy');
const { biError } = require('./errors');

function invalid(message, code = 'ANALYSIS_MODEL_GRAPH_INVALID') { throw biError(code, message); }

function identifier(value, label) {
    if (typeof value !== 'string' || !/^[\p{L}\p{N}_-]{1,120}$/u.test(value)) invalid(`${label}无效，请重新选择。`);
    return value;
}

function fieldKeys(value, label) {
    if (!Array.isArray(value) || !value.length || value.length > 120) invalid(`请为${label}选择有效的粒度或主键字段。`, 'ANALYSIS_MODEL_GRAIN_REQUIRED');
    const keys = value.map(key => identifier(key, '字段标识'));
    if (new Set(keys).size !== keys.length) invalid(`${label}的键字段不能重复。`);
    return keys;
}

function planModelGraph(definition) {
    const nodes = definition?.nodes;
    const relations = definition?.relations;
    if (!Array.isArray(nodes) || !nodes.length || nodes.length > BI_POLICY.maxRelations + 1) invalid('生产模型必须包含一个事实表，最多添加八张维度表。');
    if (!Array.isArray(relations) || relations.length > BI_POLICY.maxRelations) invalid('生产模型最多包含八条有效关联。');
    const nodeById = new Map();
    const datasets = new Set();
    for (const node of nodes) {
        identifier(node?.id, '模型节点标识');
        identifier(node?.datasetId, '数据集标识');
        if (nodeById.has(node.id) || datasets.has(node.datasetId)) invalid('模型节点或数据集重复；当前不支持同表多个别名。');
        if (!['fact', 'dimension'].includes(node.role)) invalid('请选择事实表或维度表角色。');
        fieldKeys(node.grainKeys, node.role === 'fact' ? '事实表' : '维度表');
        nodeById.set(node.id, node);
        datasets.add(node.datasetId);
    }
    const facts = nodes.filter(node => node.role === 'fact');
    if (facts.length !== 1) invalid('生产模型必须且只能包含一个事实表。');
    const fact = facts[0];
    const relationIds = new Set();
    const incoming = new Map();
    for (const relation of relations) {
        identifier(relation?.id, '关联标识');
        if (relationIds.has(relation.id)) invalid('关联标识不能重复。');
        relationIds.add(relation.id);
        const left = nodeById.get(relation.leftNodeId);
        const right = nodeById.get(relation.rightNodeId);
        if (!left || !right || left === right || right === fact) invalid('关联必须从事实根的已有节点指向新的维度节点。');
        if (incoming.has(right.id)) invalid('同一维度只能有一条父关系，不能存在多条有效连接路径。');
        if (!['left', 'inner'].includes(relation.joinType)) invalid('生产模型仅支持左关联或内关联。');
        if (!['many_to_one', 'one_to_one'].includes(relation.cardinality)) invalid('生产模型只允许多对一或一对一关联。', 'ANALYSIS_MODEL_CARDINALITY_INVALID');
        const pairs = relation.keyPairs;
        if (!Array.isArray(pairs) || !pairs.length || pairs.length > BI_POLICY.maxKeyPairs) invalid('关联需要一至三对等值键字段。');
        const leftKeys = pairs.map(pair => identifier(pair?.leftFieldKey, '左侧字段'));
        const rightKeys = pairs.map(pair => identifier(pair?.rightFieldKey, '右侧字段'));
        if (new Set(leftKeys).size !== leftKeys.length || new Set(rightKeys).size !== rightKeys.length) invalid('同一关联中的键字段不能重复。');
        if (rightKeys.length !== right.grainKeys.length || rightKeys.some(key => !right.grainKeys.includes(key))) invalid('维度关联键必须完整覆盖已定义的维度主键。');
        incoming.set(right.id, relation);
    }
    const joined = new Set([fact.id]);
    const ordered = [];
    while (ordered.length < relations.length) {
        const candidates = relations.filter(relation => joined.has(relation.leftNodeId) && !joined.has(relation.rightNodeId)).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
        if (!candidates.length) invalid('模型包含环路或不连通的节点，请检查关联方向。');
        for (const relation of candidates) { joined.add(relation.rightNodeId); ordered.push(relation); }
    }
    if (joined.size !== nodes.length) invalid('所有维度都必须连通到事实表。');
    return { factNodeId: fact.id, nodes, nodeById, relations: ordered, incoming };
}

// 内关联改变模型的事实范围，即使不展示该维度也必须保留整条祖先路径。
function requiredModelRelations(plan, referencedNodeIds = []) {
    const needed = new Set(referencedNodeIds);
    for (const relation of plan.relations) if (relation.joinType === 'inner') needed.add(relation.rightNodeId);
    const required = new Set();
    for (const nodeId of needed) {
        if (!plan.nodeById.has(nodeId)) invalid('查询引用了模型外的节点。');
        let cursor = nodeId;
        while (cursor !== plan.factNodeId) {
            const relation = plan.incoming.get(cursor);
            required.add(relation.id);
            cursor = relation.leftNodeId;
        }
    }
    return plan.relations.filter(relation => required.has(relation.id));
}

module.exports = { planModelGraph, requiredModelRelations };
