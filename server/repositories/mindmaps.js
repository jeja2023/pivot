'use strict';
const { query, queryOne, transaction } = require('../db/client');
const { error } = require('../../client/common/mindmap-document');
const crypto = require('node:crypto');
const RENDERER_VERSION = 'mindmap-1.2.0';
const missing = () => error('思维导图不存在或无权访问。', 'MINDMAP_NOT_FOUND', 404);
function sharedTenantPredicate() {
    if (!require('../services/enterprise-access').isEnterpriseAccessEnabled()) return 'TRUE';
    return `(SELECT MIN(o.id) FROM team_members tm JOIN teams t ON t.id=tm.team_id AND t.status='active' JOIN organizations o ON o.id=t.organization_id AND o.status='active' WHERE tm.user_id=a.user_id AND tm.status='active')=(SELECT MIN(o.id) FROM team_members tm JOIN teams t ON t.id=tm.team_id AND t.status='active' JOIN organizations o ON o.id=t.organization_id AND o.status='active' WHERE tm.user_id=m.user_id AND tm.status='active')`;
}
async function owned(db, userId, id, lock = false) {
    const row = await db.queryOne(`SELECT a.*,v.version AS current_version,w.enabled AS collaboration_enabled,w.revision AS sharing_revision,w.epoch AS collaboration_epoch,w.y_state,CASE WHEN a.user_id=? THEN 'owner' ELSE m.role END AS access_role FROM agent_artifacts a LEFT JOIN agent_artifact_versions v ON v.id=a.current_version_id LEFT JOIN mindmap_workspaces w ON w.artifact_id=a.id LEFT JOIN mindmap_members m ON m.artifact_id=a.id AND m.user_id=? AND EXISTS(SELECT 1 FROM users u WHERE u.id=m.user_id AND u.deleted_at IS NULL AND COALESCE(u.status,'active')='active') WHERE a.id=? AND (a.user_id=? OR (w.enabled=TRUE AND m.role IN ('viewer','editor') AND ${sharedTenantPredicate()})) AND a.type='mindmap' AND a.status<>'deleted' AND EXISTS(SELECT 1 FROM users u WHERE u.id=a.user_id AND u.deleted_at IS NULL AND COALESCE(u.status,'active')='active') ${lock ? 'FOR UPDATE OF a' : ''}`, [userId, userId, id, userId]);
    if (!row) throw missing();
    return row;
}
const database = { queryOne };
async function get(userId, id, db = database) { return owned(db, userId, id); }
async function list(userId, { page, limit, search, favorite = false, tag = '', scope = 'all' }) {
    const params = [userId, userId, userId, userId, scope, userId, scope, userId, favorite, tag, tag, `%${search.replace(/[\\%_]/g, '\\$&')}%`];
    const statusPredicate = scope === 'trash' ? "a.status='deleted' AND a.user_id=?" : "a.status<>'deleted'";
    if (scope === 'trash') params.splice(params.length - 1, 0, userId);
    const from = `FROM agent_artifacts a LEFT JOIN agent_artifact_versions v ON v.id=a.current_version_id LEFT JOIN mindmap_workspaces w ON w.artifact_id=a.id LEFT JOIN mindmap_members m ON m.artifact_id=a.id AND m.user_id=? LEFT JOIN mindmap_user_settings s ON s.artifact_id=a.id AND s.user_id=? WHERE (a.user_id=? OR (w.enabled=TRUE AND m.role IN ('viewer','editor') AND ${sharedTenantPredicate()})) AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.deleted_at IS NULL AND COALESCE(u.status,'active')='active') AND EXISTS(SELECT 1 FROM users u WHERE u.id=a.user_id AND u.deleted_at IS NULL AND COALESCE(u.status,'active')='active') AND (?<>'owned' OR a.user_id=?) AND (?<>'shared' OR a.user_id<>?) AND (?=FALSE OR s.favorite=TRUE) AND (?='' OR s.tags @> jsonb_build_array(CAST(? AS TEXT))) AND a.type='mindmap' AND ${statusPredicate} AND a.title ILIKE ?`;
    const total = await queryOne(`SELECT COUNT(*) AS count ${from}`, params);
    const rows = await query(`SELECT a.id,a.user_id,a.status,a.title,a.run_id,a.updated_at,a.created_at,a.current_version_id,v.version AS current_version,COALESCE(s.favorite,FALSE) AS favorite,COALESCE(s.tags,'[]') AS tags,w.enabled AS collaboration_enabled,CASE WHEN a.user_id=? THEN 'owner' ELSE m.role END AS access_role ${from} ORDER BY a.updated_at DESC,a.id DESC LIMIT ? OFFSET ?`, [userId, ...params, limit, (page - 1) * limit]);
    return { rows, total: Number(total.count), page, limit };
}
async function version(userId, id, versionId) {
    await get(userId, id);
    const row = await queryOne('SELECT * FROM agent_artifact_versions WHERE artifact_id=? AND id=?', [id, versionId]);
    if (!row) throw missing();
    return row;
}
async function versions(userId, id, page, limit) {
    const artifact = await get(userId, id);
    const total = await queryOne('SELECT COUNT(*) AS count FROM agent_artifact_versions WHERE artifact_id=?', [id]);
    const rows = await query('SELECT id,version,note,created_at FROM agent_artifact_versions WHERE artifact_id=? ORDER BY version DESC LIMIT ? OFFSET ?', [id, limit, (page - 1) * limit]);
    return { artifact, rows, total: Number(total.count), page, limit };
}
async function save({ userId, id, expectedVersionId, requestKey, inputHash, document, note, runId = null, merge, collaborationUpdate, collaborationEpoch }) {
    return transaction(async db => {
        // 同一用户的请求锁覆盖新建和重试；行锁覆盖所有版本写入。
        await db.queryOne('SELECT pg_advisory_xact_lock(hashtext(?))', [`mindmaps:${userId}`]);
        const replay = await db.queryOne('SELECT * FROM mindmap_requests WHERE user_id=? AND request_key=?', [userId, requestKey]);
        if (replay) {
            if (replay.input_hash !== inputHash) throw error('请求标识已用于其他修改，请刷新后重试。', 'MINDMAP_REQUEST_CONFLICT', 409);
            const current = await owned(db, userId, replay.artifact_id);
            if (!['owner','editor'].includes(current.access_role)) throw error('当前账号只有查看权限，不能重试保存。', 'MINDMAP_READ_ONLY', 403);
            if (collaborationUpdate) return { ...current, replay: true };
            const snapshot = await db.queryOne('SELECT id,content,version FROM agent_artifact_versions WHERE id=? AND artifact_id=?', [replay.version_id, replay.artifact_id]);
            return { ...current, content: snapshot.content, current_version_id: snapshot.id, current_version: snapshot.version, replay: true };
        }
        let row = id ? await owned(db, userId, id, true) : null;
        if (row && !['owner','editor'].includes(row.access_role)) throw error('当前账号只有查看权限，请联系所有者授权或另存副本。', 'MINDMAP_READ_ONLY', 403);
        let collaborative;
        let normalized = merge && row ? merge(document, row.content) : document;
        if (collaborationUpdate) {
            if (!row?.collaboration_enabled || !row.y_state || row.collaboration_epoch !== collaborationEpoch) throw error('协作会话已变化，请重载或另存本地副本。', 'MINDMAP_COLLABORATION_DISABLED', 409);
            const base = await db.queryOne('SELECT id FROM agent_artifact_versions WHERE id=? AND artifact_id=?', [expectedVersionId, row.id]);
            if (!base) throw missing();
            const crdt = require('../../client/common/mindmap-crdt'); collaborative = crdt.create();
            try { crdt.apply(collaborative, row.y_state); crdt.apply(collaborative, Buffer.from(collaborationUpdate, 'base64')); normalized = crdt.read(collaborative); }
            catch (_) { collaborative.destroy(); throw error('协作更新无法安全合并，请重载或另存本地副本。', 'MINDMAP_MERGE_INVALID', 409); }
        } else if (row && String(expectedVersionId || '') !== String(row.current_version_id)) throw error('导图已在其他窗口修改，请重载或另存副本。', 'MINDMAP_VERSION_CONFLICT', 409);
        const content = JSON.stringify(normalized);
        if (row && row.content === content) {
            if (collaborative) { await db.queryOne('UPDATE mindmap_workspaces SET y_state=?,updated_at=NOW() WHERE artifact_id=? RETURNING artifact_id', [Buffer.from(require('../../client/common/mindmap-crdt').encode(collaborative)), row.id]); collaborative.destroy(); }
            await db.queryOne('INSERT INTO mindmap_requests(user_id,request_key,input_hash,artifact_id,version_id) VALUES(?,?,?,?,?) RETURNING artifact_id', [userId, requestKey, inputHash, row.id, row.current_version_id]);
            return { ...await owned(db, userId, row.id), unchanged: true };
        }
        if (!row) {
            const total = await db.queryOne("SELECT COUNT(*) AS count FROM agent_artifacts WHERE user_id=? AND type='mindmap' AND status<>'deleted'", [userId]);
            if (Number(total.count) >= 1000) throw error('导图数量已达 1000 份，请整理后再新建。', 'MINDMAP_QUOTA', 409);
            if (runId) {
                const run = await db.queryOne('SELECT id FROM agent_runs WHERE id=? AND user_id=? AND deleted_at IS NULL', [runId, userId]);
                if (!run) throw missing();
            }
            row = await db.queryOne("INSERT INTO agent_artifacts(user_id,run_id,type,title,content,note,status,created_at,updated_at) VALUES(?,?,'mindmap',?,?,?,'active',NOW(),NOW()) RETURNING *", [userId, runId, normalized.tree.text, content, note]);
        }
        const next = await db.queryOne('SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_artifact_versions WHERE artifact_id=?', [row.id]);
        if (Number(next.version) > 1000) throw error('该导图已达 1000 个历史版本，请另存副本继续编辑。', 'MINDMAP_VERSION_QUOTA', 409);
        const snapshot = await db.queryOne('INSERT INTO agent_artifact_versions(artifact_id,version,content,note,created_by,created_at) VALUES(?,?,?,?,?,NOW()) RETURNING id', [row.id, next.version, content, note, userId]);
        await db.queryOne('UPDATE agent_artifacts SET content=?,title=?,note=?,current_version_id=?,version=?,updated_at=NOW() WHERE id=? AND user_id=? RETURNING id', [content, normalized.tree.text, note, snapshot.id, next.version, row.id, row.user_id]);
        if (row.collaboration_enabled) {
            const crdt = require('../../client/common/mindmap-crdt');
            if (!collaborative) { collaborative = crdt.create(); if (row.y_state) crdt.apply(collaborative, row.y_state); crdt.write(collaborative, normalized, 'server'); }
            await db.queryOne('UPDATE mindmap_workspaces SET y_state=?,updated_at=NOW() WHERE artifact_id=? RETURNING artifact_id', [Buffer.from(crdt.encode(collaborative)), row.id]); collaborative.destroy();
        }
        await db.queryOne('INSERT INTO mindmap_requests(user_id,request_key,input_hash,artifact_id,version_id) VALUES(?,?,?,?,?) RETURNING artifact_id', [userId, requestKey, inputHash, row.id, snapshot.id]);
        return owned(db, userId, row.id);
    });
}
async function remove(userId, id, expectedVersionId) {
    return transaction(async db => {
        const row = await owned(db, userId, id, true);
        if (row.access_role !== 'owner') throw error('只有所有者可以删除导图。', 'MINDMAP_OWNER_REQUIRED', 403);
        if (String(row.current_version_id) !== String(expectedVersionId)) throw error('导图版本已更新，请刷新列表后再删除。', 'MINDMAP_VERSION_CONFLICT', 409);
        await db.queryOne("UPDATE agent_artifacts SET status='deleted',updated_at=NOW() WHERE id=? AND user_id=? RETURNING id", [id, userId]);
        return true;
    });
}
async function enqueue(userId, id, versionId, format) {
    if ((await get(userId, id)).access_role !== 'owner') throw error('共享导图请先另存为个人副本，再导出文件。', 'MINDMAP_OWNER_REQUIRED', 403);
    await version(userId, id, versionId);
    return transaction(async db => {
        await db.queryOne('SELECT pg_advisory_xact_lock(hashtext(?))', [`mindmap-exports:${userId}`]);
        const existing = await db.queryOne('SELECT e.*,r.renderer_version FROM mindmap_exports e LEFT JOIN agent_artifact_renditions r ON r.id=e.rendition_id WHERE e.user_id=? AND e.artifact_id=? AND e.version_id=? AND e.format=?', [userId, id, versionId, format]);
        if (existing && existing.status !== 'failed' && !(existing.status === 'ready' && existing.renderer_version !== RENDERER_VERSION)) return existing;
        const active = await db.queryOne("SELECT COUNT(*) AS count FROM mindmap_exports WHERE user_id=? AND status IN ('pending','processing')", [userId]);
        if (Number(active.count) >= 4) throw error('最多同时处理 4 个导出任务，请等待已有任务完成。', 'MINDMAP_EXPORT_BUSY', 429);
        return db.queryOne(`INSERT INTO mindmap_exports(id,user_id,artifact_id,version_id,format) VALUES(?,?,?,?,?) ON CONFLICT(user_id,artifact_id,version_id,format) DO UPDATE SET status='pending',error_message='',updated_at=NOW() RETURNING *`, [crypto.randomUUID(), userId, id, versionId, format]);
    });
}
async function job(userId, id) {
    const row = await queryOne('SELECT * FROM mindmap_exports WHERE id=? AND user_id=?', [id, userId]);
    if (!row) throw missing();
    await get(userId, row.artifact_id);
    return row;
}
async function claimJob() {
    return transaction(async db => {
        const row = await db.queryOne("SELECT * FROM mindmap_exports WHERE status='pending' OR (status='processing' AND lease_until<NOW()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");
        if (!row) return null;
        return db.queryOne("UPDATE mindmap_exports SET status='processing',lease_token=?,lease_until=NOW()+INTERVAL '2 minutes',updated_at=NOW() WHERE id=? RETURNING *", [crypto.randomUUID(), row.id]);
    });
}
async function finishJob(job, renditionId, message = '') {
    return queryOne("UPDATE mindmap_exports SET status=?,rendition_id=?,error_message=?,lease_until=NULL,updated_at=NOW() WHERE id=? AND lease_token=? AND status='processing' AND lease_until>NOW() RETURNING id", [message ? 'failed' : 'ready', renditionId, message, job.id, job.lease_token]);
}
async function registerRendition(job, tenantId, metadata, contentObject, irObject, mimeType, byteSize, digest) {
    return transaction(async db => {
        await owned(db, job.user_id, job.artifact_id, true);
        const currentJob = await db.queryOne("SELECT id FROM mindmap_exports WHERE id=? AND lease_token=? AND status='processing' AND lease_until>NOW() FOR UPDATE", [job.id, job.lease_token]);
        if (!currentJob) throw error('导出任务已被其他处理器接管，请等待最新结果。', 'MINDMAP_EXPORT_LEASE_EXPIRED', 409);
        const existing = await db.queryOne('SELECT * FROM agent_artifact_renditions WHERE tenant_id=? AND artifact_id=? AND ir_digest=? AND format=? AND renderer_version=?', [tenantId, job.artifact_id, metadata.digest, job.format, RENDERER_VERSION]);
        if (existing) return { row: existing, reused: true };
        const row = await db.queryOne(`INSERT INTO agent_artifact_renditions(tenant_id,artifact_id,run_id,tool_call_id,created_by,ir_ref,ir_digest,format,renderer_version,content_digest,mime_type,byte_size,storage_ref,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',NOW()) RETURNING *`, [tenantId, job.artifact_id, `standalone-artifact:${job.artifact_id}`, `mindmap-export:${job.id}`, job.user_id, irObject, metadata.digest, job.format, RENDERER_VERSION, digest, mimeType, byteSize, contentObject]);
        // 引用计数和交付登记同事务提交，进程中断不会留下零引用的有效交付。
        for (const objectId of metadata.objectIds) {
            const updated = await db.queryOne('UPDATE agent_artifact_objects SET ref_count=ref_count+1 WHERE id=? AND tenant_id=? RETURNING id', [objectId, tenantId]);
            if (!updated) throw error('导出文件对象不可用，请重试。', 'MINDMAP_EXPORT_OBJECT_MISSING', 409);
        }
        return { row, reused: false };
    });
}
module.exports = { RENDERER_VERSION, get, list, save, remove, version, versions, enqueue, job, claimJob, finishJob, registerRendition };
