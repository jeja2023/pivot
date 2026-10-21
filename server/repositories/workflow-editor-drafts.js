/* 编辑草稿使用用户级键和修订比较更新，避免双窗口互相覆盖。 */
const { query, queryOne, transaction, execute } = require('../db/client');

const list = userId => query(`SELECT d.draft_key, d.workflow_id, d.name, d.description, d.revision, d.base_version, d.updated_at
    FROM workflow_editor_drafts d LEFT JOIN agent_workflows w ON w.id = d.workflow_id
    WHERE d.user_id = ? AND (d.workflow_id IS NULL OR (w.deleted_at IS NULL AND w.user_id = d.user_id))
    ORDER BY d.updated_at DESC LIMIT 100`, [userId]);
async function claimedCreation(trx, userId, key, seed = {}) {
    await trx.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`workflow-draft:${userId}:${key}`]);
    await trx.execute(`INSERT INTO workflow_editor_drafts (user_id, draft_key, name, description, spec_text, base_version)
        VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (user_id, draft_key) DO NOTHING`, [userId, key, seed.name || '', seed.description || '', seed.specText || '{"nodes":[]}']);
    return trx.queryOne('SELECT workflow_id FROM workflow_editor_drafts WHERE user_id = ? AND draft_key = ?', [userId, key]);
}
const linkCreation = (trx, userId, key, workflowId) => trx.execute('UPDATE workflow_editor_drafts SET workflow_id = ? WHERE user_id = ? AND draft_key = ?', [workflowId, userId, key]);
const get = (userId, key) => queryOne('SELECT * FROM workflow_editor_drafts WHERE user_id = ? AND draft_key = ?', [userId, key]);
const remove = (userId, key) => execute('DELETE FROM workflow_editor_drafts WHERE user_id = ? AND draft_key = ?', [userId, key]);
async function save(userId, key, draft) {
    return transaction(async trx => {
        await trx.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`workflow-draft:${userId}:${key}`]);
        const current = await trx.queryOne('SELECT revision FROM workflow_editor_drafts WHERE user_id = ? AND draft_key = ? FOR UPDATE', [userId, key]);
        if (Number(current?.revision || 0) !== draft.expectedRevision) {
            const error = new Error('该草稿已在另一窗口更新，你的修改仍保留在当前页面。');
            error.status = 409; error.code = 'WORKFLOW_DRAFT_CONFLICT';
            throw error;
        }
        return trx.queryOne(`INSERT INTO workflow_editor_drafts (user_id, draft_key, workflow_id, name, description, spec_text, base_version)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id, draft_key) DO UPDATE SET workflow_id = COALESCE(excluded.workflow_id, workflow_editor_drafts.workflow_id), name = excluded.name,
            description = excluded.description, spec_text = excluded.spec_text, base_version = excluded.base_version,
            revision = workflow_editor_drafts.revision + 1, updated_at = NOW() RETURNING *`,
        [userId, key, draft.workflowId || null, draft.name, draft.description, draft.specText, draft.baseVersion]);
    });
}
const preferences = userId => query('SELECT * FROM workflow_user_preferences WHERE user_id = ?', [userId]);
const recentRuns = userId => query(`SELECT DISTINCT ON (metadata->>'workflowId') id, title, status, created_at, metadata->>'workflowId' AS workflow_id
    FROM agent_runs WHERE user_id = ? AND deleted_at IS NULL AND metadata->>'workflowId' IS NOT NULL
    ORDER BY metadata->>'workflowId', created_at DESC LIMIT 200`, [userId]);
async function setPreference(userId, workflowId, { favorite, used }) {
    return queryOne(`INSERT INTO workflow_user_preferences (user_id, workflow_id, favorite, last_used_at)
        VALUES (?, ?, ?, CASE WHEN ? THEN NOW() ELSE NULL END)
        ON CONFLICT (user_id, workflow_id) DO UPDATE SET
        favorite = CASE WHEN ? THEN excluded.favorite ELSE workflow_user_preferences.favorite END,
        last_used_at = CASE WHEN ? THEN NOW() ELSE workflow_user_preferences.last_used_at END RETURNING *`,
    [userId, workflowId, favorite === true, used === true, favorite !== undefined, used === true]);
}
module.exports = { list, get, remove, save, preferences, setPreference, recentRuns, claimedCreation, linkCreation };
