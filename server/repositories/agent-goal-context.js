'use strict';

const { query, queryOne } = require('../db/client');

// 只读取同一账号、同一目标版本的前次运行；编辑目标后不自动沿用旧工作。
async function readGoalContextRun(runId, userId, goalId, goalVersion) {
    return await queryOne(`SELECT r.id, r.status, r.final_answer, r.error_message, r.metadata, r.updated_at,
            v.outcome_status, v.report AS verification_report
        FROM agent_runs r LEFT JOIN agent_verifications v ON v.run_id = r.id AND v.user_id = r.user_id
        WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL
            AND r.metadata->>'goalId' = ? AND r.metadata->>'goalVersion' = ?`,
    [runId, userId, goalId, String(goalVersion)]);
}

async function listGoalContextArtifactIds(runId, userId) {
    return await query(`SELECT id FROM agent_artifacts WHERE run_id = ? AND user_id = ? AND status <> 'deleted'
        ORDER BY id LIMIT 101`, [runId, userId]);
}

module.exports = { readGoalContextRun, listGoalContextArtifactIds };
