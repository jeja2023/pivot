'use strict';

const { query, queryOne, execute, transaction } = require('../db/client');
const TOOL = 'presentation.native';
const json = value => typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
const invalid = (message, code = 'PRESENTATION_NATIVE_CONFLICT', status = 409) => Object.assign(new Error(message), { code, status, statusCode: status, expose: true });

async function list(user, tenantId) {
    return query('SELECT id,title,current_version,created_at,updated_at FROM presentation_native_documents WHERE tenant_id=? AND owner_user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100', [tenantId, user.id]);
}
async function read(user, tenantId, id, version = null) {
    const row = await queryOne(`SELECT d.*,v.version,v.package_ref,v.package_digest,v.manifest_json,v.job_id FROM presentation_native_documents d
        JOIN presentation_native_versions v ON v.document_id=d.id AND v.version=COALESCE(?::int,d.current_version)
        WHERE d.id=? AND d.tenant_id=? AND d.owner_user_id=? AND d.deleted_at IS NULL`, [version, id, tenantId, user.id]);
    return row ? { ...row, manifest_json: json(row.manifest_json) } : null;
}
async function header(user, tenantId, id, version = null) {
    return queryOne(`SELECT d.id,d.current_version,d.tenant_id,d.title,v.version,v.package_ref,v.package_digest FROM presentation_native_documents d
        JOIN presentation_native_versions v ON v.document_id=d.id AND v.version=COALESCE(?::int,d.current_version)
        WHERE d.id=? AND d.tenant_id=? AND d.owner_user_id=? AND d.deleted_at IS NULL`, [version, id, tenantId, user.id]);
}
async function versions(user, tenantId, id) {
    return query(`SELECT v.version,v.package_digest,v.created_at FROM presentation_native_versions v JOIN presentation_native_documents d ON d.id=v.document_id
        WHERE d.id=? AND d.tenant_id=? AND d.owner_user_id=? AND d.deleted_at IS NULL ORDER BY v.version DESC LIMIT 100`, [id, tenantId, user.id]);
}
async function readJob(user, id) {
    const row = await queryOne('SELECT * FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=?', [id, user.id, TOOL]);
    return row ? { ...row, input_request: json(row.input_request), result_json: json(row.result_json) } : null;
}
async function latestJob(user) {
    return queryOne('SELECT id FROM tool_tasks WHERE user_id=? AND tool_name=? ORDER BY created_at DESC LIMIT 1', [user.id, TOOL]);
}
async function admit(user, create, excluded = '') {
    return transaction(async client => {
        await require('./presentation-engine-deployment').lock(client);
        await client.queryOne("SELECT pg_advisory_xact_lock(hashtext('presentation-native:admission'))");
        const usage = await client.queryOne("SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE user_id=?)::int AS owned FROM tool_tasks WHERE tool_name=? AND id<>? AND status='working' AND expires_at>NOW()", [user.id, TOOL, excluded]);
        if (Number(usage.owned) >= 1 || Number(usage.total) >= 2) throw invalid('原稿编辑或视频任务正在执行，请等待完成或停止后重试。', 'PRESENTATION_NATIVE_BUSY', 429);
        return create(client);
    });
}
async function claim(user, id, lease) {
    return queryOne(`UPDATE tool_tasks SET result_json=COALESCE(result_json,'{}'::jsonb)||jsonb_build_object('_lease',?::text,'_leaseUntil',extract(epoch from NOW())+180)
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND COALESCE((result_json->>'_leaseUntil')::numeric,0)<extract(epoch from NOW()) RETURNING id`, [lease, id, user.id, TOOL]);
}
async function checkpoint(user, id, lease, state, progress) {
    return queryOne(`UPDATE tool_tasks SET result_json=COALESCE(result_json,'{}'::jsonb)||?::jsonb||jsonb_build_object('_leaseUntil',extract(epoch from NOW())+180),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=? RETURNING id`, [JSON.stringify({ state, progress }), id, user.id, TOOL, lease]);
}
async function release(user, id, lease) {
    await execute("UPDATE tool_tasks SET result_json=result_json-'_lease'-'_leaseUntil' WHERE id=? AND user_id=? AND tool_name=? AND result_json->>'_lease'=?", [id, user.id, TOOL, lease]);
}
async function resume(user, id) {
    return queryOne(`UPDATE tool_tasks SET status='working',error_code='',error_message='',expires_at=NOW()+INTERVAL '1 hour',result_json=result_json-'_lease'-'_leaseUntil'
        WHERE id=? AND user_id=? AND tool_name=? AND updated_at>NOW()-INTERVAL '24 hours' AND (status='failed' OR status='working' AND COALESCE((result_json->>'_leaseUntil')::numeric,0)<extract(epoch from NOW())) RETURNING id`, [id, user.id, TOOL]);
}
async function commit(user, tenantId, id, lease, request, output, executor = null) {
    const persist = async client => {
        const job = await client.queryOne("SELECT id FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=? AND (result_json->>'_leaseUntil')::numeric>extract(epoch from NOW()) FOR UPDATE", [id, user.id, TOOL, lease]);
        if (!job) throw invalid('原稿任务已停止或执行租约失效。');
        const existing = await client.queryOne('SELECT document_id,version FROM presentation_native_versions WHERE job_id=?', [id]);
        if (existing) return { ...existing, created: false };
        let version = 1;
        if (request.kind === 'import') {
            await client.execute('INSERT INTO presentation_native_documents(id,tenant_id,owner_user_id,title) VALUES(?,?,?,?)', [request.documentId, tenantId, user.id, request.title]);
        } else {
            const current = await client.queryOne('SELECT current_version FROM presentation_native_documents WHERE id=? AND tenant_id=? AND owner_user_id=? AND deleted_at IS NULL FOR UPDATE', [request.documentId, tenantId, user.id]);
            if (!current || Number(current.current_version) !== request.baseVersion) throw invalid('文稿已有新版本，请刷新后核对修改，不会覆盖其他窗口的保存结果。');
            version = request.baseVersion + 1;
            await client.execute('UPDATE presentation_native_documents SET current_version=?,updated_at=NOW() WHERE id=?', [version, request.documentId]);
        }
        await client.execute('INSERT INTO presentation_native_versions(document_id,version,job_id,package_ref,package_digest,manifest_json,created_by) VALUES(?,?,?,?,?,?::jsonb,?)', [request.documentId, version, id, output.packageRef, output.packageDigest, JSON.stringify(output.manifest), user.id]);
        for (const objectId of new Set(output.objectIds || [])) {
            const referenced = await client.queryOne('UPDATE agent_artifact_objects SET ref_count=ref_count+1 WHERE id=? AND tenant_id=? RETURNING id', [objectId, tenantId]);
            if (!referenced) throw invalid('原稿内容或预览对象已失效，版本未保存。');
        }
        return { document_id: request.documentId, version, created: true };
    };
    return executor ? persist(executor) : transaction(persist);
}
async function remove(user, tenantId, id) {
    return queryOne('UPDATE presentation_native_documents SET deleted_at=NOW() WHERE id=? AND tenant_id=? AND owner_user_id=? AND deleted_at IS NULL RETURNING id', [id, tenantId, user.id]);
}
async function cleanupCandidates() {
    return query("SELECT id,user_id FROM tool_tasks WHERE tool_name=? AND ((status IN ('completed','cancelled','expired') AND updated_at<NOW()-INTERVAL '1 hour') OR updated_at<NOW()-INTERVAL '24 hours') AND COALESCE((result_json->>'_leaseUntil')::numeric,0)<extract(epoch from NOW()) LIMIT 100", [TOOL]);
}
async function withExecution(user, id, lease, commitResult) {
    return transaction(async client => {
        const job = await client.queryOne("SELECT id FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=? AND (result_json->>'_leaseUntil')::numeric>extract(epoch from NOW()) FOR UPDATE", [id, user.id, TOOL, lease]);
        if (!job) throw invalid('原稿任务已停止或执行租约失效。');
        return commitResult(client);
    });
}

module.exports = { TOOL, list, read, header, versions, readJob, latestJob, admit, claim, checkpoint, release, resume, commit, remove, cleanupCandidates, withExecution };
