'use strict';

const crypto = require('node:crypto');
const { transaction } = require('../db/client');
const authorization = require('./analysis-authorization');
const { biError } = require('../services/data-analysis/bi/errors');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');
const { normalizeSourceMetadata, versionSourceMetadata } = require('../services/data-analysis/bi/source-metadata');

async function visible(trx, userId, datasetId, write = false) {
    await require('./analysis-release-controls').readLock(trx);
    await authorization.lockPrincipals(trx, [userId]);
    if (write) await trx.queryOne("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:authorization'),hashtext(?))", [`dataset:${datasetId}`]);
    const current = await authorization.authorize(trx, { userId, definition: { nodes: [{ id: 'source', datasetId }] }, required: new Map() });
    const source = current.sources.source;
    if (write && Number(source.dataset.user_id) !== Number(userId)) throw biError('ANALYSIS_MODEL_NOT_FOUND', '数据集不存在或只有所有者可修改来源业务信息。', 404);
    return source;
}

function publicMetadata(source, userId) {
    return { datasetId: source.dataset.id, sourceRevision: String(source.dataset.source_version), versionId: source.version?.id || null,
        canEdit: Number(source.dataset.user_id) === Number(userId), metadata: versionSourceMetadata(source.dataset, source.version) };
}

async function get(userId, datasetId) { return transaction(async trx => publicMetadata(await visible(trx, userId, datasetId), userId)); }

async function save(userId, datasetId, body) {
    const metadata = normalizeSourceMetadata(body.metadata);
    if (!/^[1-9]\d{0,15}$/.test(String(body.expectedSourceRevision))) throw biError('ANALYSIS_SOURCE_METADATA_INVALID', '请先重新加载当前来源版本再保存。');
    return transaction(async trx => {
        const source = await visible(trx, userId, datasetId, true), dataset = source.dataset;
        if (String(dataset.source_version) !== String(body.expectedSourceRevision)) throw biError('ANALYSIS_SOURCE_CHANGED', '来源版本已变化，请重新加载后核对业务信息。', 409);
        await trx.queryOne("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:dataset-version'),hashtext(?))", [datasetId]);
        const previous = versionSourceMetadata(dataset, source.version), value = { ...metadata, dataUpdatedAt: metadata.dataUpdatedAt || previous.dataUpdatedAt };
        if (canonicalHash(value) === canonicalHash(previous)) return publicMetadata(source, userId);
        const next = await trx.queryOne('SELECT GREATEST(COALESCE(MAX(version),0),?::bigint)+1 AS next FROM analysis_dataset_versions WHERE dataset_id=?', [dataset.source_version, datasetId]);
        const versionId = `dsv_${crypto.randomUUID()}`, oldManifest = typeof source.version?.manifest_json === 'string' ? JSON.parse(source.version.manifest_json) : source.version?.manifest_json || {};
        const version = await trx.queryOne(`INSERT INTO analysis_dataset_versions(id,dataset_id,user_id,version,operation,parquet_path,source_path,row_count,column_count,manifest_json)
            VALUES (?,?,?,?,'source_metadata',?,?,?,?,?::jsonb) RETURNING *`, [versionId, datasetId, userId, next.next, dataset.parquet_path, dataset.source_path || '', dataset.row_count, dataset.column_count,
            JSON.stringify({ ...oldManifest, sourceMetadata: value, previousVersionId: source.version?.id || null })]);
        const objectIds = [oldManifest.objectId, oldManifest.inputObjectId].filter(Boolean);
        if (objectIds.length) await require('./analysis-objects').pin([...new Set(objectIds)], { kind: 'manifest', referenceId: `dataset-version:${versionId}` }, trx);
        const updated = await trx.queryOne('UPDATE analysis_datasets SET source_version=?,active_version=?,updated_at=NOW() WHERE id=? RETURNING *', [next.next, next.next, datasetId]);
        await require('./analysis-production-models').audit(trx, { userId, modelId: null, action: 'source_metadata_updated', details: { datasetId, versionId, sourceRevision: String(next.next), metadata: value } });
        return publicMetadata({ dataset: updated, version }, userId);
    });
}

module.exports = { get, save };
