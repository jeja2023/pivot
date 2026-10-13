const { query, execute } = require('../../db/client');
const { logger } = require('../../logger');
const { getAppSettingValue } = require('../app-settings');
const { DEFAULT_DOCUMENT_PROCESSING_CONFIG } = require('./constants');
const { safeUnlinkManaged } = require('./paths');
const { cleanupExpiredJobSecrets } = require('./secrets');

async function cleanupExpiredDocumentProcessingFiles(options = {}) {
    const configuredRetention = Number.parseInt(getAppSettingValue('document_processing_output_retention_days'), 10);
    const retentionDays = Math.max(1, Number.parseInt(options.retentionDays, 10) || configuredRetention || DEFAULT_DOCUMENT_PROCESSING_CONFIG.outputRetentionDays);
    const rows = await query(`
        SELECT o.id, o.file_path
        FROM document_outputs o
        WHERE o.status = 'ready'
          AND COALESCE(o.expires_at, o.created_at + (? || ' days')::interval) < (now() AT TIME ZONE 'Asia/Shanghai')
          AND NOT EXISTS (SELECT 1 FROM document_artifact_refs r WHERE r.output_id = o.id)
        LIMIT 500
    `, [String(retentionDays)]);
    let removedFiles = 0;
    for (const row of rows) {
        if (await safeUnlinkManaged(row.file_path)) removedFiles += 1;
        await execute('UPDATE document_outputs SET status = ? WHERE id = ?', ['expired', row.id]);
    }
    if (rows.length > 0) {
        logger.info({ outputs: rows.length, removedFiles, retentionDays }, '文档处理过期输出已清理');
    }
    const expiredSecrets = await cleanupExpiredJobSecrets().catch(() => 0);
    return { outputs: rows.length, removedFiles, retentionDays, expiredSecrets };
}

module.exports = {
    cleanupExpiredDocumentProcessingFiles
};
