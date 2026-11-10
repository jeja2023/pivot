'use strict';

const crypto = require('node:crypto');
const { biError } = require('../services/data-analysis/bi/errors');
const { queryOne } = require('../db/client');

async function insertFlowDataset(trx, record) {
    const { output, object, sourceMetadata } = record;
    if (output.complete !== true || !Number.isSafeInteger(output.rowCount) || output.rowCount < 0 || output.rowCount > 500000 || !Array.isArray(output.columns) || !output.columns.length || output.columns.length > 120
        || output.columns.some((column, index) => column.key !== `c_${index + 1}`) || !Array.isArray(output.profile) || output.profile.length !== output.columns.length || !Array.isArray(output.previewRows) || output.previewRows.length > 20 || String(output.outputBytes) !== String(object.byte_length)) throw biError('ANALYSIS_MODEL_FLOW_INVALID', '节点输出不符合完整性合同，未登记数据集。', 409);
    const truncated = sourceMetadata.coverage === 'full' ? 0 : sourceMetadata.coverage === 'unknown' ? 2 : 1;
    const versionId = `dsv_${crypto.randomUUID()}`;
    await trx.execute(`INSERT INTO analysis_datasets(id,user_id,name,original_name,file_type,file_size,source_path,parquet_path,row_count,column_count,source_row_count,source_column_count,truncated,truncation_reason,
        columns_json,profile_json,preview_json,sheet_name,status,scope,allowed_units,allowed_user_ids,parent_dataset_id,source_version,active_version)
        VALUES (?,?,?,?,'modeled',?,'',?,?,?,?,?,?,?, ?,?,?,'','ready','personal','','',?,1,1)`,
    [record.id, record.userId, record.name, `${record.name}.parquet`, object.byte_length, record.parquetPath, output.rowCount, output.columns.length, output.rowCount, output.columns.length,
        truncated, truncated ? '节点来源包含部分或未知业务范围，输出保留原完整性声明。' : '', JSON.stringify(output.columns), JSON.stringify(output.profile), JSON.stringify(output.previewRows), record.parentDatasetId || null]);
    await trx.execute(`INSERT INTO analysis_dataset_versions(id,dataset_id,user_id,version,operation,parquet_path,row_count,column_count,manifest_json)
        VALUES (?,?,?,1,'model_flow',?,?,?,?::jsonb)`, [versionId, record.id, record.userId, record.parquetPath, output.rowCount, output.columns.length,
        JSON.stringify({ objectId: object.id, digest: object.digest, byteLength: String(object.byte_length), sourceMetadata, lineage: record.lineage,
            output: { name: record.name, columns: output.columns, profile: output.profile, previewRows: output.previewRows }, previewCellLimit: 256 })]);
    await require('./analysis-objects').pin([object.id, ...record.lineage.sources.map(source => source.objectId)], { kind: 'manifest', referenceId: `dataset-version:${versionId}` }, trx);
}

async function outputVersion(datasetId, runId, client = { queryOne }) { return client.queryOne("SELECT * FROM analysis_dataset_versions WHERE dataset_id=? AND operation='model_flow' AND manifest_json->'lineage'->>'runId'=? ORDER BY version LIMIT 1", [datasetId, runId]); }

module.exports = { insertFlowDataset, outputVersion };
