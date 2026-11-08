'use strict';

const { execute, transaction } = require('../db/client');

async function insertFlowDataset(record) {
    return transaction(async trx => {
        await trx.execute(`
            INSERT INTO analysis_datasets (
                id, user_id, name, original_name, file_type, file_size, source_path, parquet_path,
                row_count, column_count, source_row_count, source_column_count, truncated, truncation_reason,
                columns_json, profile_json, preview_json, sheet_name, status, scope, allowed_units,
                allowed_user_ids, parent_dataset_id, source_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'modeled', ?, '', ?, ?, ?, ?, ?, 0, '', ?, ?, ?, '', 'ready', 'personal', '', '', ?, 1, ?, ?)
        `, [
            record.id,
            record.userId,
            record.name,
            record.originalName,
            record.fileSize,
            record.parquetPath,
            record.rowCount,
            record.columnCount,
            record.rowCount,
            record.columnCount,
            JSON.stringify(record.columns),
            JSON.stringify(record.profile),
            JSON.stringify(record.previewRows),
            record.parentDatasetId || null,
            record.now,
            record.now
        ]);
    });
}

async function deleteFlowDataset(datasetId, userId) {
    await execute('DELETE FROM analysis_datasets WHERE id = ? AND user_id = ?', [datasetId, userId]);
}

module.exports = {
    insertFlowDataset,
    deleteFlowDataset
};

