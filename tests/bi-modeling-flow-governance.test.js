'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { fixture, createFixture, cleanupUser } = require('../scripts/test_support/bi_modeling');
const { queryOne, execute } = require('../server/db/client');
const flow = require('../server/services/data-analysis/bi/flow-pipeline');
const jobs = require('../server/services/data-analysis/bi/jobs');
const repository = require('../server/repositories/analysis-model-jobs');
const runner = require('../server/services/data-analysis/bi/runner');
const runtime = require('../server/services/data-analysis/bi/runtime');
const datasets = require('../server/services/data-analysis/datasets');
const governance = require('../server/services/data-analysis/governance');
const delivery = require('../server/services/data-analysis/bi/delivery');

const bodyFor = model => ({ definitionNodes: model.definition.nodes, targetNodeId: 'fact', expectedVersion: model.version, requestKey: crypto.randomUUID() });
async function finish(user, job) {
    await runner.processModelJobs();
    return jobs.getModelJob(user, job.id);
}

test('运行开关关闭、归档、错误修订和越权均拒绝节点执行，迁移约束可重复应用', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    const options = { user, modelId: model.id, body: bodyFor(model) };
    process.env.DATA_ANALYSIS_MODEL_ENABLED = 'false';
    try {
        await assert.rejects(flow.previewModelNode(options), error => error.code === 'ANALYSIS_MODEL_RUNTIME_UNREADY');
        await assert.rejects(flow.materializeModelNodeDataset({ ...options, body: { ...options.body, datasetName: '禁用输出' } }), error => error.code === 'ANALYSIS_MODEL_RUNTIME_UNREADY');
    } finally { process.env.DATA_ANALYSIS_MODEL_ENABLED = 'true'; }
    await execute('UPDATE analysis_data_models SET archived_at=NOW() WHERE id=?', [model.id]);
    await assert.rejects(flow.previewModelNode(options), error => error.code === 'ANALYSIS_MODEL_ARCHIVED');
    await assert.rejects(flow.materializeModelNodeDataset({ ...options, body: { ...options.body, datasetName: '归档输出' } }), error => error.code === 'ANALYSIS_MODEL_ARCHIVED');
    await execute('UPDATE analysis_data_models SET archived_at=NULL WHERE id=?', [model.id]);
    await assert.rejects(flow.previewModelNode({ ...options, body: { ...options.body, expectedVersion: model.version + 1 } }), error => error.code === 'ANALYSIS_MODEL_VERSION_CONFLICT');
    const admin = await queryOne("SELECT * FROM users WHERE username='admin'");
    await assert.rejects(flow.previewModelNode({ ...options, user: admin }), error => error.status === 404);
    await execute("UPDATE analysis_data_models SET scope='shared' WHERE id=?", [model.id]);
    await assert.rejects(flow.previewModelNode({ ...options, user: admin }), error => error.code === 'ANALYSIS_MODEL_NOT_FOUND');
    const migration = require('../server/db/migrations/analysis-node-flow')[0];
    const { transaction } = require('../server/db/client');
    const legacy = await datasets.createDatasetFromRows({ user, name: '旧节点输出', rows: [{ 金额: '1' }], sourceType: 'modeled' });
    for (let attempt = 0; attempt < 2; attempt++) await transaction(trx => migration.upPg(trx));
    const legacyRow = await queryOne('SELECT truncated,source_version FROM analysis_datasets WHERE id=?', [legacy.id]);
    assert.equal(Number(legacyRow.truncated), 2); assert.equal(Number(legacyRow.source_version), 2);
    await assert.rejects(execute("INSERT INTO analysis_query_jobs(id,user_id,execution_kind,model_id,sql_text,request_key,request_hash) VALUES (?,?,'model_node_preview',?,'',?,?)", [`query_job_${crypto.randomUUID()}`, user.id, model.id, crypto.randomUUID(), 'invalid']), error => error.code === '23514');
}));

