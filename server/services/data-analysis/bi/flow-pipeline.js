'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { transaction } = require('../../../db/client');
const jobs = require('../../../repositories/analysis-model-jobs');
const authorization = require('../../../repositories/analysis-authorization');
const { modelForUser } = require('./access');
const { allRequired, captureManifest, resolveManifest } = require('./manifests');
const { canonicalHash, canonicalJson } = require('./canonical');
const { BI_POLICY } = require('./policy');
const { biError } = require('./errors');
const { protect } = require('./delivery');
const { FLOW_BUILTIN_FUNCTIONS, validateFlowCustomSql, invalidFlow } = require('./flow-functions');
const { normalizeFlowGraph, resolveExecutionPlan, safeId, MAX_PREVIEW_LIMIT, DEFAULT_PREVIEW_LIMIT } = require('./flow-graph');
const { normalizeDatasetName, analysisId, serializeDataset, getDatasetForUser, toProjectRelative } = require('../shared');

const isNodeJob = row => ['model_node_preview', 'model_node_dataset'].includes(row?.execution_kind);

function authorizeFlow(userId, modelId, definition, { write = false, active = false } = {}) {
    return async trx => {
        const current = await authorization.authorize(trx, { userId, modelId, definition, required: allRequired(definition), write });
        if (active && current.model.archived_at) throw biError('ANALYSIS_MODEL_ARCHIVED', '模型已归档，请恢复后再运行节点。', 409);
        return current;
    };
}

function normalizeDefinitionNodes(value) {
    if (!Array.isArray(value) || value.length > 9) invalidFlow('模型来源节点格式无效或超过九个，请重新加载草稿。');
    const ids = new Set();
    return value.map(node => {
        if (!node || typeof node !== 'object' || !['fact', 'dimension'].includes(node.role)) invalidFlow('模型来源节点角色无效。');
        const id = safeId(node.id, '模型节点');
        if (ids.has(id)) invalidFlow('模型来源节点标识不能重复。');
        ids.add(id);
        return { id, datasetId: safeId(node.datasetId, '来源数据集'), role: node.role, name: String(node.name || id).slice(0, 120) };
    });
}

async function submitNodeJob({ user, modelId, body }, materialize) {
    await require('./readiness').ensureReady({ batch: materialize });
    if (Buffer.byteLength(canonicalJson(body), 'utf8') > 512 * 1024) invalidFlow('节点请求超过大小上限，请精简算子配置。');
    const model = await modelForUser(user, modelId, { write: materialize });
    if (Number(model.user_id) !== Number(user.id) && !model.published_version) throw biError('ANALYSIS_MODEL_NOT_FOUND', '数据模型尚未发布或无权访问。', 404);
    const definitionNodes = normalizeDefinitionNodes(body.definitionNodes ?? model.definition_json.nodes);
    const flowGraph = normalizeFlowGraph(body.flowGraph || { nodes: [], edges: [] }, { definitionNodeIds: new Set(definitionNodes.map(node => node.id)), strict: materialize });
    const targetNodeId = safeId(body.targetNodeId, '运行目标节点');
    const plan = resolveExecutionPlan(targetNodeId, definitionNodes, flowGraph);
    for (const node of plan.ordered) if (node.kind === 'sql') validateFlowCustomSql(node.config.sql);
    const datasetIds = [...new Set(plan.ordered.filter(node => node.isDefinitionNode || node.kind === 'source').map(node => safeId(node.datasetId || node.config.datasetId, '来源数据集')))];
    const flowDefinition = { normalizationVersion: BI_POLICY.normalizationVersion, timezone: model.definition_json.timezone || BI_POLICY.defaultTimezone,
        coveragePolicy: 'partial', watermarkPolicy: 'independent', relations: [], metrics: [], dimensions: [],
        nodes: datasetIds.map((datasetId, index) => ({ id: `source_${index}`, datasetId, grainKeys: [], role: index ? 'dimension' : 'fact' })) };
    const initial = await transaction(authorizeFlow(user.id, modelId, flowDefinition, { write: materialize, active: true }));
    for (const node of flowDefinition.nodes) {
        const columns = initial.sources[node.id].columns;
        if (!columns.length) invalidFlow('节点来源没有可访问字段，请检查共享权限。');
        flowDefinition.dimensions.push(...columns.map((column, index) => ({ id: `${node.id}_field_${index}`, nodeId: node.id, fieldKey: column.key })));
    }
    const limit = body.limit ?? DEFAULT_PREVIEW_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PREVIEW_LIMIT) invalidFlow('节点预览行数须为一至二百之间的整数。');
    if (materialize && (typeof body.datasetName !== 'string' || !body.datasetName.trim() || body.datasetName.length > 80)) invalidFlow('输出数据集名称不能为空且不能超过八十字。');
    const query = { flowDefinition, definitionNodes, flowGraph, targetNodeId, limit, draftRevision: body.expectedVersion,
        ...(materialize ? { datasetName: normalizeDatasetName('', body.datasetName) } : {}) };
    if (!Number.isSafeInteger(query.draftRevision) || query.draftRevision < 1) invalidFlow('请携带有效的草稿修订号，重新加载后再运行。');
    query.configHash = canonicalHash(query);
    if (!body.requestKey) throw biError('ANALYSIS_MODEL_REQUEST_KEY_REQUIRED', '节点运行已采用任务模式，请刷新页面后重试，并保留请求标识用于查询与重试。');
    const requestKey = require('./query-contract').requestKey(body.requestKey);
    const row = await jobs.admit({ userId: user.id, modelId, kind: materialize ? 'model_node_dataset' : 'model_node_preview', expectedVersion: query.draftRevision,
        requestKey, requestHash: query.configHash, query: { ...query, ...(materialize ? { outputDatasetId: analysisId('ds') } : {}) },
        authorize: authorizeFlow(user.id, modelId, flowDefinition, { write: materialize, active: true }) });
    return getNodeJob(user, row);
}

