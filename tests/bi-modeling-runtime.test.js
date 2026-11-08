'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DuckDBInstance } = require('@duckdb/node-api');
const { runIsolated, cancellationProbe } = require('../server/services/data-analysis/bi/runtime');

async function fixture(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-bi-runtime-'));
    const original = { NODE_ENV: process.env.NODE_ENV, DATA_ANALYSIS_MODEL_RUNTIME: process.env.DATA_ANALYSIS_MODEL_RUNTIME, DATA_ANALYSIS_MODEL_WORKER_IMAGE: process.env.DATA_ANALYSIS_MODEL_WORKER_IMAGE };
    process.env.NODE_ENV = 'development';
    try {
        const file = path.join(root, 'input.parquet');
        const instance = await DuckDBInstance.create(':memory:'), connection = await instance.connect();
        try { await connection.run(`COPY (SELECT * FROM (VALUES ('1','10.25'),('2','20.50')) t(id,amount)) TO '${file.replaceAll("'", "''").replaceAll('\\', '/')}' (FORMAT PARQUET)`); }
        finally { connection.closeSync(); instance.closeSync(); }
        const definition = { nodes: [{ id: 'fact', datasetId: 'data', role: 'fact', grainKeys: ['id'] }], relations: [], dimensions: [], metrics: [{ id: 'amount', type: 'sum', scale: 2, field: { nodeId: 'fact', fieldKey: 'amount' } }] };
        await run({ root, file, definition, sources: { fact: { tableName: 'bi_input_0', file, columns: [{ key: 'id' }, { key: 'amount' }] } } });
    } finally {
        for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
        await fs.rm(root, { recursive: true, force: true });
    }
}

test('独立开发进程执行精确金额并实际终止取消任务，不向执行器传入数据库凭据', async () => fixture(async ({ root, definition, sources }) => {
    process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'development_process';
    const job = { container_id: `pivot-bi-test-${crypto.randomUUID()}`, execution_kind: 'model_query' };
    const result = await runIsolated({ job, definition, sources, query: { dimensions: [], metrics: ['amount'] }, outputRoot: path.join(root, 'result') });
    assert.equal(result.result.total.values.amount.value, '30.75');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runIsolated({ job, definition, sources, query: { dimensions: [], metrics: ['amount'] }, outputRoot: path.join(root, 'cancelled'), signal: controller.signal }), error => error.code === 'ANALYSIS_MODEL_QUERY_CANCELLED');
    assert.equal((await cancellationProbe(path.join(root, 'native-cancellation'))).cancelled, true);
}));

test('执行器按已编译路径准备输入，未展示的内关联仍限定事实范围，未用维度仍受总行数上限约束', async () => fixture(async ({ root, definition, sources }) => {
    process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'development_process';
    const dimension = path.join(root, 'dimension.parquet'), oversized = path.join(root, 'oversized.parquet');
    const instance = await DuckDBInstance.create(':memory:'), connection = await instance.connect();
    const quote = file => `'${file.replaceAll("'", "''").replaceAll('\\', '/')}'`;
    try {
        await connection.run(`COPY (SELECT '1' AS id) TO ${quote(dimension)} (FORMAT PARQUET)`);
        await connection.run(`COPY (SELECT CAST(i AS VARCHAR) AS id FROM range(2000001) t(i)) TO ${quote(oversized)} (FORMAT PARQUET)`);
    } finally { connection.closeSync(); instance.closeSync(); }
    const normalize = require('../server/services/data-analysis/bi/definition').normalizeModelDefinition;
    const make = joinType => normalize({ grainDescription: '一条记录', nodes: [...definition.nodes, ...['inner', 'unused'].map(id => ({ id, datasetId: id, role: 'dimension', grainKeys: ['id'] }))],
        relations: ['inner', 'unused'].map(id => ({ id: `r_${id}`, leftNodeId: 'fact', rightNodeId: id, joinType: id === 'inner' ? joinType : 'left', cardinality: 'many_to_one', keyPairs: [{ leftFieldKey: 'id', rightFieldKey: 'id' }] })), dimensions: [], metrics: definition.metrics }).definition;
    const inputs = { ...sources, inner: { tableName: 'bi_input_1', file: dimension, columns: [{ key: 'id' }] }, unused: { tableName: 'bi_input_2', file: dimension, columns: [{ key: 'id' }] } };
    const run = (model, inputs, name) => runIsolated({ job: { execution_kind: 'model_query', container_id: `pivot-bi-test-${crypto.randomUUID()}` }, definition: model, sources: inputs, query: { dimensions: [], metrics: ['amount'] }, outputRoot: path.join(root, name) });
    assert.equal((await run(make('inner'), inputs, 'inner-path')).result.total.values.amount.value, '10.25');
    assert.equal((await run(make('left'), inputs, 'left-path')).result.total.values.amount.value, '30.75');
    await assert.rejects(run(make('left'), { ...inputs, unused: { ...inputs.unused, file: oversized } }, 'capacity-denial'), error => error.code === 'ANALYSIS_MODEL_CAPACITY_EXCEEDED');
}));

