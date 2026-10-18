'use strict';

const { parseJson } = require('./agent-release-inputs');

function formatWorkflowReleaseForRead(row, { includeTargets = false } = {}) {
    if (!row) return null;
    return {
        id: row.id,
        workflow_id: row.workflow_id,
        workflow_version_id: row.workflow_version_id,
        version: Number(row.version || 0),
        note: row.note || '',
        rollout_scope: row.rollout_scope || 'personal',
        rollout_percent: Number(row.rollout_percent || 0),
        ...(includeTargets ? {
            target_user_ids: parseJson(row.target_user_ids, []),
            target_units: parseJson(row.target_units, []),
            release_note: row.release_note || '',
            review_status: row.review_status || 'not_required',
            review_note: row.review_note || '',
            reviewed_by: row.reviewed_by || null,
            reviewed_at: row.reviewed_at || null
        } : {}),
        tool_dependency_stale: Boolean(row.tool_dependency_stale),
        tool_dependency_stale_at: row.tool_dependency_stale_at || null,
        tool_dependency_stale_reason: row.tool_dependency_stale_reason || '',
        status: row.status,
        published_by: row.published_by,
        published_at: row.published_at,
        rolled_back_at: row.rolled_back_at || null,
        previous_release_id: row.previous_release_id || null
    };
}

module.exports = { formatWorkflowReleaseForRead };

