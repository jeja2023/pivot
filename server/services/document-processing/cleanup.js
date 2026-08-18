const fs = require('fs');

const { query, execute } = require('../../db/client');
const { logger } = require('../../logger');
const { getAppSettingValue } = require('../app-settings');
const { DEFAULT_DOCUMENT_PROCESSING_CONFIG } = require('./constants');
const { resolveStoredDocumentPath, safeUnlinkManaged } = require('./paths');

async function cleanupExpiredDocumentProcessingFiles(options = {}) {
    const configuredRetention = Number.parseInt(getAppSettingValue('document_processing_output_retention_days'), 10);
    const retentionDays = Math.max(1, Number.parseInt(options.retentionDays, 10) || configuredRetention || DEFAULT_DOCUMENT_PROCESSING_CONFIG.outputRetentionDays);
    const rows = await query(`
        SELECT id, file_path
        FROM document_outputs
        WHERE status = 'ready'
          AND created_at < (now() AT TIME ZONE 'Asia/Shanghai' - (? || ' days')::interval)
        LIMIT 500
    `, [String(retentionDays)]);
    let removedFiles = 0;
    for (const row of rows) {
        const target = resolveStoredDocumentPath(row.file_path);
        if (target && fs.existsSync(target) && safeUnlinkManaged(row.file_path)) removedFiles += 1;
        await execute('UPDATE document_outputs SET status = ? WHERE id = ?', ['expired', row.id]);
    }
    if (rows.length > 0) {
        logger.info({ outputs: rows.length, removedFiles, retentionDays }, '文档处理过期输出已清理');
    }
    return { outputs: rows.length, removedFiles, retentionDays };
}

module.exports = {
    cleanupExpiredDocumentProcessingFiles
};
