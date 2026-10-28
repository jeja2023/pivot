'use strict';

const { queryOne } = require('../db/client');

async function approve({ sourceId, runId, snapshotHash, userId }) {
    return await queryOne(`
        INSERT INTO knowledge_source_deletion_approvals (source_id, run_id, snapshot_hash, approved_by, expires_at)
        VALUES (?, ?, ?, ?, NOW() + INTERVAL '30 minutes')
        ON CONFLICT (run_id) DO NOTHING RETURNING id, expires_at
    `, [sourceId, runId, snapshotHash, userId]);
}

async function claim({ id, sourceId, snapshotHash, userId }) {
    return await queryOne(`
        UPDATE knowledge_source_deletion_approvals
        SET status = 'consumed', consumed_at = NOW()
        WHERE id = ? AND source_id = ? AND snapshot_hash = ? AND approved_by = ?
          AND status = 'approved' AND expires_at > NOW()
        RETURNING id
    `, [id, sourceId, snapshotHash, userId]);
}

module.exports = { approve, claim };
