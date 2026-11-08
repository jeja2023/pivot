'use strict';

const crypto = require('node:crypto');
const { transaction } = require('../../../db/client');
const authorization = require('../../../repositories/analysis-authorization');
const repository = require('../../../repositories/analysis-manifests');
const objectRepository = require('../../../repositories/analysis-objects');
const objects = require('./objects');
const { getDatasetPaths, jsonParse } = require('../shared');
const { requiredFields } = require('./access');
const { canonicalHash } = require('./canonical');
const { biError } = require('./errors');
const { contractHash } = require('./source-contract');
const { versionSourceMetadata } = require('./source-metadata');

function allRequired(definition) {
    const result = requiredFields(definition);
    for (const dimension of definition.dimensions) result.addDimension(dimension.id);
    for (const metric of definition.metrics) { result.add(metric.field); result.add(metric.currencyField); result.addFilters(metric.filters); }
    return result.fields;
}

async function captureManifest({ user, modelId, definition, fault, signal, comparison = null }) {
    const required = allRequired(definition);
    require('./migration').comparisonRequired(definition, comparison, required);
    const authorize = trx => authorization.authorize(trx, { userId: user.id, modelId, definition, required, write: true });
    const initial = await transaction(authorize), prepared = Object.create(null), leaseId = `capture_${crypto.randomUUID()}`;
    let capturedBytes = 0;
    try {
        for (const node of definition.nodes) {
            if (signal?.aborted) throw biError('ANALYSIS_MODEL_QUERY_CANCELLED', '固定数据来源已取消。', 409);
            const source = initial.sources[node.id], dataset = source.dataset;
            const remaining = 2 * 1024 ** 3 - capturedBytes;
            if (remaining <= 0) throw biError('ANALYSIS_MODEL_CAPACITY_EXCEEDED', '模型输入总量超过二 GiB，请缩小数据范围或采用专门分析适配方案。', 413);
            const object = await objects.importFile({ file: getDatasetPaths(dataset).parquetPath, userId: user.id, leaseId, maxBytes: remaining, fault, signal });
            capturedBytes += Number(object.byte_length);
            const columnKeys = source.columns.map(column => column.key);
            const governance = source.governance.map(field => ({ fieldKey: field.field_key, logicalType: field.logical_type, unit: field.unit, dateFormat: field.date_format, status: field.status, metadata: jsonParse(field.metadata_json, {}) }));
            const metadata = versionSourceMetadata(dataset, source.version);
            prepared[node.id] = { object, originalPath: dataset.parquet_path, sourceRevision: String(dataset.source_version || 1), columnsHash: canonicalHash(columnKeys),
                columns: source.columns.map(column => ({ key: column.key, name: column.name })), schemaHash: canonicalHash(columnKeys), governanceHash: canonicalHash(governance),
                semanticSourceHash: contractHash(definition, node.id, source), sourceMetadataHash: canonicalHash(metadata), datasetVersionId: source.version?.id || null,
                inputBatchId: metadata.inputBatchId, watermark: { updatedAt: metadata.dataUpdatedAt, period: metadata.businessPeriod }, coverage: metadata.coverage };
        }
        await fault?.('objects_prepared');
        const manifest = await repository.register({ userId: user.id, definition, prepared, authorize });
        await fault?.('manifest_registered');
        return manifest;
    } finally { await objectRepository.release('lease', leaseId); }
}

async function resolveManifest({ user, modelId, definition, manifestId, query = null, leaseId = crypto.randomUUID(), seconds = 120, allFields = false, comparison = null }) {
    const required = allFields ? allRequired(definition) : requiredFields(definition, query).fields;
    require('./migration').comparisonRequired(definition, comparison, required);
    const current = await transaction(trx => authorization.authorize(trx, { userId: user.id, modelId, definition, required }));
    const manifest = await repository.retain(manifestId, leaseId, seconds);
    const snapshot = jsonParse(manifest.manifest_json, {}), rows = await repository.members(manifestId);
    const sources = Object.create(null);
    try {
        if (rows.length !== definition.nodes.length || !Array.isArray(snapshot.members) || snapshot.members.length !== rows.length || canonicalHash(snapshot) !== manifest.manifest_hash) throw biError('ANALYSIS_MODEL_MANIFEST_CORRUPTED', '来源清单不完整或校验失败，请重新检查。', 409);
        for (const node of definition.nodes) {
            const row = rows.find(item => item.node_id === node.id), member = snapshot.members.find(item => item.nodeId === node.id);
            if (!row || !member || row.dataset_id !== node.datasetId || member.objectId !== row.object_id || member.digest !== row.digest || member.byteLength !== String(row.byte_length)) throw biError('ANALYSIS_MODEL_MANIFEST_CORRUPTED', '模型与来源清单不匹配，请重新检查。', 409);
            const file = await objects.verify({ ...row, id: row.object_id, user_id: row.object_user_id, state: row.object_state });
            const allowed = new Set(current.sources[node.id].columns.map(column => column.key));
            sources[node.id] = { file, tableName: `bi_input_${definition.nodes.indexOf(node)}`, columns: member.columns.filter(column => allowed.has(column.key)), objectId: row.object_id };
        }
        return { manifest, snapshot, sources, current, leaseId };
    } catch (error) { await objectRepository.release('lease', leaseId); throw error; }
}

module.exports = { captureManifest, resolveManifest, allRequired };
