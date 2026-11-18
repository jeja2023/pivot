'use strict';

const { queryOne } = require('../db/client');
async function findTaskRendition(executor, user, tenantId, toolCallId, format, irDigest) {
    return executor.queryOne(`SELECT r.* FROM agent_artifact_renditions r JOIN agent_artifacts a ON a.id=r.artifact_id
        WHERE r.tenant_id=? AND r.created_by=? AND a.user_id=? AND r.tool_call_id=? AND r.format=? AND r.ir_digest=? AND r.status='ready' AND COALESCE(a.status,'active')<>'deleted'
        ORDER BY r.id LIMIT 1`, [tenantId, user.id, user.id, toolCallId, format, irDigest]);
}
async function linkToRun(executor, user, artifactId, runId) {
    const run = await executor.queryOne("SELECT id FROM agent_runs WHERE id=? AND user_id=? AND deleted_at IS NULL AND status NOT IN ('completed','completed_with_errors','partial','cancelled','deleted','failed','error','needs_input') FOR UPDATE", [runId, user.id]);
    if (!run) throw Object.assign(new Error('所属任务已停止，未登记制作产物。'), { code: 'PPT_MASTER_PARENT_STOPPED', status: 409 });
    await executor.execute('UPDATE agent_artifacts SET run_id=? WHERE id=? AND user_id=?', [runId, artifactId, user.id]);
}
async function insert(user, tenantId, artifactId, record, executor = null) {
    const client = executor || { queryOne };
    return client.queryOne(`INSERT INTO agent_artifact_renditions
        (tenant_id,artifact_id,run_id,tool_call_id,created_by,ir_ref,ir_digest,format,renderer_version,content_digest,mime_type,byte_size,storage_ref,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',NOW())
        ON CONFLICT (tenant_id,artifact_id,ir_digest,format,renderer_version) DO UPDATE SET status='ready' RETURNING *`,
    [tenantId, artifactId, record.runId, record.toolCallId, user.id, record.irRef, record.irDigest, record.format, record.rendererVersion,
        record.contentDigest, record.mimeType, record.byteSize, record.storageRef]);
}
module.exports = { insert, findTaskRendition, linkToRun };
