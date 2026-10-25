'use strict';
const crypto = require('node:crypto');
const { query, queryOne, transaction } = require('../db/client');
const schema = require('../../client/common/mindmap-document');
const crdt = require('../../client/common/mindmap-crdt');
async function owner(db, userId, id) {
    const row = await db.queryOne("SELECT * FROM agent_artifacts WHERE id=? AND user_id=? AND type='mindmap' AND status<>'deleted' FOR UPDATE", [id, userId]);
    if (!row) throw schema.error('导图不存在或只有所有者可以执行此操作。', 'MINDMAP_OWNER_REQUIRED', 403);
    return row;
}
async function sharing(userId, id) {
    return transaction(async db => {
        await owner(db, userId, id);
        const config = await db.queryOne('SELECT enabled,revision FROM mindmap_workspaces WHERE artifact_id=?', [id]);
        const members = await db.query('SELECT m.user_id,m.role,u.username,u.nickname FROM mindmap_members m JOIN users u ON u.id=m.user_id WHERE m.artifact_id=? ORDER BY m.user_id', [id]);
        return { enabled: config?.enabled === true, revision: Number(config?.revision || 1), members: members.map(member => ({ userId: String(member.user_id), role: member.role, name: member.nickname || member.username })) };
    });
}
async function setSharing(userId, id, { expectedVersionId, expectedRevision, members, enabled }) {
    await transaction(async db => {
        const artifact = await owner(db, userId, id);
        if (String(artifact.current_version_id) !== String(expectedVersionId)) throw schema.error('导图版本已更新，请保存后重新设置共享。', 'MINDMAP_VERSION_CONFLICT', 409);
        const existing = await db.queryOne('SELECT * FROM mindmap_workspaces WHERE artifact_id=? FOR UPDATE', [id]);
        if (Number(existing?.revision || 1) !== expectedRevision) throw schema.error('共享权限已更新，请刷新共享面板。', 'MINDMAP_SHARING_CONFLICT', 409);
        let state = existing?.y_state; let epoch = existing?.epoch || crypto.randomUUID();
        if (enabled && (!existing?.enabled || !state)) { const doc = crdt.create(); try { crdt.write(doc, artifact.content, 'server'); state = Buffer.from(crdt.encode(doc)); } finally { doc.destroy(); } epoch = crypto.randomUUID(); }
        await db.queryOne(`INSERT INTO mindmap_workspaces(artifact_id,enabled,revision,epoch,y_state) VALUES(?,?,2,?,?) ON CONFLICT(artifact_id) DO UPDATE SET enabled=EXCLUDED.enabled,revision=mindmap_workspaces.revision+1,epoch=EXCLUDED.epoch,y_state=EXCLUDED.y_state,updated_at=NOW() RETURNING artifact_id`, [id, enabled, epoch, state || null]);
        await db.queryOne('DELETE FROM mindmap_members WHERE artifact_id=? RETURNING artifact_id', [id]);
        for (const member of enabled ? members : []) await db.queryOne('INSERT INTO mindmap_members(artifact_id,user_id,role) VALUES(?,?,?) RETURNING user_id', [id, member.userId, member.role]);
    });
    return sharing(userId, id);
}
async function settings(userId, id, { favorite, tags }) {
    return transaction(async db => {
        await require('./mindmaps').get(userId, id, db);
        return db.queryOne(`INSERT INTO mindmap_user_settings(artifact_id,user_id,favorite,tags) VALUES(?,?,?,?::jsonb) ON CONFLICT(artifact_id,user_id) DO UPDATE SET favorite=EXCLUDED.favorite,tags=EXCLUDED.tags,updated_at=NOW() RETURNING favorite,tags`, [id, userId, favorite, JSON.stringify(tags)]);
    });
}
async function templates(userId) { return query('SELECT id,name,updated_at FROM mindmap_templates WHERE user_id=? ORDER BY updated_at DESC,id LIMIT 100', [userId]); }
async function tenantTargetIds(userId) {
    return query(`WITH primary_tenants AS(SELECT tm.user_id,MIN(o.id) AS tenant_id FROM team_members tm JOIN teams t ON t.id=tm.team_id AND t.status='active' JOIN organizations o ON o.id=t.organization_id AND o.status='active' WHERE tm.status='active' GROUP BY tm.user_id) SELECT candidate.user_id FROM primary_tenants candidate JOIN primary_tenants actor ON actor.user_id=? AND actor.tenant_id=candidate.tenant_id`, [userId]);
}
async function template(userId, id) {
    const row = await queryOne('SELECT * FROM mindmap_templates WHERE id=? AND user_id=?', [id, userId]);
    if (!row) throw schema.error('模板不存在或无权访问。', 'MINDMAP_TEMPLATE_NOT_FOUND', 404);
    return row;
}
async function saveTemplate(userId, name, content) {
    return transaction(async db => {
        await db.queryOne('SELECT pg_advisory_xact_lock(hashtext(?))', [`mindmap-templates:${userId}`]);
        const existing = await db.queryOne('SELECT id,name,updated_at FROM mindmap_templates WHERE user_id=? AND name=? AND content=? LIMIT 1', [userId, name, JSON.stringify(content)]);
        if (existing) return existing;
        const count = await db.queryOne('SELECT COUNT(*) AS count FROM mindmap_templates WHERE user_id=?', [userId]);
        if (Number(count.count) >= 100) throw schema.error('个人模板最多 100 份，请整理后重试。');
        return db.queryOne('INSERT INTO mindmap_templates(id,user_id,name,content) VALUES(?,?,?,?) RETURNING id,name,updated_at', [crypto.randomUUID(), userId, name, JSON.stringify(content)]);
    });
}
async function removeTemplate(userId, id) {
    const row = await queryOne('DELETE FROM mindmap_templates WHERE id=? AND user_id=? RETURNING id', [id, userId]);
    if (!row) throw schema.error('模板不存在或无权删除。', 'MINDMAP_TEMPLATE_NOT_FOUND', 404);
}
async function recover(userId, id) {
    return transaction(async db => {
        await db.queryOne('SELECT pg_advisory_xact_lock(hashtext(?))', [`mindmaps:${userId}`]);
        const artifact = await db.queryOne("SELECT * FROM agent_artifacts WHERE id=? AND user_id=? AND type='mindmap' FOR UPDATE", [id, userId]);
        if (!artifact) throw schema.error('已删除的导图不存在或无权恢复。', 'MINDMAP_NOT_FOUND', 404);
        if (artifact.status !== 'deleted') return require('./mindmaps').get(userId, id, db);
        const document = schema.normalize(artifact.content); const content = JSON.stringify(document);
        const total = await db.queryOne("SELECT COUNT(*) AS count FROM agent_artifacts WHERE user_id=? AND type='mindmap' AND status<>'deleted'", [userId]);
        if (Number(total.count) >= 1000) throw schema.error('有效导图数量已达上限，请整理后再恢复。');
        const next = await db.queryOne('SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_artifact_versions WHERE artifact_id=?', [id]);
        if (Number(next.version) > 1000) return { copyRequired: true, document };
        const version = await db.queryOne("INSERT INTO agent_artifact_versions(artifact_id,version,content,note,created_by,created_at) VALUES(?,?,?,'从回收站恢复',?,NOW()) RETURNING id", [id, next.version, content, userId]);
        await db.queryOne("UPDATE agent_artifacts SET status='active',content=?,title=?,current_version_id=?,version=?,updated_at=NOW() WHERE id=? AND user_id=? RETURNING id", [content, document.tree.text, version.id, next.version, id, userId]);
        await db.queryOne('UPDATE mindmap_workspaces SET enabled=FALSE,epoch=?,revision=revision+1,y_state=NULL,updated_at=NOW() WHERE artifact_id=? RETURNING artifact_id', [crypto.randomUUID(), id]);
        await db.queryOne('DELETE FROM mindmap_members WHERE artifact_id=? RETURNING user_id', [id]);
        return require('./mindmaps').get(userId, id, db);
    });
}
module.exports = { sharing, setSharing, settings, templates, template, saveTemplate, removeTemplate, recover, tenantTargetIds };
