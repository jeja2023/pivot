'use strict';

const { transaction } = require('../../../db/client');
const origins = require('../../../repositories/analysis-model-origins');
const authorization = require('../../../repositories/analysis-authorization');
const { canAccessSharedResource } = require('../../unit-visibility');
const { analysisId, jsonParse } = require('../shared');
const { canonicalHash, canonicalJson } = require('./canonical');
const { normalizeModelDefinition } = require('./definition');
const { allRequired } = require('./manifests');
const { requestKey } = require('./query-contract');
const { biError } = require('./errors');

function invalid(message) { throw biError('ANALYSIS_MODEL_MIGRATION_INVALID', message); }
function text(value, max, label, required = true) { if (typeof value !== 'string' || value.length > max || value.includes('\u0000') || required && !value.trim()) invalid(`${label}格式无效，请检查后重试。`); return value.trim(); }
function skeleton(relations) {
    const ids = [...new Set(relations.flatMap(row => [row.left_dataset_id, row.right_dataset_id]))];
    if (!ids.length || ids.length > 9 || relations.length > 8) invalid('旧探索需要一至八条关联且不超过九个来源，请先拆分探索后再迁移。');
    return { nodes: ids.map((datasetId, index) => ({ id: `n${index}`, datasetId, grainKeys: [] })), relations: [], dimensions: [], metrics: [] };
}
async function inventory(trx, user, modelId) {
    await authorization.lockPrincipals(trx, [user.id]);
    const raw = await origins.inventory(trx, modelId), base = skeleton(raw.relations);
    const current = await authorization.authorize(trx, { userId: user.id, definition: base, required: new Map() });
    if (!canAccessSharedResource(raw.model, current.user, true)) throw biError('ANALYSIS_MODEL_NOT_FOUND', '旧探索模型不存在或无权迁移。', 404);
    const metrics = raw.metrics.filter(row => canAccessSharedResource(row, current.user));
    if (metrics.length > 999 || raw.views.length > 1000 || raw.versions.length > 1000) invalid('旧资产数量超过单次迁移清单上限，请先整理后再迁移。');
    const relations = raw.relations.map((row, index) => ({ id: `r${index}`, sourceId: row.id, leftNodeId: base.nodes.find(node => node.datasetId === row.left_dataset_id).id, rightNodeId: base.nodes.find(node => node.datasetId === row.right_dataset_id).id,
        leftDatasetId: row.left_dataset_id, rightDatasetId: row.right_dataset_id, leftFieldKey: row.left_field_key, rightFieldKey: row.right_field_key, joinType: row.join_type, cardinality: row.cardinality, status: row.status }));
    const unavailable = [];
    for (const relation of relations) for (const [nodeId, fieldKey] of [[relation.leftNodeId, relation.leftFieldKey], [relation.rightNodeId, relation.rightFieldKey]]) if (!current.sources[nodeId].columns.some(column => column.key === fieldKey)) unavailable.push({ sourceId: relation.sourceId, message: '关联字段缺失或当前无权访问。' });
    const snapshot = { sourceModelId: modelId, sourceName: raw.model.name, sourceRevision: Number(raw.model.version),
        nodes: base.nodes.map(node => ({ ...node, name: current.sources[node.id].dataset.name, columns: current.sources[node.id].columns, sourceRevision: String(current.sources[node.id].dataset.source_version), currentRowCount: String(current.sources[node.id].dataset.row_count), versions: raw.versions.filter(row => row.dataset_id === node.datasetId), currentVersionRegistered: raw.versions.some(row => row.dataset_id === node.datasetId) })),
        relations, metrics: metrics.map(row => ({ sourceId: row.id, sourceRevision: Number(row.version), datasetId: row.dataset_id, name: row.name, description: row.description || '', config: jsonParse(row.metric_config_json, {}), unit: row.unit || '', validFrom: row.valid_from, validTo: row.valid_to })),
        views: raw.views.filter(row => Number(row.user_id) === Number(user.id)).map(row => ({ id: row.id, name: row.name, datasetId: row.dataset_id, version: Number(row.version), sourceType: row.source_type })), unavailable };
    if (Buffer.byteLength(canonicalJson(snapshot)) > 1024 * 1024) invalid('旧探索盘点超过一 MiB，请拆分探索后再创建正式草稿。');
    return { snapshot, snapshotHash: canonicalHash(snapshot), current };
}
async function migrationInventory({ user, modelId }) { return transaction(async trx => { const { snapshot, snapshotHash } = await inventory(trx, user, modelId); return { snapshot, snapshotHash }; }); }