test('物化任务幂等提交且保留全部来源、部分范围、原始截止时间和不可变输出版本', { timeout: 90000 }, async () => fixture(async ({ user, model, fact }) => {
    await execute('UPDATE analysis_datasets SET truncated=1,source_row_count=500 WHERE id=?', [fact.id]);
    const dictionary = await datasets.createDatasetFromRows({ user, name: '地区字典', rows: [{ 地区: '北', 负责人: '甲' }, { 地区: '南', 负责人: '乙' }] });
    const flowGraph = { nodes: [{ id: 'dictionary', kind: 'source', config: { datasetId: dictionary.id } }, { id: 'joined', kind: 'join', config: { keyPairs: [{ leftField: '地区', rightField: '地区' }] } }],
        edges: [{ id: 'e1', fromNodeId: 'fact', toNodeId: 'joined' }, { id: 'e2', fromNodeId: 'dictionary', toNodeId: 'joined' }] };
    const options = { user, modelId: model.id, body: { ...bodyFor(model), targetNodeId: 'joined', flowGraph, datasetName: '部分订单输出' } };
    const [one, duplicate] = await Promise.all([flow.materializeModelNodeDataset(options), flow.materializeModelNodeDataset(options)]);
    assert.equal(one.id, duplicate.id);
    const completed = await finish(user, one);
    assert.equal(completed.status, 'succeeded', completed.lastError);
    const output = completed.result.dataset;
    assert.equal(output.truncated, true); assert.equal(completed.result.coverage, 'partial');
    assert.equal(completed.result.sources.length, 2); assert.equal(completed.result.sourceNames.length, 2);
    const version = await queryOne('SELECT * FROM analysis_dataset_versions WHERE dataset_id=?', [output.id]);
    const metadata = version.manifest_json;
    assert.equal(metadata.lineage.sources.length, 2);
    assert.equal(metadata.lineage.pipeline.targetNodeId, 'joined'); assert.equal(metadata.lineage.pipeline.flowGraph.nodes.length, 2);
    assert.deepEqual(new Set(metadata.lineage.sources.map(source => source.datasetId)), new Set([fact.id, dictionary.id]));
    assert.equal(Date.parse(metadata.sourceMetadata.dataUpdatedAt), Math.min(...metadata.lineage.sources.map(source => Date.parse(source.watermark.updatedAt))));
    assert.equal(metadata.sourceMetadata.coverage, 'partial');
    assert.equal((await flow.materializeModelNodeDataset(options)).result.dataset.id, output.id);
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_datasets WHERE user_id=? AND file_type='modeled'", [user.id])).n), 1);
    assert.equal((await flow.listNodeJobs(user, model.id))[0].id, one.id);
    await governance.updateFieldGovernance({ user, datasetId: output.id, fields: [{ fieldKey: 'c_1', displayName: '后续字段名称' }] });
    const historical = (await jobs.getModelJob(user, one.id)).result.dataset;
    assert.equal(historical.columns[0].name, output.columns[0].name);
    assert.equal(historical.sourceVersion, 1); assert.equal(historical.currentSourceVersion, 2);
    await assert.rejects(execute("UPDATE analysis_dataset_versions SET manifest_json='{}' WHERE id=?", [version.id]));
    const derived = await require('../server/services/data-analysis/bi/models').createProductionModel({ user, body: { name: '输出正式模型', factDatasetId: output.id } });
    await assert.rejects(require('../server/services/data-analysis/bi/manifests').captureManifest({ user, modelId: derived.id, definition: derived.definition }), error => error.code === 'ANALYSIS_MODEL_COVERAGE_INCOMPLETE');
    await execute('UPDATE analysis_datasets SET truncated=2,source_version=source_version+1 WHERE id=?', [fact.id]);
    const unknown = await finish(user, await flow.materializeModelNodeDataset({ ...options, body: { ...options.body, requestKey: crypto.randomUUID(), datasetName: '未知范围输出' } }));
    assert.equal(unknown.status, 'succeeded', unknown.lastError);
    assert.equal(unknown.result.coverage, 'unknown'); assert.equal(unknown.result.dataset.scopeUnknown, true);
    await execute("UPDATE analysis_datasets SET name='后续输出名称' WHERE id=?", [output.id]);
    assert.equal((await jobs.getModelJob(user, one.id)).result.dataset.name, '部分订单输出');
}));

test('真实 HTTP 在准备预览后停用账号时拒绝交付，任务读取不会复用旧授权', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    const completed = await finish(user, await flow.previewModelNode({ user, modelId: model.id, body: bodyFor(model) }));
    assert.equal(completed.status, 'succeeded', completed.lastError);
    assert.equal(completed.result.preview.totalRows, 3);
    await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
    const app = express();
    app.get('/', delivery.handler(async (_req, res) => res.json({ job: completed })));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
        assert.equal(response.status, 404);
        assert.equal((await response.text()).includes('100.25'), false);
        await assert.rejects(jobs.getModelJob(user, completed.id), error => error.code === 'ANALYSIS_MODEL_NOT_FOUND');
    } finally { await new Promise(resolve => server.close(resolve)); await execute("UPDATE users SET status='active' WHERE id=?", [user.id]); }
}));