async function getNodeJob(user, row) {
    const definition = row.query_ast_json.flowDefinition;
    const current = await transaction(authorizeFlow(user.id, row.model_id, definition));
    const result = require('./jobs').jobRecord(row);
    if (result.result) result.result = { ...result.result, sourceNames: definition.nodes.map(node => ({ nodeId: node.id, datasetId: node.datasetId, name: current.sources[node.id].dataset.name })) };
    result.node = { targetNodeId: row.query_ast_json.targetNodeId, configHash: row.query_ast_json.configHash, draftRevision: row.query_ast_json.draftRevision, requestKey: row.request_key };
    if (row.manifest_id) {
        const repository = require('../../../repositories/analysis-manifests');
        const manifest = await repository.get(row.manifest_id), members = await repository.members(row.manifest_id);
        if (!manifest || canonicalHash(manifest.manifest_json) !== manifest.manifest_hash || members.length !== definition.nodes.length || members.some(member => member.object_state !== 'ready')) throw biError('ANALYSIS_MODEL_SOURCE_UNAVAILABLE', '节点来源清单不可用，请重新运行或联系维护者。', 409);
    }
    if (result.result?.datasetId) {
        const dataset = await getDatasetForUser(user.id, result.result.datasetId);
        const version = await require('../../../repositories/analysis-flow-datasets').outputVersion(dataset.id, row.id);
        const snapshot = version?.manifest_json?.output;
        if (!snapshot?.columns?.length || version.manifest_json.objectId !== row.result_object_id) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '节点输出版本缺失或不一致，请重新运行。', 409);
        const descriptor = { userId: user.id, definition: { nodes: [{ id: 'output', datasetId: dataset.id }] }, required: new Map([['output', new Set(snapshot.columns.map(column => column.key))]]),
            beforeSend: async trx => {
                const current = await require('../../../repositories/analysis-flow-datasets').outputVersion(dataset.id, row.id, trx);
                if (current?.id !== version.id) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '节点输出版本已不可用，请重新运行。', 409);
            } };
        await transaction(trx => authorization.authorize(trx, descriptor));
        const coverage = version.manifest_json.sourceMetadata.coverage;
        result.result = { ...result.result, dataset: protect({ ...serializeDataset({ ...dataset, name: snapshot.name, row_count: version.row_count, column_count: version.column_count,
            source_row_count: version.row_count, source_column_count: version.column_count, source_version: version.version, file_size: version.manifest_json.byteLength,
            truncated: coverage === 'full' ? 0 : coverage === 'unknown' ? 2 : 1, columns_json: snapshot.columns, profile_json: snapshot.profile, preview_json: snapshot.previewRows,
            created_at: version.created_at, updated_at: version.created_at }), outputVersion: Number(version.version), currentSourceVersion: Number(dataset.source_version) }, descriptor) };
    }
    return protect(result, { userId: user.id, modelId: row.model_id, definition, required: allRequired(definition),
        beforeSend: trx => require('../../../repositories/analysis-authorized-delivery').job(trx, row, definition.nodes.length) });
}

async function listNodeJobs(user, modelId) {
    await modelForUser(user, modelId);
    const result = (await jobs.listNodeJobs(user.id, modelId)).map(row => ({ id: row.id, executionKind: row.execution_kind, status: row.status,
        progress: Number(row.progress), lastError: row.last_error, createdAt: row.created_at, node: { targetNodeId: row.target_node_id } }));
    return protect(result, { userId: user.id, modelId, definition: { nodes: [] }, required: new Map() });
}

