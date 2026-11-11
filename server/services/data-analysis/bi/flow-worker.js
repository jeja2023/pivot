'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { sqlIdentifier: ident, sqlLiteral } = require('./sql-expressions');
const { normalizeFlowGraph, resolveExecutionPlan, MAX_MATERIALIZED_ROWS } = require('./flow-graph');
const { compileAndMaterializePlan, countRows } = require('./flow-engine');
const { lockDuckExternalAccess } = require('../duckdb-sandbox');
const { profileWithConnection } = require('../profile-sql');
const { invalidFlow } = require('./flow-functions');

async function executeFlow(connection, payload) {
    const started = performance.now(), query = payload.query;
    const graph = normalizeFlowGraph(query.flowGraph, { definitionNodeIds: new Set(query.definitionNodes.map(node => node.id)), strict: payload.kind === 'node_dataset' });
    const plan = resolveExecutionPlan(query.targetNodeId, query.definitionNodes, graph);
    const outputPath = path.join(payload.outputRoot, 'dataset.parquet');
    const datasetTables = new Map();
    for (const node of payload.definition.nodes) {
        const source = payload.sources[node.id];
        if (!source?.columns?.length) invalidFlow('节点来源没有可访问字段，请重新检查权限。');
        const aliases = new Set();
        const columns = source.columns.map(column => {
            let name = column.name || column.key;
            if (aliases.has(name)) name = `${name}_${column.key}`;
            aliases.add(name);
            return `${ident(column.key)} AS ${ident(name)}`;
        });
        await connection.run(`CREATE TEMP TABLE ${ident(source.tableName)} AS SELECT ${columns.join(',')} FROM read_parquet(${sqlLiteral(source.file)})`);
        datasetTables.set(node.datasetId, source.tableName);
    }
    await lockDuckExternalAccess(connection, { allowedPaths: payload.kind === 'node_dataset' ? [outputPath] : [], spillDirectory: payload.spillRoot || path.join(payload.outputRoot, 'spill') });
    const { stepTables, stepSchemas } = await compileAndMaterializePlan(connection, plan, datasetTables);
    const target = stepTables.get(query.targetNodeId), columns = stepSchemas.get(query.targetNodeId);
    if (!columns?.length || columns.length > 120) invalidFlow('节点输出需包含一至一百二十列，请通过字段清洗或 SQL 精简输出。');
    const rowCount = await countRows(connection, target);
    if (payload.kind === 'node_dataset') {
        if (!columns?.length || columns.length > 120 || rowCount > MAX_MATERIALIZED_ROWS) invalidFlow('节点输出需包含一至一百二十列且不超过五十万行，请先筛选或聚合。');
        const outputColumns = columns.map((column, index) => ({ key: `c_${index + 1}`, name: column.name, index }));
        const select = columns.map((column, index) => `${ident(column.name)} AS ${ident(outputColumns[index].key)}`).join(',');
        await connection.run(`COPY (SELECT ${select} FROM ${ident(target)}) TO ${sqlLiteral(outputPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
        const sample = outputColumns.map(column => `left(CAST(${ident(column.key)} AS VARCHAR),256) AS ${ident(column.key)}`).join(',');
        const previewRows = (await connection.runAndReadAll(`SELECT ${sample} FROM read_parquet(${sqlLiteral(outputPath)}) LIMIT 20`)).getRowObjectsJson();
        const profile = await profileWithConnection(connection, outputPath, outputColumns, rowCount, { sampleChars: 256 });
        return { complete: true, rowCount, columns: outputColumns, previewRows, profile, outputBytes: String((await fs.stat(outputPath)).size), previewCellLimit: 256 };
    }
    const upstream = plan.incoming.get(query.targetNodeId) || [];
    const sample = columns.map(column => /VARCHAR|BLOB/i.test(column.type) ? `left(CAST(${ident(column.name)} AS VARCHAR),256) AS ${ident(column.name)}` : ident(column.name)).join(',');
    const rows = (await connection.runAndReadAll(`SELECT ${sample} FROM ${ident(target)} LIMIT ${query.limit}`)).getRowObjectsJson();
    return { preview: { nodeId: query.targetNodeId, nodeName: plan.target.name, nodeKind: plan.target.kind, columns, rows, totalRows: rowCount,
        upstreamRows: upstream.length === 1 ? await countRows(connection, stepTables.get(upstream[0])) : null,
        displayedRows: rows.length, truncated: rowCount > rows.length, previewCellLimit: 256,
        steps: plan.ordered.map(node => ({ id: node.id, name: node.name, kind: node.kind })), durationMs: Math.max(1, Math.round(performance.now() - started)) } };
}

module.exports = { executeFlow };