test('Linux 容器执行器实测 cgroup 内存、CPU、进程与网络隔离，并运行同一精确查询', { timeout: 120000, skip: !process.env.PIVOT_TEST_ANALYSIS_DOCKER_IMAGE }, async () => fixture(async ({ root, definition, sources }) => {
    process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'docker'; process.env.DATA_ANALYSIS_MODEL_WORKER_IMAGE = process.env.PIVOT_TEST_ANALYSIS_DOCKER_IMAGE;
    const job = { container_id: `pivot-bi-test-${crypto.randomUUID()}`, execution_kind: 'probe' };
    const probe = await runIsolated({ job, definition, sources, inputResult: sources.fact.file, query: {}, outputRoot: path.join(root, 'probe') });
    assert.equal(BigInt(probe.probe.memory), 2n * 1024n ** 3n);
    assert.equal(probe.probe.pids, '64'); assert.equal(probe.probe.networkIsolated, true);
    assert.ok(['check', 'query', 'export', 'ingest', 'cancel', 'migration_compare'].every(kind => probe.probe.capabilities.includes(kind)));
    for (const property of ['inputReadOnly', 'rootReadOnly', 'outputWritable', 'extensionsDisabled', 'noCredentials', 'nonPrivileged']) assert.equal(probe.probe[property], true, property);
    const [quota, period] = probe.probe.cpu.split(' ').map(Number); assert.equal(quota / period, 2);
    const result = await runIsolated({ job: { ...job, container_id: `${job.container_id}-query`, execution_kind: 'model_query' }, definition, sources, query: { dimensions: [], metrics: ['amount'] }, outputRoot: path.join(root, 'result') });
    assert.equal(result.result.total.values.amount.value, '30.75');
    const model = require('../server/services/data-analysis/bi/definition').normalizeModelDefinition({ grainDescription: '每行一条记录', nodes: [...definition.nodes, { id: 'dim', datasetId: 'dim-data', role: 'dimension', grainKeys: ['id'] }],
        relations: [{ id: 'relation', leftNodeId: 'fact', rightNodeId: 'dim', joinType: 'left', cardinality: 'many_to_one', keyPairs: [{ leftFieldKey: 'id', rightFieldKey: 'id' }] }],
        dimensions: [{ id: 'identifier', nodeId: 'fact', fieldKey: 'id' }], metrics: definition.metrics }).definition;
    const snapshot = { sourceModelId: 'original', nodes: [{ id: 'fact', datasetId: 'data' }, { id: 'dim', datasetId: 'dim-data' }], metrics: [], relations: [{ id: 'relation', leftNodeId: 'fact', rightNodeId: 'dim', leftFieldKey: 'id', rightFieldKey: 'id', joinType: 'left', status: 'active' }] };
    const comparison = await runIsolated({ job: { ...job, container_id: `${job.container_id}-compare`, execution_kind: 'model_check' }, definition: model, sources: { ...sources, dim: { ...sources.fact, tableName: 'bi_input_1' } },
        query: { migrationComparison: { snapshot, snapshotHash: require('../server/services/data-analysis/bi/canonical').canonicalHash(snapshot), dimensions: ['identifier'], metrics: ['amount'] } }, outputRoot: path.join(root, 'comparison') });
    assert.equal(comparison.report.passed, true); assert.equal(comparison.report.migrationComparison.complete, true); assert.equal(comparison.report.migrationComparison.hasDifferences, false);
    assert.deepEqual(comparison.report.migrationComparison.rows, { legacy: '2', formal: '2' });
    assert.equal(comparison.report.migrationComparison.totals[0].formal, '30.75');
    assert.equal((await cancellationProbe(path.join(root, 'container-cancellation'))).cancelled, true);
}));
