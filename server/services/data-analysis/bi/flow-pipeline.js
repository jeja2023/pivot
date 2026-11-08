'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { canonicalJson } = require('./canonical');
const { modelForUser } = require('./access');
const {
    FLOW_BUILTIN_FUNCTIONS,
    validateFlowExpression,
    validateFlowCustomSql,
    invalidFlow
} = require('./flow-functions');
const { lockDuckExternalAccess } = require('../duckdb-sandbox');
const { profileViaSql } = require('../profile');
const { numericValueSql } = require('../numeric-values');
const flowDatasetRepo = require('../../../repositories/analysis-flow-datasets');
const {
    DATA_ANALYSIS_QUERY_TIMEOUT_MS,
    analysisId,
    datasetRoot,
    ensureAnalysisDirs,
    resolveInside,
    toProjectRelative,
    sqlIdent,
    sqlLiteral,
    normalizeDatasetName,
    getBeijingTimestamp,
    resolveAnalysisUser,
    getDatasetForUser,
    getDatasetPaths,
    serializeDataset,
    createDuckConnection,
    withDuckTimeout,
    withAnalysisSlot,
    bestEffortRemove
} = require('../shared');

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
    return { nodes, edges };
}

function buildFilterClause(condition, availableColumns) {
    const field = condition.field;
    if (!field) return null;
    if (!availableColumns.has(field)) invalidFlow(`筛选条件引用的字段「${field}」在上游输出中不存在。`);
    const colExpr = sqlIdent(field);
    const textExpr = `CAST(${colExpr} AS VARCHAR)`;
    const op = condition.operator;
    if (op === 'is_null') return `(${colExpr} IS NULL OR TRIM(${textExpr}) = '')`;
    if (op === 'is_not_null') return `(${colExpr} IS NOT NULL AND TRIM(${textExpr}) <> '')`;
    const rawVal = String(condition.value ?? '');
    if (op === 'contains') return `contains(${textExpr}, ${sqlLiteral(rawVal)})`;
    if (op === 'starts_with') return `starts_with(${textExpr}, ${sqlLiteral(rawVal)})`;
    if (op === 'ends_with') return `ends_with(${textExpr}, ${sqlLiteral(rawVal)})`;
    if (op === 'in') {
        const items = rawVal.split(/[\n,，]/).map(item => item.trim()).filter(Boolean).slice(0, 200);
        if (!items.length) invalidFlow(`字段「${field}」的属于列表条件需要至少填写一个值。`);
        return `(${textExpr} IN (${items.map(sqlLiteral).join(', ')}))`;
    }
    const asNumber = Number(rawVal);
    if (['gt', 'gte', 'lt', 'lte'].includes(op) && rawVal.trim() !== '' && Number.isFinite(asNumber)) {
        const numExpr = numericValueSql(colExpr);
        const symbol = ({ gt: '>', gte: '>=', lt: '<', lte: '<=' })[op];
        return `(${numExpr} ${symbol} ${asNumber})`;
    }
    const symbol = ({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' })[op] || '=';
    if (['eq', 'neq'].includes(op) && rawVal.trim() !== '' && Number.isFinite(asNumber)) {
        return `(CAST(${colExpr} AS VARCHAR) ${symbol} ${sqlLiteral(rawVal.trim())} OR ${numericValueSql(colExpr)} ${symbol} ${asNumber})`;
    }
    return `(${textExpr} ${symbol} ${sqlLiteral(rawVal)})`;
}

function formatDuckError(nodeName, error) {
    if (error?.code === 'ANALYSIS_MODEL_FLOW_INVALID') throw error;
    const raw = String(error?.message || '算子执行失败');
    let friendly = raw.split('\n')[0].slice(0, 320);
    if (/Binder Error|No function matches|argument types/i.test(raw)) {
        friendly = '表达式或关联字段类型不匹配，数值运算建议使用 TRY_CAST("字段名" AS DOUBLE) 转换后再计算。';
    } else if (/Referenced column|not found|Catalog Error/i.test(raw)) {
        friendly = '引用的字段或上游表名不存在，请核对字段名并用双引号包裹（自定义 SQL 请查询 input_1、input_2）。';
    } else if (/Parser Error|syntax error/i.test(raw)) {
        friendly = '表达式或自定义 SQL 存在语法错误，请检查括号、引号和函数参数格式。';
    }
    return invalidFlow(`节点「${nodeName}」执行失败：${friendly}`);
}

async function describeTableColumns(connection, viewOrTableName) {
    const rows = (await withDuckTimeout(
        connection,
        () => connection.runAndReadAll(`DESCRIBE SELECT * FROM ${sqlIdent(viewOrTableName)}`),
        DATA_ANALYSIS_QUERY_TIMEOUT_MS
    )).getRowObjectsJson();
    return rows.map(row => ({
        name: String(row.column_name),
        type: String(row.column_type || 'VARCHAR')
    }));
}

async function countRows(connection, viewOrTableName) {
    const rows = (await withDuckTimeout(
        connection,
        () => connection.runAndReadAll(`SELECT COUNT(*) AS n FROM ${sqlIdent(viewOrTableName)}`),
        DATA_ANALYSIS_QUERY_TIMEOUT_MS
    )).getRowObjectsJson();
    return Number(rows[0]?.n || 0);
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

async function compileAndMaterializePlan(connection, plan, datasetTableMap) {
    const stepTables = new Map();
    const stepSchemas = new Map();

    for (let index = 0; index < plan.ordered.length; index += 1) {
        const node = plan.ordered[index];
        const stepName = `__flow_step_${index}`;
        const upIds = plan.incoming.get(node.id) || [];
        const upTables = upIds.map(upId => stepTables.get(upId));

        try {
            if (node.isDefinitionNode || node.kind === 'source') {
                const datasetId = node.datasetId || node.config?.datasetId;
                const rawTable = datasetTableMap.get(datasetId);
                if (!rawTable) invalidFlow(`节点「${node.name}」尚未选择有效的来源数据集。`);
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT * FROM ${sqlIdent(rawTable)}`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            } else if (node.kind === 'filter') {
                if (upTables.length !== 1) invalidFlow(`筛选节点「${node.name}」需要连接 1 个上游输入节点。`);
                const cols = new Set((stepSchemas.get(upIds[0]) || []).map(col => col.name));
                const clauses = (node.config.conditions || [])
                    .map(cond => buildFilterClause(cond, cols))
                    .filter(Boolean);
                const joiner = node.config.match === 'any' ? ' OR ' : ' AND ';
                const whereSql = clauses.length ? `WHERE ${clauses.join(joiner)}` : '';
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT * FROM ${sqlIdent(upTables[0])} ${whereSql}`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            } else if (node.kind === 'formula') {
                if (upTables.length !== 1) invalidFlow(`字段计算节点「${node.name}」需要连接 1 个上游输入节点。`);
                const upstreamCols = stepSchemas.get(upIds[0]) || [];
                const colSet = new Set(upstreamCols.map(col => col.name));
                const validFields = (node.config.fields || []).filter(f => f.name && f.expression);
                if (!validFields.length) invalidFlow(`字段计算节点「${node.name}」请至少配置一个计算字段与函数表达式。`);
                const replacedNames = new Set(validFields.map(f => f.name));
                const keptSelects = node.config.keepAll !== false
                    ? upstreamCols.filter(col => !replacedNames.has(col.name)).map(col => sqlIdent(col.name))
                    : [];
                const computedSelects = validFields.map(f => {
                    const expr = validateFlowExpression(f.expression, colSet);
                    return `(${expr}) AS ${sqlIdent(f.name)}`;
                });
                const selectSql = [...keptSelects, ...computedSelects].join(', ');
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT ${selectSql} FROM ${sqlIdent(upTables[0])}`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            } else if (node.kind === 'join') {
                if (upTables.length < 2) invalidFlow(`多表关联节点「${node.name}」需要连接 2 个上游输入节点（左表与右表）。`);
                const leftCols = stepSchemas.get(upIds[0]) || [];
                const rightCols = stepSchemas.get(upIds[1]) || [];
                const leftSet = new Set(leftCols.map(col => col.name));
                const rightSet = new Set(rightCols.map(col => col.name));
                const validPairs = (node.config.keyPairs || []).filter(p => p.leftField && p.rightField);
                if (!validPairs.length) invalidFlow(`多表关联节点「${node.name}」请至少配置一对关联字段。`);
                for (const pair of validPairs) {
                    if (!leftSet.has(pair.leftField)) invalidFlow(`左表中不存在关联字段「${pair.leftField}」。`);
                    if (!rightSet.has(pair.rightField)) invalidFlow(`右表中不存在关联字段「${pair.rightField}」。`);
                }
                const rightNodeName = plan.ordered.find(item => item.id === upIds[1])?.name || '右表';
                const leftSelect = leftCols.map(col => `l.${sqlIdent(col.name)} AS ${sqlIdent(col.name)}`);
                const rightSelect = rightCols.map(col => {
                    const outName = leftSet.has(col.name) ? `${rightNodeName}_${col.name}` : col.name;
                    return `r.${sqlIdent(col.name)} AS ${sqlIdent(outName)}`;
                });
                const onSql = validPairs
                    .map(p => `CAST(l.${sqlIdent(p.leftField)} AS VARCHAR) = CAST(r.${sqlIdent(p.rightField)} AS VARCHAR)`)
                    .join(' AND ');
                const joinKeyword = ({ left: 'LEFT JOIN', inner: 'INNER JOIN', right: 'RIGHT JOIN', full: 'FULL OUTER JOIN' })[node.config.joinType] || 'LEFT JOIN';
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT ${[...leftSelect, ...rightSelect].join(', ')} FROM ${sqlIdent(upTables[0])} l ${joinKeyword} ${sqlIdent(upTables[1])} r ON ${onSql}`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            } else if (node.kind === 'aggregate') {
                if (upTables.length !== 1) invalidFlow(`分组聚合节点「${node.name}」需要连接 1 个上游输入节点。`);
                const upstreamCols = stepSchemas.get(upIds[0]) || [];
                const colSet = new Set(upstreamCols.map(col => col.name));
                const groupBy = (node.config.groupBy || []).filter(Boolean);
                for (const g of groupBy) {
                    if (!colSet.has(g)) invalidFlow(`分组字段「${g}」在上游输出中不存在。`);
                }
                const aggs = (node.config.aggregations || []).filter(a => a.fn === 'count' || a.field);
                if (!aggs.length) invalidFlow(`分组聚合节点「${node.name}」请至少配置一项汇总统计指标。`);
                const fnLabels = { sum: '求和', avg: '均值', count: '记录数', count_distinct: '去重数', min: '最小值', max: '最大值' };
                const aggSelects = aggs.map(agg => {
                    if (agg.fn !== 'count' && !colSet.has(agg.field)) {
                        invalidFlow(`聚合字段「${agg.field}」在上游输出中不存在。`);
                    }
                    const alias = agg.alias || (agg.fn === 'count' ? '记录条数' : `${agg.field}_${fnLabels[agg.fn] || agg.fn}`);
                    const colIdent = agg.field ? sqlIdent(agg.field) : '';
                    let expr = 'COUNT(*)';
                    if (agg.fn === 'count_distinct') expr = `COUNT(DISTINCT ${colIdent})`;
                    else if (agg.fn === 'sum') expr = `ROUND(SUM(${numericValueSql(colIdent)}), 4)`;
                    else if (agg.fn === 'avg') expr = `ROUND(AVG(${numericValueSql(colIdent)}), 4)`;
                    else if (agg.fn === 'min') expr = `MIN(${colIdent})`;
                    else if (agg.fn === 'max') expr = `MAX(${colIdent})`;
                    return `${expr} AS ${sqlIdent(alias)}`;
                });
                const selectParts = [...groupBy.map(g => sqlIdent(g)), ...aggSelects];
                const groupSql = groupBy.length ? `GROUP BY ${groupBy.map(g => sqlIdent(g)).join(', ')}` : '';
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT ${selectParts.join(', ')} FROM ${sqlIdent(upTables[0])} ${groupSql}`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            } else if (node.kind === 'select') {
                if (upTables.length !== 1) invalidFlow(`字段清洗节点「${node.name}」需要连接 1 个上游输入节点。`);
                const upstreamCols = stepSchemas.get(upIds[0]) || [];
                const colSet = new Set(upstreamCols.map(col => col.name));
                const activeCols = (node.config.columns || []).filter(c => c.enabled !== false && c.field);
                const chosen = activeCols.length
                    ? activeCols.map(c => {
                        if (!colSet.has(c.field)) invalidFlow(`选择的字段「${c.field}」在上游输出中不存在。`);
                        return `${sqlIdent(c.field)} AS ${sqlIdent(c.alias || c.field)}`;
                    })
                    : upstreamCols.map(col => sqlIdent(col.name));
                const distinctKeyword = node.config.deduplicate ? 'DISTINCT ' : '';
                let orderSql = '';
                if (node.config.sortField) {
                    const outNames = new Set(activeCols.length ? activeCols.map(c => c.alias || c.field) : upstreamCols.map(c => c.name));
                    if (outNames.has(node.config.sortField) || colSet.has(node.config.sortField)) {
                        orderSql = ` ORDER BY ${sqlIdent(node.config.sortField)} ${node.config.sortDirection === 'desc' ? 'DESC' : 'ASC'}`;
                    }
                }
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS SELECT ${distinctKeyword}${chosen.join(', ')} FROM ${sqlIdent(upTables[0])}${orderSql}`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            } else if (node.kind === 'union') {
                if (upTables.length < 2) invalidFlow(`上下合并节点「${node.name}」需要连接至少 2 个上游输入节点。`);
                const unionOp = node.config.mode === 'distinct'
                    ? (node.config.byName !== false ? 'UNION BY NAME' : 'UNION')
                    : (node.config.byName !== false ? 'UNION ALL BY NAME' : 'UNION ALL');
                const unionSql = upTables.map(tbl => `SELECT * FROM ${sqlIdent(tbl)}`).join(` ${unionOp} `);
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE TEMP VIEW ${sqlIdent(stepName)} AS ${unionSql}`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            } else if (node.kind === 'sql') {
                if (!upTables.length) invalidFlow(`自定义 SQL 节点「${node.name}」请至少连接 1 个上游输入节点（在 SQL 中使用 input_1 引用）。`);
                const userSql = validateFlowCustomSql(node.config.sql);
                for (let i = 0; i < upTables.length; i += 1) {
                    await withDuckTimeout(connection, () => connection.run(
                        `CREATE OR REPLACE TEMP VIEW ${sqlIdent(`input_${i + 1}`)} AS SELECT * FROM ${sqlIdent(upTables[i])}`
                    ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
                }
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE OR REPLACE TEMP VIEW "input" AS SELECT * FROM ${sqlIdent(upTables[0])}`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE TEMP TABLE ${sqlIdent(stepName)} AS ${userSql}`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
            }
            const schema = await describeTableColumns(connection, stepName);
            stepTables.set(node.id, stepName);
            stepSchemas.set(node.id, schema);
        } catch (error) {
            formatDuckError(node.name, error);
        }
    }

    return { stepTables, stepSchemas };
}

async function loadAuthorizedSourceDatasets(actor, plan) {
    const datasetIds = new Set();
    for (const node of plan.ordered) {
        const dsId = node.isDefinitionNode ? node.datasetId : (node.kind === 'source' ? node.config?.datasetId : '');
        if (dsId) datasetIds.add(dsId);
    }
    const governance = require('../governance');
    const prepared = new Map();
    for (const dsId of datasetIds) {
        const datasetRow = await getDatasetForUser(actor, dsId);
        const accessibleCols = await governance.getAccessibleDatasetColumns(actor, datasetRow);
        if (!accessibleCols.length) {
            invalidFlow(`数据集「${datasetRow.name}」无可访问字段，请检查字段共享权限。`);
        }
        const usedAliases = new Set();
        const selectList = accessibleCols.map(col => {
            let display = String(col.name || col.key).trim() || col.key;
            if (usedAliases.has(display)) display = `${display}_${col.key}`;
            usedAliases.add(display);
            return `${sqlIdent(col.key)} AS ${sqlIdent(display)}`;
        }).join(', ');
        prepared.set(dsId, {
            dataset: datasetRow,
            parquetPath: getDatasetPaths(datasetRow).parquetPath,
            selectList
        });
    }
    return prepared;
}

async function previewModelNode({ user, modelId, body = {} }) {
    const startedAt = performance.now();
    const row = await modelForUser(user, modelId);
    const actor = await resolveAnalysisUser(Number(user?.id));
    const definitionNodes = Array.isArray(body.definitionNodes)
        ? body.definitionNodes
        : (row.definition_json?.nodes || []);
    const defIdSet = new Set(definitionNodes.map(n => n.id));
    const flowGraph = normalizeFlowGraph(body.flowGraph || { nodes: [], edges: [] }, {
        definitionNodeIds: defIdSet,
        strict: false
    });
    const targetNodeId = safeId(body.targetNodeId, '预览目标节点');
    const limit = Math.min(Math.max(Number.parseInt(body.limit, 10) || DEFAULT_PREVIEW_LIMIT, 1), MAX_PREVIEW_LIMIT);
    const plan = resolveExecutionPlan(targetNodeId, definitionNodes, flowGraph);
    const preparedDatasets = await loadAuthorizedSourceDatasets(actor, plan);

    const previewResult = await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const datasetTableMap = new Map();
            let srcIndex = 0;
            for (const [dsId, entry] of preparedDatasets.entries()) {
                const rawName = `__raw_src_${srcIndex++}`;
                await withDuckTimeout(connection, () => connection.run(
                    `CREATE TEMP TABLE ${sqlIdent(rawName)} AS SELECT ${entry.selectList} FROM read_parquet(${sqlLiteral(entry.parquetPath)})`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
                datasetTableMap.set(dsId, rawName);
            }
            // 物化授权数据集后立即封锁外部文件与扩展访问，确保公式与自定义 SQL 处于严格内存沙箱。
            await lockDuckExternalAccess(connection);

            const { stepTables, stepSchemas } = await compileAndMaterializePlan(connection, plan, datasetTableMap);
            const targetStep = stepTables.get(targetNodeId);
            const columns = stepSchemas.get(targetNodeId) || [];
            const totalRows = await countRows(connection, targetStep);

            const upstreamIds = plan.incoming.get(targetNodeId) || [];
            let upstreamRows = null;
            if (upstreamIds.length === 1 && stepTables.has(upstreamIds[0])) {
                upstreamRows = await countRows(connection, stepTables.get(upstreamIds[0]));
            }

            const reader = await withDuckTimeout(
                connection,
                () => connection.runAndReadAll(`SELECT * FROM ${sqlIdent(targetStep)} LIMIT ${limit}`),
                DATA_ANALYSIS_QUERY_TIMEOUT_MS
            );
            const rows = reader.getRowObjectsJson();
            const steps = plan.ordered.map(stepNode => ({
                id: stepNode.id,
                name: stepNode.name,
                kind: stepNode.kind
            }));

            return {
                nodeId: targetNodeId,
                nodeName: plan.target.name,
                nodeKind: plan.target.kind,
                columns,
                rows,
                totalRows,
                upstreamRows,
                displayedRows: rows.length,
                truncated: totalRows > rows.length,
                steps,
                durationMs: Math.max(1, Math.round(performance.now() - startedAt))
            };
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    }, { userId: Number(actor.id) });

    return previewResult;
}

async function materializeModelNodeDataset({ user, modelId, body = {} }) {
    await modelForUser(user, modelId, { write: true });
    const actor = await resolveAnalysisUser(Number(user?.id));
    const definitionNodes = Array.isArray(body.definitionNodes) ? body.definitionNodes : [];
    const defIdSet = new Set(definitionNodes.map(n => n.id));
    const flowGraph = normalizeFlowGraph(body.flowGraph || { nodes: [], edges: [] }, {
        definitionNodeIds: defIdSet,
        strict: true
    });
    const targetNodeId = safeId(body.targetNodeId, '输出目标节点');
    const plan = resolveExecutionPlan(targetNodeId, definitionNodes, flowGraph);
    const preparedDatasets = await loadAuthorizedSourceDatasets(actor, plan);

    await ensureAnalysisDirs();
    const outputDatasetId = analysisId('ds');
    const outputDir = resolveInside(datasetRoot, String(actor.id), outputDatasetId);
    const outputPath = resolveInside(outputDir, 'data.parquet');
    const outputName = normalizeDatasetName('', body.datasetName || `${plan.target.name}_建模输出`);

    let inserted = false;
    await fs.promises.mkdir(outputDir, { recursive: true });
    try {
        const execution = await withAnalysisSlot(async () => {
            const { instance, connection } = await createDuckConnection();
            try {
                const datasetTableMap = new Map();
                let srcIndex = 0;
                for (const [dsId, entry] of preparedDatasets.entries()) {
                    const rawName = `__raw_src_${srcIndex++}`;
                    await withDuckTimeout(connection, () => connection.run(
                        `CREATE TEMP TABLE ${sqlIdent(rawName)} AS SELECT ${entry.selectList} FROM read_parquet(${sqlLiteral(entry.parquetPath)})`
                    ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);
                    datasetTableMap.set(dsId, rawName);
                }
                await lockDuckExternalAccess(connection, { allowedPaths: [outputPath] });

                const { stepTables, stepSchemas } = await compileAndMaterializePlan(connection, plan, datasetTableMap);
                const targetStep = stepTables.get(targetNodeId);
                const schema = stepSchemas.get(targetNodeId) || [];
                if (!schema.length) invalidFlow('目标节点没有输出任何列，无法保存为数据集。');
                const rowCount = await countRows(connection, targetStep);
                if (rowCount > MAX_MATERIALIZED_ROWS) {
                    invalidFlow(`节点输出共 ${rowCount} 行，超过单次物化上限 ${MAX_MATERIALIZED_ROWS} 行，请先添加筛选或聚合条件。`);
                }
                const outputColumns = schema.map((col, idx) => ({
                    key: `c_${idx + 1}`,
                    name: col.name,
                    index: idx
                }));
                const copySelect = schema
                    .map((col, idx) => `${sqlIdent(col.name)} AS ${sqlIdent(`c_${idx + 1}`)}`)
                    .join(', ');
                await withDuckTimeout(connection, () => connection.run(
                    `COPY (SELECT ${copySelect} FROM ${sqlIdent(targetStep)}) TO ${sqlLiteral(outputPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`
                ), DATA_ANALYSIS_QUERY_TIMEOUT_MS);

                const previewReader = await withDuckTimeout(
                    connection,
                    () => connection.runAndReadAll(`SELECT ${copySelect} FROM ${sqlIdent(targetStep)} LIMIT 20`),
                    DATA_ANALYSIS_QUERY_TIMEOUT_MS
                );
                return {
                    rowCount,
                    outputColumns,
                    previewRows: previewReader.getRowObjectsJson()
                };
            } finally {
                connection.closeSync();
                instance.closeSync();
            }
        }, { userId: Number(actor.id) });

        const profile = await profileViaSql(outputPath, execution.outputColumns, execution.rowCount);
        const stat = await fs.promises.stat(outputPath);
        const firstParentId = [...preparedDatasets.keys()][0] || null;
        const now = getBeijingTimestamp();

        await flowDatasetRepo.insertFlowDataset({
            id: outputDatasetId,
            userId: actor.id,
            name: outputName,
            originalName: `${outputName}.parquet`,
            fileSize: stat.size,
            parquetPath: toProjectRelative(outputPath),
            rowCount: execution.rowCount,
            columnCount: execution.outputColumns.length,
            columns: execution.outputColumns,
            profile,
            previewRows: execution.previewRows,
            parentDatasetId: firstParentId,
            now
        });
        inserted = true;
        return {
            dataset: serializeDataset(await getDatasetForUser(actor, outputDatasetId)),
            builtinFunctions: FLOW_BUILTIN_FUNCTIONS
        };
    } catch (error) {
        if (inserted) {
            await flowDatasetRepo.deleteFlowDataset(outputDatasetId, actor.id).catch(() => {});
        }
        bestEffortRemove(outputDir, { recursive: true });
        throw error;
    }
}

module.exports = {
    FLOW_BUILTIN_FUNCTIONS,
    normalizeFlowGraph,
    previewModelNode,
    materializeModelNodeDataset
};

