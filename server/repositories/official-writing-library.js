const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

async function pageDocuments(userId, { page, limit, query: search, docType, sort }) {
    const order = sort === 'title' ? 'title ASC, id DESC' : sort === 'oldest' ? 'updated_at ASC, id ASC' : 'updated_at DESC, id DESC';
    const where = `user_id = ? AND deleted_at IS NULL
        AND (? = '' OR POSITION(LOWER(?) IN LOWER(title)) > 0)
        AND (? = '' OR summary->>'docType' = ?)`;
    const params = [userId, search, search, docType, docType];
    const total = Number((await queryOne(`SELECT COUNT(*) AS total FROM official_writing_documents WHERE ${where}`, params))?.total || 0);
    const safePage = Math.min(page, Math.max(1, Math.ceil(total / limit)));
    const rows = await query(`SELECT client_id, title, manual_title, summary, artifact_id, version, created_at, updated_at
        FROM official_writing_documents WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, (safePage - 1) * limit]);
    return { rows, total, page: safePage, limit };
}

async function getDocument(userId, clientId) {
    return queryOne(`SELECT client_id, title, manual_title, state, summary, artifact_id, version, created_at, updated_at
        FROM official_writing_documents WHERE user_id = ? AND client_id = ? AND deleted_at IS NULL`, [userId, clientId]);
}

// 持有文档行锁时创建或更新自己的产物，文档绑定和产物版本在同一事务内提交。
async function saveExportArtifact(user, clientId, expectedVersion) {
    return transaction(async trx => {
        const document = await trx.queryOne(`SELECT id, title, state, version, artifact_id FROM official_writing_documents
            WHERE user_id = ? AND client_id = ? AND deleted_at IS NULL FOR UPDATE`, [user.id, clientId]);
        if (!document) return { missing: true };
        if (Number(document.version) !== expectedVersion) return { conflict: true };
        const parsed = JSON.parse(document.state);
        const content = JSON.stringify({ documentId: clientId, draft: parsed.draft || '', source: parsed.source || '', meta: parsed.meta || {} });
        let artifact = document.artifact_id ? await trx.queryOne(`SELECT id, content FROM agent_artifacts
            WHERE id = ? AND user_id = ? AND run_id IS NULL AND type = 'official_writing' FOR UPDATE`, [document.artifact_id, user.id]) : null;
        const now = getBeijingTimestamp();
        if (!artifact) {
            artifact = await trx.queryOne(`INSERT INTO agent_artifacts (run_id, user_id, type, title, content, note, created_at, updated_at)
                VALUES (NULL, ?, 'official_writing', ?, ?, '公文导出', ?, ?) RETURNING id, content`, [user.id, document.title, content, now, now]);
            const version = await trx.queryOne(`INSERT INTO agent_artifact_versions (artifact_id, version, content, note, created_by, created_at)
                VALUES (?, 1, ?, '公文导出', ?, ?) RETURNING id`, [artifact.id, content, user.id, now]);
            await trx.execute('UPDATE agent_artifacts SET current_version_id = ? WHERE id = ?', [version.id, artifact.id]);
            await trx.execute('UPDATE official_writing_documents SET artifact_id = ? WHERE id = ?', [artifact.id, document.id]);
        } else if (artifact.content !== content) {
            const version = await trx.queryOne(`INSERT INTO agent_artifact_versions (artifact_id, version, content, note, created_by, created_at)
                SELECT ?, COALESCE(MAX(version), 0) + 1, ?, '公文导出', ?, ? FROM agent_artifact_versions WHERE artifact_id = ? RETURNING id`,
            [artifact.id, content, user.id, now, artifact.id]);
            await trx.execute(`UPDATE agent_artifacts SET title = ?, content = ?, current_version_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
                [document.title, content, version.id, now, artifact.id, user.id]);
        }
        return { artifactId: String(artifact.id), version: Number(document.version) };
    });
}

module.exports = { getDocument, pageDocuments, saveExportArtifact };
