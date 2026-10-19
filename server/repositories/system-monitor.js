const { queryOne } = require('../db/client');

async function getTaskQueueSnapshot() {
    const row = await queryOne(`
        SELECT
            COUNT(*) FILTER (WHERE status = 'queued') AS queued,
            COUNT(*) FILTER (WHERE status = 'running') AS running,
            COUNT(*) FILTER (WHERE status IN ('approval_required', 'awaiting_approval', 'awaiting_commit')) AS awaiting_approval,
            EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN(created_at) FILTER (WHERE status = 'queued'))) AS oldest_queued_seconds,
            COUNT(*) FILTER (WHERE status IN ('failed', 'error', 'partial', 'completed_with_errors') AND completed_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours') AS failures_24h
        FROM agent_runs
        WHERE deleted_at IS NULL AND (
            status IN ('queued', 'running', 'approval_required', 'awaiting_approval', 'awaiting_commit')
            OR (status IN ('failed', 'error', 'partial', 'completed_with_errors') AND completed_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours')
        )
    `);
    return {
        available: true,
        scope: 'organization',
        queued: Number(row?.queued || 0),
        running: Number(row?.running || 0),
        awaitingApproval: Number(row?.awaiting_approval || 0),
        oldestQueuedSeconds: row?.oldest_queued_seconds == null ? null : Math.max(0, Number(row.oldest_queued_seconds)),
        failures24h: Number(row?.failures_24h || 0)
    };
}

module.exports = { getTaskQueueSnapshot };
