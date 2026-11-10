'use strict';

const { canonicalJson } = require('./canonical');
const { validateFlowExpression, validateFlowCustomSql, invalidFlow } = require('./flow-functions');

const MAX_FLOW_BYTES = 256 * 1024;
const MAX_FLOW_NODES = 24;
const MAX_FLOW_EDGES = 32;
const MAX_PREVIEW_LIMIT = 200;
const DEFAULT_PREVIEW_LIMIT = 50;
const MAX_MATERIALIZED_ROWS = 500000;
const ID_PATTERN = /^[\p{L}\p{N}_-]{1,120}$/u;
const FLOW_NODE_KINDS = new Set(['source', 'filter', 'formula', 'join', 'aggregate', 'select', 'union', 'sql']);
const FILTER_OPERATORS = new Set([
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'contains', 'starts_with', 'ends_with',
    'in', 'is_null', 'is_not_null'
]);
const AGGREGATE_FNS = new Set(['sum', 'avg', 'count', 'count_distinct', 'min', 'max']);

function safeId(value, label) {
    const text = String(value ?? '').trim();
    if (!ID_PATTERN.test(text)) invalidFlow(`${label}标识无效。`);
    return text;
}

function safeText(value, label, max = 120) {
    const text = String(value ?? '').replace(/\u0000/g, '').trim();
    if (text.length > max) invalidFlow(`${label}不能超过 ${max} 个字符。`);
    return text;
}

function normalizeLayout(layout) {
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return { x: 320, y: 120 };
    const x = Number(layout.x);
    const y = Number(layout.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000) {
        invalidFlow('算子节点画布坐标超出允许范围。');
    }
    return { x: Math.round(x), y: Math.round(y) };
}

function normalizeNodeConfig(kind, rawConfig = {}, { strict = false } = {}) {
    const cfg = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
    if (kind === 'source') {
        const datasetId = cfg.datasetId ? safeId(cfg.datasetId, '数据源数据集') : '';
        if (strict && !datasetId) invalidFlow('数据输入节点必须选择来源数据集。');
        return { datasetId };
    }
    if (kind === 'filter') {
        const match = cfg.match === 'any' ? 'any' : 'all';
        const rawList = Array.isArray(cfg.conditions) ? cfg.conditions.slice(0, 20) : [];
        const conditions = rawList.map(item => {
            const operator = FILTER_OPERATORS.has(item?.operator) ? item.operator : 'eq';
            return {
                field: safeText(item?.field || '', '筛选字段', 120),
                operator,
                valueType: ['auto', 'text', 'number'].includes(item?.valueType) ? item.valueType : 'auto',
                value: safeText(item?.value ?? '', '筛选条件值', 1000)
            };
        });
        return { match, conditions };
    }
    if (kind === 'formula') {
        const keepAll = cfg.keepAll !== false;
        const rawFields = Array.isArray(cfg.fields) ? cfg.fields.slice(0, 20) : [];
        const fields = rawFields.map(item => {
            const name = safeText(item?.name || '', '计算字段名', 80);
            const expression = safeText(item?.expression || '', '函数表达式', 2000);
            if (strict && (name || expression)) {
                if (!name) invalidFlow('请为计算字段填写输出列名。');
                validateFlowExpression(expression);
            }
            return { name, expression };
        });
        return { keepAll, fields };
    }
    if (kind === 'join') {
        const joinType = ['left', 'inner', 'right', 'full'].includes(cfg.joinType) ? cfg.joinType : 'left';
        const rawPairs = Array.isArray(cfg.keyPairs) ? cfg.keyPairs.slice(0, 6) : [];
        const keyPairs = rawPairs.map(pair => ({
            leftField: safeText(pair?.leftField || '', '左表关联字段', 120),
            rightField: safeText(pair?.rightField || '', '右表关联字段', 120)
        }));
        return { joinType, keyPairs };
    }
    if (kind === 'aggregate') {
        const groupBy = (Array.isArray(cfg.groupBy) ? cfg.groupBy : [])
            .slice(0, 12)
            .map(field => safeText(field, '分组字段', 120))
            .filter(Boolean);
        const rawAggs = Array.isArray(cfg.aggregations) ? cfg.aggregations.slice(0, 20) : [];
        const aggregations = rawAggs.map(item => {
            const fn = AGGREGATE_FNS.has(item?.fn) ? item.fn : 'sum';
            return {
                field: safeText(item?.field || '', '聚合字段', 120),
                fn,
                valueType: ['min', 'max'].includes(fn) && item?.valueType === 'text' ? 'text' : 'number',
                alias: safeText(item?.alias || '', '聚合输出列名', 80)
            };
        });
        return { groupBy, aggregations };
    }
    if (kind === 'select') {
        const columns = (Array.isArray(cfg.columns) ? cfg.columns : []).slice(0, 120).map(col => ({
            field: safeText(col?.field || '', '选择字段', 120),
            alias: safeText(col?.alias || '', '重命名字段', 80),
            enabled: col?.enabled !== false
        })).filter(col => col.field);
        const deduplicate = Boolean(cfg.deduplicate);
        const sortField = safeText(cfg.sortField || '', '排序字段', 120);
        const sortDirection = cfg.sortDirection === 'desc' ? 'desc' : 'asc';
        return { columns, deduplicate, sortField, sortDirection };
    }
    if (kind === 'union') {
        return {
            mode: cfg.mode === 'distinct' ? 'distinct' : 'all',
            byName: cfg.byName !== false
        };
    }
    if (kind === 'sql') {
        const sql = safeText(cfg.sql || '', '自定义 SQL', 6000);
        if (strict && sql) validateFlowCustomSql(sql);
        return { sql };
    }
    return {};
}

