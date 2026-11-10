'use strict';

const { query } = require('../db/client');

async function listVerificationControls(runId, userId) {
    return await query(`SELECT c.message_id, c.message_type, c.from_run_id, c.payload, c.applied_at
        FROM agent_control_messages c JOIN agent_runs r ON r.id = c.to_run_id AND r.user_id = c.user_id
        WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL
            AND c.applied_at IS NOT NULL
        ORDER BY c.applied_at, c.id LIMIT 2001`, [runId, userId]);
}

async function listVerificationCheckpoints(runId, userId) {
    return await query(`SELECT c.checkpoint_id, c.operation_key, c.step_index, c.status, c.state, c.created_at
        FROM agent_run_checkpoints c JOIN agent_runs r ON r.id = c.run_id
        WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL AND c.checkpoint_type IN ('tool','dag')
        ORDER BY c.step_index, c.id LIMIT 2001`, [runId, userId]);
}

module.exports = { listVerificationControls, listVerificationCheckpoints };