async function sharedSource(run) {
    const context = await createFixture();
    let owner;
    try {
        owner = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`flow_source_${crypto.randomUUID()}`]);
        const source = await datasets.createDatasetFromRows({ user: owner, name: '共享金额', rows: [{ 金额: '100.25', 标识: 'a' }] });
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_units='QA' WHERE id=?", [source.id]);
        const body = { ...bodyFor(context.model), targetNodeId: 'input', flowGraph: { nodes: [{ id: 'input', kind: 'source', config: { datasetId: source.id } }], edges: [] }, datasetName: '权限受控输出' };
        await run({ ...context, owner, source, body });
    } finally { await cleanupUser(context.user); if (owner) await cleanupUser(owner); }
}

test('来源字段撤权阻断已准备预览的交付，也阻断 Worker 完成后的物化提交', { timeout: 90000 }, async () => sharedSource(async ({ user, model, owner, source, body }) => {
    const completed = await finish(user, await flow.previewModelNode({ user, modelId: model.id, body }));
    assert.equal(completed.status, 'succeeded', completed.lastError);
    await governance.updateFieldGovernance({ user: owner, datasetId: source.id, fields: [{ fieldKey: 'c_1', sensitivity: 'restricted' }] });
    await assert.rejects(delivery.consume(completed, () => { throw new Error('不应发送撤权后的结果'); }), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
    await governance.updateFieldGovernance({ user: owner, datasetId: source.id, fields: [{ fieldKey: 'c_1', sensitivity: 'internal' }] });
    const original = runtime.runIsolated;
    const admitted = await flow.materializeModelNodeDataset({ user, modelId: model.id, body: { ...body, requestKey: crypto.randomUUID() } });
    try {
        runtime.runIsolated = async options => {
            const result = await original(options);
            if (options.job.id === admitted.id) await governance.updateFieldGovernance({ user: owner, datasetId: source.id, fields: [{ fieldKey: 'c_1', sensitivity: 'restricted' }] });
            return result;
        };
        await runner.processModelJobs();
    } finally { runtime.runIsolated = original; }
    const row = await repository.get(user.id, admitted.id);
    assert.equal(row.status, 'failed');
    assert.equal(await queryOne('SELECT id FROM analysis_datasets WHERE id=?', [row.query_ast_json.outputDatasetId]), null);
    assert.equal(row.result_object_id, null);
    assert.equal((await flow.listNodeJobs(user, model.id))[0].status, 'failed');
}));

test('排队取消与完成边界取消均不生成输出，终态不能被迟到提交恢复成功', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    const options = { user, modelId: model.id, body: { ...bodyFor(model), datasetName: '取消输出' } };
    const queued = await flow.materializeModelNodeDataset(options);
    await jobs.cancelModelJob(user, queued.id);
    await runner.processModelJobs();
    assert.equal((await jobs.getModelJob(user, queued.id)).status, 'cancelled');
    const admitted = await flow.materializeModelNodeDataset({ ...options, body: { ...options.body, requestKey: crypto.randomUUID() } });
    const original = runtime.runIsolated;
    try {
        runtime.runIsolated = async input => {
            const result = await original(input);
            if (input.job.id === admitted.id) { await repository.cancel(user.id, admitted.id); await runner.cancelActiveModelJob(admitted.id); }
            return result;
        };
        await runner.processModelJobs();
    } finally { runtime.runIsolated = original; }
    assert.equal((await repository.get(user.id, admitted.id)).status, 'cancelled');
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_datasets WHERE user_id=? AND file_type='modeled'", [user.id])).n), 0);
}));

test('节点预览按七天策略过期清除数据载荷，物化输出仍按数据集版本保留', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    const preview = await finish(user, await flow.previewModelNode({ user, modelId: model.id, body: bodyFor(model) }));
    const output = await finish(user, await flow.materializeModelNodeDataset({ user, modelId: model.id, body: { ...bodyFor(model), datasetName: '保留输出' } }));
    assert.equal(preview.status, 'succeeded'); assert.equal(output.status, 'succeeded', output.lastError);
    await execute("UPDATE analysis_query_jobs SET completed_at=NOW()-INTERVAL '8 days' WHERE id IN (?,?)", [preview.id, output.id]);
    await require('../server/repositories/analysis-integrity').retention();
    const expired = await jobs.getModelJob(user, preview.id);
    assert.equal(expired.resultExpired, true); assert.equal(expired.result, null);
    assert.equal((await repository.get(user.id, preview.id)).result_metadata_json.preview, undefined);
    assert.equal((await jobs.getModelJob(user, output.id)).result.dataset.id, output.result.dataset.id);
}));
