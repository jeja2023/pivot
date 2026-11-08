'use strict';

const { queryOne } = require('../db/client');
async function insert(user, tenantId, artifactId, record, executor = null) {
    const client = executor || { queryOne };
    return client.queryOne(`INSERT INTO agent_artifact_renditions
        (tenant_id,artifact_id,run_id,tool_call_id,created_by,ir_ref,ir_digest,format,renderer_version,content_digest,mime_type,byte_size,storage_ref,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',NOW())
        ON CONFLICT (tenant_id,artifact_id,ir_digest,format,renderer_version) DO UPDATE SET status='ready' RETURNING *`,
    [tenantId, artifactId, record.runId, record.toolCallId, user.id, record.irRef, record.irDigest, record.format, record.rendererVersion,
        record.contentDigest, record.mimeType, record.byteSize, record.storageRef]);
}
module.exports = { insert };
