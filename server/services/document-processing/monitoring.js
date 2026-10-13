const { query, queryOne } = require('../../db/client');
const { JOB_STATUSES } = require('./constants');
const { getDocumentProcessingSettings } = require('./settings');

function rowsToCountObject(rows, key = 'status') {
    return rows.reduce((result, row) => {
        result[row[key] || 'unknown'] = Number(row.count || 0);
        return result;
    }, {});
}

function createDocumentProcessingMonitoring({ getQueueStatus }) {
    async function getDocumentProcessingStats() {
        const jobsByStatusRows = await query('SELECT status, COUNT(*) AS count FROM document_jobs GROUP BY status');
        const jobsByTypeRows = await query('SELECT job_type, COUNT(*) AS count FROM document_jobs GROUP BY job_type');
        const outputs = await queryOne('SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes FROM document_outputs');
        const duration = await queryOne(`
            SELECT AVG(EXTRACT(EPOCH FROM (completed_at::timestamptz - created_at::timestamptz))) AS seconds
            FROM document_jobs
            WHERE completed_at IS NOT NULL
        `);
        const recentFailuresRows = await query(`
            SELECT j.id, j.job_type, j.status, j.error_message, j.updated_at, f.original_name
            FROM document_jobs j
            LEFT JOIN document_files f ON f.id = j.file_id
            WHERE j.status = ?
            ORDER BY j.updated_at DESC, j.id DESC
            LIMIT 10
        `, [JOB_STATUSES.FAILED]);
        return {
            settings: getDocumentProcessingSettings(),
            queue: getQueueStatus(),
            jobsByStatus: rowsToCountObject(jobsByStatusRows),
            jobsByType: rowsToCountObject(jobsByTypeRows, 'job_type'),
            outputs: { count: Number(outputs?.count || 0), bytes: Number(outputs?.bytes || 0) },
            averageDurationSeconds: Number(duration?.seconds || 0),
            recentFailures: recentFailuresRows.map(row => ({
                id: row.id,
                jobType: row.job_type,
                status: row.status,
                errorMessage: row.error_message || '',
                updatedAt: row.updated_at,
                originalName: row.original_name || ''
            }))
        };
    }

    return { getDocumentProcessingStats };
}

module.exports = { createDocumentProcessingMonitoring };
