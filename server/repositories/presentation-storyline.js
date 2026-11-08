'use strict';

const { queryOne, execute, transaction } = require('../db/client');
const TOOL = 'presentation.storyline';
const json = value => typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
async function read(user, presentationId, id) {
    const row = id ? await queryOne("SELECT * FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=? AND input_request->>'presentationId'=?", [id, user.id, TOOL, presentationId])
        : await queryOne("SELECT * FROM tool_tasks WHERE user_id=? AND tool_name=? AND input_request->>'presentationId'=? ORDER BY created_at DESC,id DESC LIMIT 1", [user.id, TOOL, presentationId]);
    return row ? { ...row, input_request: json(row.input_request), result_json: json(row.result_json) } : null;
}
async function create(user, input, operation) {
    return transaction(async client => {
        await client.queryOne("SELECT pg_advisory_xact_lock(hashtext(?))", ['storyline:' + user.id + ':' + input.presentationId]);
        const existing = await client.queryOne("SELECT id FROM tool_tasks WHERE user_id=? AND tool_name=? AND status IN ('working','input_required') AND expires_at>NOW() AND input_request->>'presentationId'=? LIMIT 1", [user.id, TOOL, input.presentationId]);
        if (existing) throw Object.assign(new Error('此文稿已有故事线方案正在生成或等待确认，请先确认或放弃。'), { status: 409, code: 'PRESENTATION_STORY_BUSY' });
        const task = await operation(client);
        // 通用任务时间精确到秒；这里用数据库时钟保留取消后立即重建的真实顺序。
        const saved = await client.queryOne('UPDATE tool_tasks SET created_at=clock_timestamp() WHERE id=? AND user_id=? AND tool_name=? RETURNING created_at', [task.id, user.id, TOOL]);
        return { ...task, createdAt: saved.created_at };
    });
}
async function claim(user, id, lease) {
    return queryOne("UPDATE tool_tasks SET result_json=jsonb_build_object('_lease',?::text,'_leaseUntil',extract(epoch from NOW())+180) WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND COALESCE(result_json->>'_lease','')='' RETURNING id", [lease, id, user.id, TOOL]);
}
async function renew(user, id, lease) { return queryOne("UPDATE tool_tasks SET result_json=result_json||jsonb_build_object('_leaseUntil',extract(epoch from NOW())+180) WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND result_json->>'_lease'=? AND expires_at>NOW() RETURNING id", [id, user.id, TOOL, lease]); }
async function propose(user, id, lease, result) {
    return queryOne("UPDATE tool_tasks SET status='input_required',result_json=?::jsonb,updated_at=NOW() WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND result_json->>'_lease'=? AND expires_at>NOW() RETURNING id", [JSON.stringify({ ...result, phase: 'proposed' }), id, user.id, TOOL, lease]);
}
async function discard(user, id) {
    return queryOne("UPDATE tool_tasks SET status='cancelled',updated_at=NOW() WHERE id=? AND user_id=? AND tool_name=? AND ((status='working' AND (COALESCE(result_json->>'phase','')<>'applying' OR (result_json->>'_leaseUntil')::numeric<extract(epoch from NOW()))) OR status='input_required') RETURNING id", [id, user.id, TOOL]);
}
async function claimApply(user, id, lease) {
    return queryOne("UPDATE tool_tasks SET status='working',result_json=result_json||jsonb_build_object('phase','applying','_lease',?::text,'_leaseUntil',extract(epoch from NOW())+180),updated_at=NOW() WHERE id=? AND user_id=? AND tool_name=? AND (status='input_required' OR (status='working' AND result_json->>'phase'='applying' AND (result_json->>'_leaseUntil')::numeric<extract(epoch from NOW()))) AND expires_at>NOW() RETURNING id", [lease, id, user.id, TOOL]);
}
async function finished(user, id, version) { await execute("UPDATE tool_tasks SET status='completed',result_json=result_json||jsonb_build_object('phase','applied','appliedVersion',?::int),updated_at=NOW() WHERE id=? AND user_id=? AND tool_name=? AND result_json->>'phase' IN ('applying','failed','applied')", [version, id, user.id, TOOL]); }
async function appliedVersion(user, presentationId, id) { return queryOne('SELECT v.version FROM presentation_versions v JOIN presentation_documents d ON d.id=v.presentation_id WHERE d.client_id=? AND v.note=? AND v.created_by=? AND d.deleted_at IS NULL', [presentationId, '按故事线调整:' + id, user.id]); }
module.exports = { TOOL, read, create, claim, renew, propose, discard, claimApply, finished, appliedVersion };
