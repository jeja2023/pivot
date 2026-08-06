const { sql } = require('../db/statements');

function normalizeWorkflowId(workflowId) {
    const normalized = Number.parseInt(workflowId, 10);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function getWorkflowById(workflowId, { includeDeleted = false } = {}) {
    const normalizedId = normalizeWorkflowId(workflowId);
    if (!normalizedId) return null;
    const row = sql(`
        SELECT *
        FROM agent_workflows
        WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(normalizedId);
    return row || null;
}

function getOwnedWorkflow(workflowId, userId, { includeDeleted = false } = {}) {
    const normalizedId = normalizeWorkflowId(workflowId);
    if (!normalizedId || !userId) return null;
    const row = sql(`
        SELECT *
        FROM agent_workflows
        WHERE id = ? AND user_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(normalizedId, userId);
    return row || null;
}

function getWorkflowForUser(workflowId) {
    const normalizedId = normalizeWorkflowId(workflowId);
    if (!normalizedId) return null;
    const row = sql(`
        SELECT
            w.*,
            COALESCE(NULLIF(u.nickname, ''), NULLIF(u.deleted_username, ''), u.username) AS owner_name,
            v.version AS current_version,
            v.dag_spec AS current_dag_spec,
            v.note AS current_note,
            v.created_at AS version_created_at,
            pv.version AS published_version,
            pv.dag_spec AS published_dag_spec,
            pv.note AS published_note,
            pv.created_at AS published_version_created_at
        FROM agent_workflows w
        LEFT JOIN users u ON u.id = w.user_id
        LEFT JOIN agent_workflow_versions v ON v.id = w.current_version_id
        LEFT JOIN agent_workflow_versions pv ON pv.id = w.published_version_id
        WHERE w.id = ? AND w.deleted_at IS NULL
    `).get(normalizedId);
    return row || null;
}

function listWorkflowsForUser(userId, limit = 200) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 200);
    return sql(`
        SELECT
            w.*,
            COALESCE(NULLIF(u.nickname, ''), NULLIF(u.deleted_username, ''), u.username) AS owner_name,
            v.version AS current_version,
            v.dag_spec AS current_dag_spec,
            v.note AS current_note,
            v.created_at AS version_created_at,
            pv.version AS published_version,
            pv.dag_spec AS published_dag_spec,
            pv.note AS published_note,
            pv.created_at AS published_version_created_at
        FROM agent_workflows w
        LEFT JOIN users u ON u.id = w.user_id
        LEFT JOIN agent_workflow_versions v ON v.id = w.current_version_id
        LEFT JOIN agent_workflow_versions pv ON pv.id = w.published_version_id
        WHERE (w.user_id = ? OR w.scope = 'shared') AND w.deleted_at IS NULL
        ORDER BY w.updated_at DESC, w.id DESC
        LIMIT ?
    `).all(userId, safeLimit);
}

function getWorkflowVersionContext(workflowId) {
    const normalizedId = normalizeWorkflowId(workflowId);
    if (!normalizedId) return null;
    const row = sql(`
        SELECT
            w.*,
            cv.version AS current_version,
            pv.version AS published_version
        FROM agent_workflows w
        LEFT JOIN agent_workflow_versions cv ON cv.id = w.current_version_id
        LEFT JOIN agent_workflow_versions pv ON pv.id = w.published_version_id
        WHERE w.id = ? AND w.deleted_at IS NULL
    `).get(normalizedId);
    return row || null;
}

function getWorkflowVersionById(workflowId, versionId) {
    const normalizedWorkflowId = normalizeWorkflowId(workflowId);
    const normalizedVersionId = Number.parseInt(versionId, 10);
    if (!normalizedWorkflowId || !Number.isInteger(normalizedVersionId) || normalizedVersionId <= 0) return null;
    return sql(`
        SELECT *
        FROM agent_workflow_versions
        WHERE id = ? AND workflow_id = ?
    `).get(normalizedVersionId, normalizedWorkflowId) || null;
}

function getWorkflowVersionByNumber(workflowId, version) {
    const normalizedWorkflowId = normalizeWorkflowId(workflowId);
    const normalizedVersion = Number.parseInt(version, 10);
    if (!normalizedWorkflowId || !Number.isInteger(normalizedVersion) || normalizedVersion <= 0) return null;
    return sql(`
        SELECT *
        FROM agent_workflow_versions
        WHERE workflow_id = ? AND version = ?
    `).get(normalizedWorkflowId, normalizedVersion) || null;
}

function listWorkflowVersions(workflowId) {
    const normalizedId = normalizeWorkflowId(workflowId);
    if (!normalizedId) return [];
    return sql(`
        SELECT id, workflow_id, version, dag_spec, note, created_by, created_at
        FROM agent_workflow_versions
        WHERE workflow_id = ?
        ORDER BY version DESC
    `).all(normalizedId);
}

function getWorkflowDiffContext(workflowId, userId) {
    const normalizedId = normalizeWorkflowId(workflowId);
    if (!normalizedId || !userId) return null;
    return sql(`
        SELECT w.*, cv.version AS current_version
        FROM agent_workflows w
        LEFT JOIN agent_workflow_versions cv ON cv.id = w.current_version_id
        WHERE w.id = ? AND w.user_id = ? AND w.deleted_at IS NULL
    `).get(normalizedId, userId) || null;
}

function listWorkflowVersionsForDiff(workflowId, fromVersion, toVersion) {
    const normalizedId = normalizeWorkflowId(workflowId);
    if (!normalizedId) return [];
    return sql(`
        SELECT version, dag_spec, note, created_at
        FROM agent_workflow_versions
        WHERE workflow_id = ? AND version IN (?, ?)
    `).all(normalizedId, fromVersion, toVersion);
}

function getRecentlyDeletedOwnedWorkflow(workflowId, userId) {
    const normalizedId = normalizeWorkflowId(workflowId);
    if (!normalizedId || !userId) return null;
    return sql(`
        SELECT *
        FROM agent_workflows
        WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL
          AND deleted_at > datetime('now', '+8 hours', '-30 days')
    `).get(normalizedId, userId) || null;
}

module.exports = {
    getWorkflowById,
    getOwnedWorkflow,
    getWorkflowForUser,
    listWorkflowsForUser,
    getWorkflowVersionContext,
    getWorkflowVersionById,
    getWorkflowVersionByNumber,
    listWorkflowVersions,
    getWorkflowDiffContext,
    listWorkflowVersionsForDiff,
    getRecentlyDeletedOwnedWorkflow
};