function sourceMetadata(manifest) {
    const members = manifest.members;
    const same = values => values.length && values.every(value => value && value === values[0]) ? values[0] : '';
    const dates = members.map(member => Date.parse(member.watermark.updatedAt));
    return { coverage: manifest.coverage, inputBatchId: same(members.map(member => member.inputBatchId)), businessPeriod: same(members.map(member => member.watermark.period)),
        dataUpdatedAt: dates.every(Number.isFinite) ? new Date(Math.min(...dates)).toISOString() : '' };
}

async function executeNodeJob(job, { outputRoot, signal }) {
    const started = performance.now(), query = job.query_ast_json, definition = query.flowDefinition;
    const materialize = job.execution_kind === 'model_node_dataset';
    const user = { id: Number(job.user_id) }, authorize = authorizeFlow(user.id, job.model_id, definition, { write: materialize, active: true });
    await transaction(authorize);
    let retained;
    const objectRepository = require('../../../repositories/analysis-objects');
    try {
        if (!job.manifest_id) {
            const manifest = await captureManifest({ user, modelId: job.model_id, definition, signal, write: materialize });
            if (!await jobs.attachManifest(job, manifest.id)) throw biError('ANALYSIS_MODEL_LEASE_LOST', '节点执行租约已失效。', 409);
            job.manifest_id = manifest.id;
        }
        retained = await resolveManifest({ user, modelId: job.model_id, definition, manifestId: job.manifest_id, allFields: true, leaseId: `${job.id}:${job.execution_epoch}`, seconds: 600 });
        const inputResolutionMs = Math.ceil(performance.now() - started);
        const output = await require('./runtime').runIsolated({ job, definition, query, sources: retained.sources, outputRoot, signal });
        if (signal.aborted) throw biError('ANALYSIS_MODEL_QUERY_CANCELLED', '节点执行已取消，未登记输出。', 409);
        const result = { ...(!materialize ? output.result : {}), configHash: query.configHash, manifestId: job.manifest_id, coverage: retained.snapshot.coverage,
            dataTimes: retained.snapshot.members.map(member => ({ nodeId: member.nodeId, ...member.watermark })),
            sources: retained.snapshot.members.map(member => ({ nodeId: member.nodeId, datasetId: member.datasetId, datasetVersionId: member.datasetVersionId, dataVersion: member.dataVersion, sourceRevision: member.sourceRevision, coverage: member.coverage, watermark: member.watermark })) };
        let object = null;
        if (materialize) {
            object = await require('./objects').importFile({ file: path.join(outputRoot, 'dataset.parquet'), userId: user.id, purpose: 'source', leaseId: `${job.id}:result`, maxBytes: 2 * 1024 ** 3, signal });
            Object.assign(result, { datasetId: query.outputDatasetId, rowCount: output.result.rowCount });
        }
        const parquetPath = object ? toProjectRelative(await require('./objects').verify(object)) : null;
        const registrationStarted = performance.now();
        const committed = await jobs.complete(job, { result, resultObject: object, runtimeMetrics: { ...output.runtimeMetrics, inputResolutionMs, resultRegistrationMs: Math.ceil(performance.now() - registrationStarted) },
            authorize: async trx => {
                const current = await authorize(trx);
                if (materialize) await require('../../../repositories/analysis-flow-datasets').insertFlowDataset(trx, { id: query.outputDatasetId, userId: user.id, name: query.datasetName,
                    parquetPath, object, output: output.result, sourceMetadata: sourceMetadata(retained.snapshot),
                    lineage: { modelId: job.model_id, runId: job.id, targetNodeId: query.targetNodeId, configHash: query.configHash,
                        pipeline: { definitionNodes: query.definitionNodes, flowGraph: query.flowGraph, targetNodeId: query.targetNodeId }, sources: retained.snapshot.members }, parentDatasetId: retained.snapshot.members[0]?.datasetId });
                return current;
            } });
        if (!committed) throw biError('ANALYSIS_MODEL_LEASE_LOST', '节点完成时租约已失效，未登记输出。', 409);
    } finally {
        if (retained) await objectRepository.release('lease', retained.leaseId);
        await objectRepository.release('lease', `${job.id}:result`);
    }
}

module.exports = { FLOW_BUILTIN_FUNCTIONS, normalizeFlowGraph, isNodeJob, getNodeJob, listNodeJobs, executeNodeJob,
    previewModelNode: options => submitNodeJob(options, false), materializeModelNodeDataset: options => submitNodeJob(options, true) };
