'use strict';

const crypto = require('node:crypto');
const { transaction } = require('../db/client');
const authorization = require('./analysis-authorization');
const objects = require('./analysis-objects');
const { biError } = require('../services/data-analysis/bi/errors');
const { versionSourceMetadata } = require('../services/data-analysis/bi/source-metadata');

async function sourceForOwner(trx, userId, datasetId, write = false) {
    await require('./analysis-release-controls').readLock(trx);
    await authorization.lockPrincipals(trx, [userId]);
    if (write) await trx.queryOne("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:authorization'),hashtext(?))", [`dataset:${datasetId}`]);
    const current = await authorization.authorize(trx, { userId, definition: { nodes: [{ id: 'source', datasetId }] }, required: new Map() });
    const source = current.sources.source;
    if (Number(source.dataset.user_id) !== Number(userId)) throw biError('ANALYSIS_MODEL_NOT_FOUND', '数据集不存在或无权追加数据。', 404);
    return source;
}

function originalResult(version) {
    const manifest = version.manifest_json;
    return { datasetId: version.dataset_id, sourceVersion: Number(version.version), appendedRows: Number(manifest.appendedRows), totalRows: Number(version.row_count), inputBatchId: manifest.inputBatchId, reused: true };
}

async function previousBatch(trx, datasetId, input) {
    const version = await trx.queryOne("SELECT * FROM analysis_dataset_versions WHERE dataset_id=? AND operation='append' AND manifest_json->>'inputBatchId'=? LIMIT 1", [datasetId, input.batchId]);
    if (!version) return null;
    if (version.manifest_json.inputDigest !== input.digest || String(version.manifest_json.inputBytes) !== String(input.bytes)) throw biError('ANALYSIS_INCREMENTAL_BATCH_CONFLICT', '同一追加批次已用于其他文件内容，请核对批次和原文件。', 409);
    return originalResult(version);
}

async function inspect(userId, datasetId, input) {
    return transaction(async trx => {
        const source = await sourceForOwner(trx, userId, datasetId), duplicate = await previousBatch(trx, datasetId, input);
        if (!duplicate && input.expectedSourceRevision !== null && String(source.dataset.source_version) !== input.expectedSourceRevision) throw biError('ANALYSIS_SOURCE_CHANGED', '来源版本已变化，请重新加载后追加。', 409);
        return { ...source, duplicate };
    });
}

async function commit({ userId, datasetId, before, input, object, inputObject, baseObject, parquetPath, rowCount, columns, profile, previewRows, ingest, sourceMetadata, job }) {
    return transaction(async trx => {
        await require('./analysis-release-controls').readLock(trx);
        if (!job || job.execution_kind !== 'legacy_operation' || Number(job.user_id) !== Number(userId) || !await require('./analysis-model-jobs').owned(trx, job)) throw biError('ANALYSIS_MODEL_LEASE_LOST', '追加执行已取消或租约失效，未登记数据版本。', 409);
        const current = await sourceForOwner(trx, userId, datasetId, true), dataset = current.dataset;
        const duplicate = await previousBatch(trx, datasetId, input);
        if (duplicate) return duplicate;
        if (String(dataset.source_version) !== String(before.dataset.source_version) || dataset.parquet_path !== before.dataset.parquet_path) throw biError('ANALYSIS_SOURCE_CHANGED', '准备追加期间数据或字段已变化，未修改当前版本，请重新加载后重试。', 409);
        await trx.queryOne("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:dataset-version'),hashtext(?))", [datasetId]);
        if (!current.version) {
            const baseId = `dsv_${crypto.randomUUID()}`;
            await objects.pin([baseObject.id], { kind: 'manifest', referenceId: `dataset-version:${baseId}` }, trx);
            await trx.execute(`INSERT INTO analysis_dataset_versions(id,dataset_id,user_id,version,operation,parquet_path,source_path,row_count,column_count,manifest_json)
                VALUES (?,?,?,?,'import',?,?,?,?,?::jsonb)`, [baseId, datasetId, userId, dataset.source_version, dataset.parquet_path, dataset.source_path || '', dataset.row_count, dataset.column_count,
                JSON.stringify({ objectId: baseObject.id, digest: baseObject.digest, recovered: true, sourceMetadata: versionSourceMetadata(dataset, null) })]);
        }
        const next = await trx.queryOne('SELECT GREATEST(COALESCE(MAX(version),0),?::bigint)+1 AS next FROM analysis_dataset_versions WHERE dataset_id=?', [dataset.source_version, datasetId]);
        const versionId = `dsv_${crypto.randomUUID()}`;
        await objects.pin([object.id, inputObject.id], { kind: 'manifest', referenceId: `dataset-version:${versionId}` }, trx);
        await trx.execute(`INSERT INTO analysis_dataset_versions(id,dataset_id,user_id,version,operation,parquet_path,row_count,column_count,manifest_json)
            VALUES (?,?,?,?,'append',?,?,?,?::jsonb)`, [versionId, datasetId, userId, next.next, parquetPath, rowCount, columns.length,
            JSON.stringify({ inputBatchId: input.batchId, inputDigest: input.digest, inputBytes: String(input.bytes), inputObjectId: inputObject.id, appendedRows: Number(ingest.rowCount), objectId: object.id, digest: object.digest, sourceMetadata })]);
        const truncated = sourceMetadata.coverage === 'unknown' ? 2 : sourceMetadata.coverage === 'partial' ? 1 : 0;
        await trx.execute(`UPDATE analysis_datasets SET source_path='',parquet_path=?,file_size=file_size+?,row_count=?,source_row_count=source_row_count+?,source_version=?,active_version=?,
            truncated=?,truncation_reason=?,profile_json=?,preview_json=?,storage_mode='managed_fs',partition_root_path='',partition_field_key='',updated_at=NOW() WHERE id=?`,
        [parquetPath, input.bytes, rowCount, Number(ingest.sourceRowCount || ingest.rowCount), next.next, next.next, truncated, truncated ? '追加后的业务覆盖不是完整数据，请核对来源信息。' : '', JSON.stringify(profile), JSON.stringify(previewRows), datasetId]);
        await trx.execute('DELETE FROM analysis_dataset_partitions WHERE dataset_id=?', [datasetId]);
        await require('./analysis-production-models').audit(trx, { userId, modelId: null, runId: job.id, action: 'dataset_incremented', details: { datasetId, versionId, sourceRevision: String(next.next), inputBatchId: input.batchId, inputDigest: input.digest, inputBytes: String(input.bytes), appendedRows: Number(ingest.rowCount), totalRows: rowCount, sourceMetadata } });
        if (!await require('./analysis-runtime-budget').settleLegacyIn(trx, job, true)) throw biError('ANALYSIS_MODEL_LEASE_LOST', '追加执行未能确认完成，未登记数据版本。', 409);
        return { datasetId, sourceVersion: Number(next.next), appendedRows: Number(ingest.rowCount), totalRows: rowCount, inputBatchId: input.batchId, reused: false };
    });
}

module.exports = { inspect, commit };
