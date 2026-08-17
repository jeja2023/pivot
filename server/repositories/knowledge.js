const { sql } = require('../db/statements');
const {
    buildCollectionAccessFilter,
    buildDocumentAccessFilter,
    normalizeKnowledgeUser
} = require('../services/knowledge-access');

function getCollectionForUser(collectionId, user) {
    const access = buildCollectionAccessFilter(user, 'c');
    return sql(`
        SELECT c.*
        FROM knowledge_collections c
        WHERE c.id = ? AND c.deleted_at IS NULL AND ${access.sql}
    `).get(collectionId, ...access.params) || null;
}

function listCollections(user) {
    const normalized = normalizeKnowledgeUser(user);
    const access = buildCollectionAccessFilter(normalized, 'c');
    return sql(`
        SELECT
            c.id,
            c.user_id,
            c.name,
            c.description,
            c.scope,
            c.allowed_units,
            c.allowed_user_ids,
            c.created_at,
            c.updated_at,
            COUNT(d.id) AS doc_count,
            COALESCE(SUM(CASE WHEN d.status = 'ready' THEN 1 ELSE 0 END), 0) AS ready_count,
            COALESCE(SUM(CASE WHEN d.status = 'ready' AND COALESCE(d.is_enabled, 1) = 1 THEN d.chunk_count ELSE 0 END), 0) AS chunk_count
        FROM knowledge_collections c
        LEFT JOIN knowledge_docs d
          ON d.collection_id = c.id
          AND d.user_id = c.user_id
          AND d.deleted_at IS NULL
        WHERE c.deleted_at IS NULL AND ${access.sql}
        GROUP BY c.id
        ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
    `).all(...access.params);
}

function findCollectionByName(userId, name) {
    return sql(`
        SELECT *
        FROM knowledge_collections
        WHERE user_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
    `).get(userId, name) || null;
}

function upsertTags(userId, tags, now) {
    if (!Array.isArray(tags) || tags.length === 0) return [];
    const statement = sql('INSERT INTO knowledge_tags (user_id, tag, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(user_id, tag) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at');
    tags.forEach(tag => statement.run(userId, tag, now, now));
    return tags;
}

function getDocumentForUser(docId, user, { includeDeleted = false } = {}) {
    const access = buildDocumentAccessFilter(user, 'd', 'c');
    return sql(`
        SELECT d.*, c.name AS collection_name, c.scope AS collection_scope,
               c.allowed_units AS collection_allowed_units,
               c.allowed_user_ids AS collection_allowed_user_ids
        FROM knowledge_docs d
        LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
        WHERE d.id = ? ${includeDeleted ? '' : 'AND d.deleted_at IS NULL'}
          AND ${access.sql}
    `).get(docId, ...access.params);
}

function listDocumentTags(docId, user) {
    const access = buildDocumentAccessFilter(user, 'd', 'c');
    return sql(`
        SELECT t.tag
        FROM knowledge_doc_tags t
        JOIN knowledge_docs d ON d.id = t.doc_id AND d.user_id = t.user_id
        LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
        WHERE t.doc_id = ? AND ${access.sql}
        ORDER BY tag COLLATE NOCASE ASC
    `).all(docId, ...access.params).map(row => row.tag);
}

function listDocumentChunks(docId, limit, offset) {
    return sql(`
        SELECT id, content, LENGTH(content) AS length
        FROM knowledge_chunks
        WHERE doc_id = ?
        ORDER BY id ASC
        LIMIT ? OFFSET ?
    `).all(docId, limit, offset);
}

function countDocumentChunks(docId) {
    return sql('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE doc_id = ?').get(docId).count;
}

function listAllDocumentChunks(docId) {
    return sql('SELECT id AS chunkId, content FROM knowledge_chunks WHERE doc_id = ? ORDER BY id ASC').all(docId);
}

function iterateAccessibleChunkEmbeddings({ userId, scopeFilter, user = null }) {
    const ownerFilter = user ? '' : 'AND d.user_id = ?';
    const statement = sql(`
        SELECT c.id, c.content, c.embedding, c.heading_path, d.name
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON c.doc_id = d.id
        ${scopeFilter.accessJoin}
        WHERE c.embedding IS NOT NULL
          AND c.embedding != ''
          ${ownerFilter}
          AND d.status = 'ready'
          AND d.deleted_at IS NULL
          AND COALESCE(d.is_enabled, 1) = 1
          ${scopeFilter.sql}
          ${scopeFilter.accessSql}
    `);
    const params = user
        ? [...scopeFilter.params, ...scopeFilter.accessParams]
        : [userId, ...scopeFilter.params];
    return statement.iterate(...params);
}

function getDocumentName(docId) {
    return sql('SELECT name FROM knowledge_docs WHERE id = ?').get(docId) || {};
}

function getDocumentQualityOverview(userId) {
    return sql(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN status = 'ready' AND COALESCE(is_enabled, 1) = 1 THEN 1 ELSE 0 END) AS readyEnabled,
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN COALESCE(is_enabled, 1) = 0 THEN 1 ELSE 0 END) AS disabled,
            SUM(CASE WHEN status = 'ready' AND COALESCE(chunk_count, 0) = 0 THEN 1 ELSE 0 END) AS emptyReady,
            SUM(CASE WHEN status = 'ready' AND COALESCE(updated_at, processed_at, created_at) < datetime('now', '+8 hours', '-180 days') THEN 1 ELSE 0 END) AS staleReady,
            COALESCE(SUM(chunk_count), 0) AS chunks,
            COALESCE(SUM(source_size), 0) AS sourceSize
        FROM knowledge_docs
        WHERE user_id = ? AND deleted_at IS NULL
    `).get(userId);
}

function listProblemDocuments(userId) {
    return sql(`
        SELECT d.id, d.name, d.status, d.is_enabled, d.chunk_count, d.indexed_chunks,
               d.progress, d.error_message, d.updated_at,
               COALESCE(SUM(CASE WHEN f.helpful = 0 THEN 1 ELSE 0 END), 0) AS unhelpful,
               COALESCE(SUM(CASE WHEN f.helpful = 1 THEN 1 ELSE 0 END), 0) AS helpful
        FROM knowledge_docs d
        LEFT JOIN rag_feedback f ON f.user_id = d.user_id AND f.doc_name = d.name
        WHERE d.user_id = ? AND d.deleted_at IS NULL
        GROUP BY d.id
        HAVING d.status = 'error'
            OR COALESCE(d.is_enabled, 1) = 0
            OR (d.status = 'ready' AND COALESCE(d.chunk_count, 0) = 0)
            OR unhelpful > helpful
        ORDER BY
            CASE
                WHEN d.status = 'error' THEN 0
                WHEN COALESCE(d.is_enabled, 1) = 0 THEN 1
                WHEN COALESCE(d.chunk_count, 0) = 0 THEN 2
                ELSE 3
            END,
            COALESCE(d.updated_at, d.created_at) DESC
        LIMIT 12
    `).all(userId);
}

module.exports = {
    getCollectionForUser,
    listCollections,
    findCollectionByName,
    upsertTags,
    getDocumentForUser,
    listDocumentTags,
    listDocumentChunks,
    countDocumentChunks,
    listAllDocumentChunks,
    iterateAccessibleChunkEmbeddings,
    getDocumentName,
    getDocumentQualityOverview,
    listProblemDocuments
};