function detectFlowCycles(nodeIds, edges) {
    const adjacency = new Map([...nodeIds].map(id => [id, []]));
    for (const edge of edges) {
        if (!adjacency.has(edge.fromNodeId)) adjacency.set(edge.fromNodeId, []);
        adjacency.get(edge.fromNodeId).push(edge.toNodeId);
    }
    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
        if (visiting.has(id)) invalidFlow('算子流程图存在循环连线，请移除环路后再保存或运行。');
        if (visited.has(id)) return;
        visiting.add(id);
        for (const next of adjacency.get(id) || []) visit(next);
        visiting.delete(id);
        visited.add(id);
    }
    for (const id of adjacency.keys()) visit(id);
}

function normalizeFlowGraph(value, { definitionNodeIds = new Set(), strict = false } = {}) {
    if (value === undefined) return undefined;
    if (value === null) return { nodes: [], edges: [] };
    if (typeof value !== 'object' || Array.isArray(value)) invalidFlow('算子流程图定义格式无效。');
    const serialized = canonicalJson(value);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FLOW_BYTES) {
        invalidFlow('算子流程图配置超过 256 KB 上限，请精简节点配置。');
    }
    const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
    const rawEdges = Array.isArray(value.edges) ? value.edges : [];
    if (rawNodes.length > MAX_FLOW_NODES) invalidFlow(`算子节点数量不能超过 ${MAX_FLOW_NODES} 个。`);
    if (rawEdges.length > MAX_FLOW_EDGES) invalidFlow(`算子连线数量不能超过 ${MAX_FLOW_EDGES} 条。`);

    const seenIds = new Set(definitionNodeIds);
    const nodes = rawNodes.map((node, index) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) invalidFlow('算子节点结构无效。');
        const id = safeId(node.id, '算子节点');
        if (seenIds.has(id)) invalidFlow(`算子节点标识「${id}」重复或与模型表冲突。`);
        seenIds.add(id);
        const kind = String(node.kind || '').trim();
        if (!FLOW_NODE_KINDS.has(kind)) invalidFlow(`不支持的算子类型：${kind}`);
        const name = safeText(node.name || `算子 ${index + 1}`, '算子名称', 120) || `算子 ${index + 1}`;
        return {
            id,
            kind,
            name,
            layout: normalizeLayout(node.layout),
            config: normalizeNodeConfig(kind, node.config, { strict })
        };
    });

    const edgeIds = new Set();
    const pairKeys = new Set();
    const edges = rawEdges.map((edge, index) => {
        if (!edge || typeof edge !== 'object' || Array.isArray(edge)) invalidFlow('算子连线结构无效。');
        const id = safeId(edge.id || `edge_${index + 1}`, '算子连线');
        if (edgeIds.has(id)) invalidFlow('算子连线标识不能重复。');
        edgeIds.add(id);
        const fromNodeId = safeId(edge.fromNodeId, '连线起点节点');
        const toNodeId = safeId(edge.toNodeId, '连线终点节点');
        if (fromNodeId === toNodeId) invalidFlow('节点不能连接自身。');
        if (!seenIds.has(fromNodeId) || !seenIds.has(toNodeId)) invalidFlow('算子连线引用了不存在的节点。');
        const pairKey = `${fromNodeId}->${toNodeId}`;
        if (pairKeys.has(pairKey)) invalidFlow('相同两个节点之间不能重复连线。');
        pairKeys.add(pairKey);
        return { id, fromNodeId, toNodeId };
    });

    detectFlowCycles(seenIds, edges);
    const inputs = new Map();
    for (const edge of edges) inputs.set(edge.toNodeId, (inputs.get(edge.toNodeId) || 0) + 1);
    for (const [id, count] of inputs) {
        const node = nodes.find(item => item.id === id);
        if (!node || node.kind === 'source') invalidFlow('算子连线终点必须是接受上游输入的算子节点。');
        const maximum = node.kind === 'join' ? 2 : ['union', 'sql'].includes(node.kind) ? 8 : 1;
        if (count > maximum) invalidFlow(`节点「${node.name}」最多接受 ${maximum} 个上游输入。`);
    }
    return { nodes, edges };
}