function convert(snapshot, body, userId) {
    const fact = snapshot.nodes.find(node => node.datasetId === body.factDatasetId);
    if (!fact || !Array.isArray(body.grainKeys) || !body.grainKeys.length || body.grainKeys.some(key => !fact.columns.some(column => column.key === key))) invalid('请选择旧探索中的事实表和实际粒度字段。');
    const nodes = snapshot.nodes.map(node => ({ id: node.id, datasetId: node.datasetId, name: node.name, role: node.id === fact.id ? 'fact' : 'dimension', grainKeys: node.id === fact.id ? body.grainKeys : [...new Set(snapshot.relations.filter(relation => relation.rightNodeId === node.id).map(relation => relation.rightFieldKey))] }));
    const dimensions = snapshot.nodes.flatMap(node => node.columns.map((column, index) => ({ id: `d_${node.id}_${index}`, nodeId: node.id, fieldKey: column.key, name: `${node.name} · ${column.name}` })));
    const metrics = [{ id: 'records', name: '事实记录数', type: 'count', maintainerId: userId }, ...snapshot.metrics.map((metric, index) => {
        const config = metric.config, node = nodes.find(item => item.datasetId === metric.datasetId);
        return { id: `legacy_metric_${index}`, name: metric.name, description: metric.description, type: config.aggregation,
            ...(config.fieldKey && config.aggregation !== 'count' ? { field: { nodeId: node.id, fieldKey: config.fieldKey } } : {}), unit: metric.unit, maintainerId: userId,
            ...(metric.validFrom ? { validFrom: new Date(metric.validFrom).toISOString() } : {}), ...(metric.validTo ? { validTo: new Date(metric.validTo).toISOString() } : {}) };
    })];
    const relations = snapshot.relations.map(relation => ({ id: relation.id, leftNodeId: relation.leftNodeId, rightNodeId: relation.rightNodeId, joinType: relation.joinType, cardinality: relation.cardinality,
        keyPairs: [{ leftFieldKey: relation.leftFieldKey, rightFieldKey: relation.rightFieldKey }] }));
    return normalizeModelDefinition({ nodes, relations, dimensions, metrics, grainDescription: text(body.grainDescription, 1000, '事实粒度说明') }, { complete: false });
}
async function migrateExploration({ user, modelId, body }) {
    const key = requestKey(body.requestKey), request = { expectedVersion: body.expectedVersion, snapshotHash: body.snapshotHash, factDatasetId: body.factDatasetId, grainKeys: body.grainKeys,
        grainDescription: body.grainDescription, name: text(body.name, 120, '新模型名称'), businessOwner: text(body.businessOwner || '', 120, '业务负责人', false), maintenanceContact: text(body.maintenanceContact || '', 240, '维护联系人', false) };
    const row = await origins.create({ userId: user.id, sourceModelId: modelId, requestKey: key, requestHash: canonicalHash(request), prepare: async trx => {
        const { snapshot, snapshotHash } = await inventory(trx, user, modelId);
        if (snapshotHash !== body.snapshotHash || snapshot.sourceRevision !== body.expectedVersion) throw biError('ANALYSIS_MODEL_MIGRATION_CHANGED', '旧探索或来源清单已变化，请重新盘点并确认。', 409);
        if (snapshot.unavailable.length) invalid('旧探索包含缺失或无权字段，请先恢复字段或调整旧探索。');
        const normalized = convert(snapshot, body, Number(user.id));
        return { id: analysisId('model'), userId: user.id, name: request.name, description: `由关联探索“${snapshot.sourceName}”创建的正式草稿`, businessOwner: request.businessOwner, maintenanceContact: request.maintenanceContact, ...normalized, snapshot, snapshotHash,
            authorize: db => authorization.authorize(db, { userId: user.id, definition: normalized.definition, required: allRequired(normalized.definition) }) };
    } });
    return (await require('./models').getProductionModel(user, row.id)).model;
}
function comparisonRequired(definition, comparison, required) {
    if (!comparison) return required;
    for (const old of comparison.snapshot.nodes) {
        const node = definition.nodes.find(item => item.datasetId === old.datasetId);
        if (!node || node.id !== old.id) invalid('首次发布对照需要保留旧探索的全部来源和节点标识；请恢复来源后检查。');
        if (!required.has(node.id)) required.set(node.id, new Set());
    }
    for (const relation of comparison.snapshot.relations) {
        required.get(relation.leftNodeId).add(relation.leftFieldKey); required.get(relation.rightNodeId).add(relation.rightFieldKey);
    }
    for (const metricId of comparison.metrics) {
        const match = metricId.match(/^legacy_metric_(\d+)$/), metric = match && comparison.snapshot.metrics[Number(match[1])];
        if (metric?.config.fieldKey && metric.config.aggregation !== 'count') required.get(comparison.snapshot.nodes.find(node => node.datasetId === metric.datasetId).id).add(metric.config.fieldKey);
    }
    return required;
}
async function comparisonRequest(model, definition, input) {
    const origin = await origins.get(model.id);
    if (!origin || model.published_version) { if (input) invalid('仅迁移模型首次发布前需要旧探索对照。'); return null; }
    if (!input || !Array.isArray(input.dimensions) || !Array.isArray(input.metrics) || input.dimensions.length < 1 || input.dimensions.length > 5 || !input.metrics.length || input.metrics.length > 10 || new Set(input.dimensions).size !== input.dimensions.length || new Set(input.metrics).size !== input.metrics.length) invalid('请选择一至五个对照维度和一至十个基础指标。');
    if (input.dimensions.some(id => !definition.dimensions.some(item => item.id === id)) || input.metrics.some(id => !definition.metrics.some(item => item.id === id && ['count', 'sum', 'avg', 'min', 'max'].includes(item.type)))) invalid('旧探索对照仅支持事实记录数、求和、平均、最小及最大指标；去重和派生口径请通过正式试算另行核对。');
    const originalNodes = new Set(origin.snapshot_json.nodes.map(node => node.id));
    if (input.dimensions.some(id => !originalNodes.has(definition.dimensions.find(item => item.id === id).nodeId)) || input.metrics.some(id => { const field = definition.metrics.find(item => item.id === id).field; return field && !originalNodes.has(field.nodeId); })) invalid('对照维度及基础指标必须来自原探索来源；请改选原来源字段后核对新增来源的影响。');
    if (definition.metrics.some(item => ['sum', 'avg', 'min', 'max'].includes(item.type)) && !input.metrics.some(id => definition.metrics.some(item => item.id === id && ['sum', 'avg', 'min', 'max'].includes(item.type)))) invalid('模型包含数值指标，请至少选择一个数值指标核对金额或汇总值。');
    const result = { snapshot: origin.snapshot_json, snapshotHash: origin.snapshot_hash, dimensions: input.dimensions, metrics: input.metrics };
    comparisonRequired(definition, result, new Map());
    return result;
}
module.exports = { migrationInventory, migrateExploration, comparisonRequest, comparisonRequired, convert };
