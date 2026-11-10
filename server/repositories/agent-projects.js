'use strict';
const { query, queryOne, transaction } = require('../db/client');
async function list(userId, { status, query: search, offset, limit }) {
    return await query(`SELECT id,title,description,status,version,created_at,updated_at,COUNT(*) OVER() AS total
        FROM agent_projects WHERE user_id=? AND (?='' OR status=?) AND (?='' OR title ILIKE ?)
        ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`, [userId, status, status, search, `%${search.replace(/[\\%_]/g, '\\$&')}%`, limit, offset]);
}
async function read(userId, id, db = { queryOne }) {
    return await db.queryOne('SELECT * FROM agent_projects WHERE id=? AND user_id=?', [id, userId]);
}
async function save(userId, id, data, expectedVersion) {
    return await transaction(async (db) => {
        // 锁定所属账号以串行化项目配额和同项目修订，避免并发创建绕过上限。
        const actor = await db.queryOne("SELECT id FROM users WHERE id=? AND status='active' AND deleted_at IS NULL FOR UPDATE", [userId]);
        if (!actor)
            return { unavailable: true };
        const current = await read(userId, id, db);
        if (expectedVersion !== null && (!current || Number(current.version) !== expectedVersion))
            return { conflict: true };
        if (expectedVersion === null) {
            const count = await db.queryOne('SELECT COUNT(*) AS count FROM agent_projects WHERE user_id=?', [userId]);
            if (Number(count.count) >= 100)
                return { limit: true };
            return await db.queryOne(`INSERT INTO agent_projects(id,user_id,title,description,instructions,collection_ids,artifact_ids,milestones,status)
                VALUES(?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?) RETURNING *`, [id, userId, data.title, data.description, data.instructions, JSON.stringify(data.collectionIds), JSON.stringify(data.artifactIds), JSON.stringify(data.milestones), data.status]);
        }
        return await db.queryOne(`UPDATE agent_projects SET title=?,description=?,instructions=?,collection_ids=?::jsonb,artifact_ids=?::jsonb,
            milestones=?::jsonb,status=?,version=version+1,updated_at=NOW() WHERE id=? AND user_id=? AND version=? RETURNING *`, [data.title, data.description, data.instructions, JSON.stringify(data.collectionIds), JSON.stringify(data.artifactIds), JSON.stringify(data.milestones), data.status, id, userId, expectedVersion]);
    });
}
async function runs(userId, id, limit, offset) {
    return await query(`SELECT r.id,r.title,r.status,r.created_at,r.updated_at,v.outcome_status,COUNT(*) OVER() AS total
        FROM agent_runs r LEFT JOIN agent_verifications v ON v.run_id=r.id AND v.user_id=r.user_id
        WHERE r.user_id=? AND r.deleted_at IS NULL AND pivot_json_extract(r.context_config::text,'{projectId}')=?
        ORDER BY r.created_at DESC,r.id LIMIT ? OFFSET ?`, [userId, id, limit, offset]);
}
async function artifactIds(userId, id, limit, offset) {
    return await query(`SELECT a.id,COUNT(*) OVER() AS total FROM agent_artifacts a JOIN agent_runs r ON r.id=a.run_id AND r.user_id=a.user_id
        WHERE a.user_id=? AND a.status<>'deleted' AND r.deleted_at IS NULL AND pivot_json_extract(r.context_config::text,'{projectId}')=?
        ORDER BY a.updated_at DESC NULLS LAST,a.id DESC LIMIT ? OFFSET ?`, [userId, id, limit, offset]);
}
async function verifiedRun(userId, projectId, runId) {
    return await queryOne(`SELECT r.id FROM agent_runs r JOIN agent_verifications v ON v.run_id=r.id AND v.user_id=r.user_id
        WHERE r.id=? AND r.user_id=? AND pivot_json_extract(r.context_config::text,'{projectId}')=? AND r.deleted_at IS NULL
            AND r.status='completed' AND v.outcome_status='verified'`, [runId, userId, projectId]);
}
async function exportForUser(userId) {
    return await query('SELECT * FROM agent_projects WHERE user_id=? ORDER BY created_at,id', [userId]);
}
async function eraseForUser(userId, db) {
    return await db.execute('DELETE FROM agent_projects WHERE user_id=?', [userId]);
}
module.exports = { list, read, save, runs, artifactIds, verifiedRun, exportForUser, eraseForUser };
