'use strict';

const { queryOne, execute, transaction } = require('../db/client');
const TOOL = 'presentation.master';
const json = value => value && typeof value === 'object' ? value : JSON.parse(value || '{}');

async function read(user, id) {
    const row = await queryOne('SELECT * FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=?', [id, user.id, TOOL]);
    return row ? { ...row, input_request: json(row.input_request), result_json: json(row.result_json) } : null;
}
async function latest(user, presentationId = '') {
    return queryOne("SELECT id FROM tool_tasks WHERE user_id=? AND tool_name=? AND COALESCE(result_json->'state'->'request'->>'presentationId',input_request->>'presentationId','')=? ORDER BY created_at DESC LIMIT 1", [user.id, TOOL, presentationId]);
}
async function claim(user, id, leaseId) {
    return queryOne(`UPDATE tool_tasks SET result_json=COALESCE(result_json,'{}'::jsonb)||jsonb_build_object('_lease',?::text, '_leaseUntil', extract(epoch from NOW())+180),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW()
          AND (COALESCE((result_json->>'_leaseUntil')::numeric,0)<extract(epoch from NOW()) OR result_json->>'_lease'=?) RETURNING id`, [leaseId, id, user.id, TOOL, leaseId]);
}
async function save(user, id, leaseId, state, progress) {
    return queryOne(`UPDATE tool_tasks SET result_json=COALESCE(result_json,'{}'::jsonb)||?::jsonb||jsonb_build_object('_leaseUntil', extract(epoch from NOW())+180),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=? RETURNING id`,
    [JSON.stringify({ state, progress }), id, user.id, TOOL, leaseId]);
}
async function renew(user, id, leaseId) {
    return queryOne(`UPDATE tool_tasks SET result_json=COALESCE(result_json,'{}'::jsonb)||jsonb_build_object('_leaseUntil',extract(epoch from NOW())+180),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=? RETURNING id`, [id, user.id, TOOL, leaseId]);
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
    return queryOne(`UPDATE tool_tasks SET status='working',result_json=(COALESCE(result_json,'{}'::jsonb)-'_lease'-'_leaseUntil')||jsonb_build_object('state',?::jsonb),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='input_required' AND expires_at>NOW() RETURNING id`, [JSON.stringify(state), id, user.id, TOOL]);
}
async function resume(user, id, state) {
    return queryOne(`UPDATE tool_tasks SET status='working',error_code='',error_message='',expires_at=NOW()+INTERVAL '1 hour',
        result_json=(COALESCE(result_json,'{}'::jsonb)-'_lease'-'_leaseUntil')||jsonb_build_object('state',?::jsonb),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND (status='failed' OR (status='working' AND COALESCE((result_json->>'_leaseUntil')::numeric,0)<extract(epoch from NOW()))) RETURNING id`,
    [JSON.stringify(state), id, user.id, TOOL]);
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

module.exports = { TOOL, read, latest, claim, save, renew, release, parentActive, acceptResponse, resume, admit };
