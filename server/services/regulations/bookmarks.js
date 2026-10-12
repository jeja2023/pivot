const { execute, query, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { normalizeRegulationField, normalizeRegulationId } = require('./shared');

async function saveRegulationBookmark({ userId, documentId, topic = '', note = '' } = {}) {
    const uid = normalizeRegulationId(userId);
    const did = normalizeRegulationId(documentId);
    if (!uid || !did) return null;
    const now = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO regulation_bookmarks (user_id, document_id, topic, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, document_id) DO UPDATE
        SET topic = EXCLUDED.topic, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at
        RETURNING *
    `, [uid, did, normalizeRegulationField(topic, 80), normalizeRegulationField(note, 1000), now, now]);
}

async function listRegulationBookmarks({ userId, documentId = null } = {}) {
    const uid = normalizeRegulationId(userId);
    const did = normalizeRegulationId(documentId);
    if (!uid) return [];
    const clauses = ['b.user_id = ?', 'd.deleted_at IS NULL', "d.status <> 'archived'"];
    const params = [uid];
    if (did) {
        clauses.push('b.document_id = ?');
        params.push(did);
    }
    return await query(`
        SELECT b.*, d.title AS document_title, d.category, d.issuing_body, d.jurisdiction,
               d.current_version_id, v.version_label AS current_version_label
        FROM regulation_bookmarks b
        JOIN regulation_documents d ON d.id = b.document_id
        LEFT JOIN regulation_versions v ON v.id = d.current_version_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY b.topic ASC, b.updated_at DESC, b.id DESC
    `, params);
}

async function deleteRegulationBookmark({ bookmarkId, userId }) {
    const id = normalizeRegulationId(bookmarkId);
    const uid = normalizeRegulationId(userId);
    if (!id || !uid) return false;
    const changed = await execute('DELETE FROM regulation_bookmarks WHERE id = ? AND user_id = ?', [id, uid]);
    return Number(changed || 0) > 0;
}

module.exports = { deleteRegulationBookmark, listRegulationBookmarks, saveRegulationBookmark };
