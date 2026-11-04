'use strict';

const { query } = require('../db/client');

async function readBudgetStopSummary(user, cutoff) {
    return query(`SELECT COALESCE(metadata->'budgetStop'->>'code','unknown') AS code,COUNT(*) AS samples,
        COUNT(*) FILTER (WHERE status = 'completed') AS later_completed
        FROM agent_runs WHERE user_id = ? AND created_at >= ? AND deleted_at IS NULL AND jsonb_exists(metadata,'budgetStop')
        GROUP BY metadata->'budgetStop'->>'code' ORDER BY COUNT(*) DESC LIMIT 30`, [user.id, cutoff]);
}

module.exports = { readBudgetStopSummary };