function resolveExecutionPlan(targetNodeId, definitionNodes, flowGraph) {
    const defMap = new Map((definitionNodes || []).map(node => [node.id, {
        id: node.id,
        kind: node.role === 'fact' ? 'fact_table' : 'dimension_table',
        name: node.name || node.id,
        datasetId: node.datasetId,
        isDefinitionNode: true
    }]));
    const flowMap = new Map((flowGraph.nodes || []).map(node => [node.id, { ...node, isDefinitionNode: false }]));
    const getNode = id => defMap.get(id) || flowMap.get(id) || null;
    const target = getNode(targetNodeId);
    if (!target) invalidFlow('要预览的目标节点不存在，请先在画布中选中有效节点。');

    const incoming = new Map();
    for (const edge of flowGraph.edges || []) {
        if (!incoming.has(edge.toNodeId)) incoming.set(edge.toNodeId, []);
        incoming.get(edge.toNodeId).push(edge.fromNodeId);
    }

    const ordered = [];
    const visited = new Set();
    const visiting = new Set();
    function dfs(id) {
        if (visiting.has(id)) invalidFlow('节点连线存在循环依赖，请先断开环路。');
        if (visited.has(id)) return;
        visiting.add(id);
        const node = getNode(id);
        if (!node) invalidFlow(`连线引用的上游节点「${id}」不存在。`);
        for (const upId of incoming.get(id) || []) dfs(upId);
        visiting.delete(id);
        visited.add(id);
        ordered.push(node);
    }
    dfs(targetNodeId);
    return { ordered, incoming, target };
}


module.exports = { normalizeFlowGraph, resolveExecutionPlan, safeId, MAX_PREVIEW_LIMIT, DEFAULT_PREVIEW_LIMIT, MAX_MATERIALIZED_ROWS };
