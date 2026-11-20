'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');
const TOOL = 'presentation.master';
const json = value => value && typeof value === 'object' ? value : JSON.parse(value || '{}');
// 单次连续执行最多八小时。人工确认或续跑开始新的执行段。
const activeRunDeadline = "COALESCE((result_json->>'_runDeadline')::numeric,extract(epoch from NOW()+INTERVAL '8 hours'))";
const extendActiveExpiry = `LEAST(CASE WHEN expires_at < NOW()+INTERVAL '30 minutes' THEN NOW()+INTERVAL '1 hour'
    ELSE expires_at END, to_timestamp(${activeRunDeadline}::double precision))`;

async function read(user, id) {
    const row = await queryOne('SELECT *, updated_at::text AS review_revision FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=?', [id, user.id, TOOL]);
    return row ? { ...row, input_request: json(row.input_request), result_json: json(row.result_json) } : null;
}
async function latest(user, presentationId = '') {
    return queryOne("SELECT id FROM tool_tasks WHERE user_id=? AND tool_name=? AND COALESCE(result_json->'state'->'request'->>'presentationId',input_request->>'presentationId','')=? ORDER BY created_at DESC LIMIT 1", [user.id, TOOL, presentationId]);
}
async function recent(user) {
    return query(`WITH latest AS (
        SELECT id FROM tool_tasks WHERE user_id=? AND tool_name=? ORDER BY created_at DESC, id DESC LIMIT 20
    )
        SELECT id, status, created_at, (result_json->'savedReviewPages' IS NOT NULL) AS has_saved_review_pages,
        (result_json->'progressSnapshots' IS NOT NULL) AS has_progress_snapshot,
        COALESCE(result_json->'state'->'request',input_request)-'materials'-'instruction' AS request
        FROM tool_tasks WHERE user_id=? AND tool_name=?
          AND (id IN (SELECT id FROM latest) OR result_json->'savedReviewPages' IS NOT NULL OR result_json->'progressSnapshots' IS NOT NULL)
        ORDER BY (result_json->'savedReviewPages' IS NOT NULL OR result_json->'progressSnapshots' IS NOT NULL) DESC, created_at DESC, id DESC`, [user.id, TOOL, user.id, TOOL]);
}
async function draftCandidates(user, tenantId, filters) {
    const { search, templateId, createdBy, updatedFrom, updatedTo, limit } = filters;
    return query(`SELECT t.id,t.updated_at,u.username,u.nickname,a.title AS artifact_title,r.id AS rendition_id,
        (t.result_json->'state'->'request')-'materials'-'instruction' AS request
        FROM tool_tasks t JOIN users u ON u.id=t.user_id
        JOIN agent_artifact_renditions r ON r.tool_call_id='ppt-master:'||t.id AND r.tenant_id=?
            AND r.created_by=t.user_id AND r.format='pptx' AND r.status='ready'
        JOIN agent_artifacts a ON a.id=r.artifact_id AND a.user_id=t.user_id AND COALESCE(a.status,'active')<>'deleted'
        WHERE t.user_id=? AND (t.tenant_id IS NULL OR t.tenant_id=r.tenant_id) AND t.tool_name=? AND t.status='completed'
            AND t.result_json->'state'->'request'->>'draftFirst'='true'
            AND (t.result_json->'publicResult'->'files') @> jsonb_build_array(jsonb_build_object('format','pptx','renditionId',r.id))
            AND (?::text='' OR a.title ILIKE ?
                OR (t.result_json->'state'->'review'->'approvals'->'design'->'plan'->'pages')::text ILIKE ?)
            AND (?::text='' OR t.result_json->'state'->'request'->'template'->>'id'=?)
            AND (?::text='' OR u.username ILIKE ? OR COALESCE(u.nickname,'') ILIKE ?)
            AND (NULLIF(?::text,'') IS NULL OR t.updated_at>=NULLIF(?::text,'')::date)
            AND (NULLIF(?::text,'') IS NULL OR t.updated_at<NULLIF(?::text,'')::date+INTERVAL '1 day')
        ORDER BY t.updated_at DESC,t.id DESC LIMIT ?`,
    [tenantId, user.id, TOOL, search, search, search, templateId, templateId, createdBy, createdBy, createdBy,
        updatedFrom, updatedFrom, updatedTo, updatedTo, limit]);
}
async function saveReviewPages(user, id, revision, snapshot, commit) {
    return transaction(async client => {
        const row = await client.queryOne(`SELECT updated_at::text AS review_revision, result_json->'savedReviewPages' AS saved
            FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=? AND status IN ('failed','expired') FOR UPDATE`, [id, user.id, TOOL]);
        if (!row || row.review_revision !== revision) return null;
        if (row.saved?.exportRevision === snapshot.exportRevision && row.saved.sourceRevision === revision) return row.saved;
        await commit(client, row.saved);
        await client.execute(`UPDATE tool_tasks SET result_json=result_json||jsonb_build_object('savedReviewPages', ?::jsonb)
            WHERE id=? AND user_id=? AND tool_name=?`, [JSON.stringify(snapshot), id, user.id, TOOL]);
        return snapshot;
    });
}
async function findActive(user) {
    return queryOne("SELECT id FROM tool_tasks WHERE user_id=? AND tool_name=? AND status IN ('working','input_required') AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1", [user.id, TOOL]);
}
async function withExecution(user, id, lease, commit) {
    return transaction(async client => {
        const owned = await client.queryOne("SELECT id FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=? AND (result_json->>'_leaseUntil')::numeric>extract(epoch from NOW()) FOR UPDATE", [id, user.id, TOOL, lease]);
        if (!owned) throw Object.assign(new Error('制作任务已停止或执行租约已失效。'), { code: 'PPT_MASTER_LEASE_LOST', status: 409 });
        return commit(client);
    });
}
async function saveProgressSnapshot(user, id, lease, prepared, updateReferences) {
    return withExecution(user, id, lease, async client => {
        const row = await client.queryOne("SELECT result_json->'progressSnapshots' AS snapshots FROM tool_tasks WHERE id=?", [id]);
        const before = row.snapshots || {}, after = { ...before, ...prepared };
        await updateReferences(client, before, after);
        await client.execute("UPDATE tool_tasks SET result_json=result_json||jsonb_build_object('progressSnapshots',?::jsonb) WHERE id=?", [JSON.stringify(after), id]);
    });
}
async function updateProgressRetention(executor, objectId) {
    return executor.execute(`UPDATE agent_artifact_objects
        SET expires_at=CASE WHEN ref_count>0 THEN NULL ELSE NOW()+INTERVAL '24 hours' END
        WHERE id=? AND kind='ppt_master_progress'`, [objectId]);
}
async function claim(user, id, leaseId) {
    return queryOne(`UPDATE tool_tasks SET result_json=COALESCE(result_json,'{}'::jsonb)||jsonb_build_object(
        '_lease',?::text, '_leaseUntil', extract(epoch from NOW())+180,
        '_runDeadline', ${activeRunDeadline}),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW()
          AND (COALESCE((result_json->>'_leaseUntil')::numeric,0)<extract(epoch from NOW()) OR result_json->>'_lease'=?) RETURNING id`, [leaseId, id, user.id, TOOL, leaseId]);
}
async function save(user, id, leaseId, state, progress) {
    return queryOne(`UPDATE tool_tasks SET result_json=COALESCE(result_json,'{}'::jsonb)||?::jsonb||jsonb_build_object(
        '_leaseUntil', extract(epoch from NOW())+180, '_runDeadline', ${activeRunDeadline}),
        expires_at=${extendActiveExpiry},updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=?
          AND (result_json->>'_leaseUntil')::numeric>extract(epoch from NOW()) RETURNING id`,
    [JSON.stringify({ state, progress }), id, user.id, TOOL, leaseId]);
}
async function renew(user, id, leaseId) {
    return queryOne(`UPDATE tool_tasks SET result_json=COALESCE(result_json,'{}'::jsonb)||jsonb_build_object(
        '_leaseUntil',extract(epoch from NOW())+180, '_runDeadline', ${activeRunDeadline}),
        expires_at=${extendActiveExpiry},updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=?
          AND (result_json->>'_leaseUntil')::numeric>extract(epoch from NOW()) RETURNING id`, [id, user.id, TOOL, leaseId]);
}
async function release(user, id, leaseId) {
    await execute("UPDATE tool_tasks SET result_json=result_json-'_lease'-'_leaseUntil' WHERE id=? AND user_id=? AND tool_name=? AND result_json->>'_lease'=?", [id, user.id, TOOL, leaseId]);
}
async function parentActive(runId, user) {
    if (!runId) return true;
    const run = await queryOne('SELECT status FROM agent_runs WHERE id=? AND user_id=? AND deleted_at IS NULL', [runId, user.id]);
    return Boolean(run && !['completed', 'completed_with_errors', 'partial', 'cancelled', 'deleted', 'failed', 'error', 'needs_input'].includes(run.status));
}
async function acceptResponse(user, id, state) {
    return queryOne(`UPDATE tool_tasks SET status='working',error_code='',error_message='',expires_at=NOW()+INTERVAL '1 hour',result_json=(COALESCE(result_json,'{}'::jsonb)-'_lease'-'_leaseUntil'-'_runDeadline')||jsonb_build_object('state',?::jsonb),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND result_json->'state'->>'steps' IS NOT DISTINCT FROM ?::text AND COALESCE(result_json->'state'->>'response','')=''
          AND (status='input_required' AND expires_at>NOW() OR status IN ('expired','failed') AND result_json->'state'->>'pendingKind' IN ('confirmation','clarification')) RETURNING id`, [JSON.stringify(state), id, user.id, TOOL, state.steps == null ? null : String(state.steps)]);
}
async function resume(user, id, state, expectedDraft = null) {
    return queryOne(`UPDATE tool_tasks SET status='working',error_code='',error_message='',expires_at=NOW()+INTERVAL '1 hour',
        result_json=(COALESCE(result_json,'{}'::jsonb)-'_lease'-'_leaseUntil'-'_runDeadline')||jsonb_build_object('state',?::jsonb),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND (?::text IS NULL OR (status IN ('failed','expired') AND result_json->'state'->'reviewDraft'->>'sha256'=?))
          AND (COALESCE(result_json->'state'->>'pendingKind','')='' OR COALESCE(result_json->'state'->>'response','')<>'') AND (status IN ('failed','expired') OR (status='working' AND COALESCE((result_json->>'_leaseUntil')::numeric,0)<extract(epoch from NOW()))) RETURNING id`,
    [JSON.stringify(state), id, user.id, TOOL, expectedDraft, expectedDraft]);
}
async function admit(user, create, excludedTaskId = '') {
    return transaction(async client => {
        await require('./presentation-engine-deployment').lock(client);
        await client.queryOne("SELECT pg_advisory_xact_lock(hashtext('ppt-master:admission'))");
        const usage = await client.queryOne("SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE user_id=?)::int AS owned FROM tool_tasks WHERE tool_name=? AND id<>? AND status IN ('working','input_required') AND expires_at>NOW()", [user.id, TOOL, excludedTaskId]);
        if (Number(usage?.owned) >= 1 || Number(usage?.total) >= 2) throw Object.assign(new Error('完整制作任务正在执行或等待确认，请先完成/停止已有任务后重试。'), { code: 'PPT_MASTER_CAPACITY_BUSY', status: 429, expose: true });
        return create(client);
    });
}

module.exports = { TOOL, read, latest, recent, draftCandidates, saveReviewPages, findActive, withExecution, saveProgressSnapshot, updateProgressRetention, claim, save, renew, release, parentActive, acceptResponse, resume, admit };
