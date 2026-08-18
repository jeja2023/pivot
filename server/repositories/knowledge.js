/**
 * server/repositories/knowledge.js
 * 知识库数据访问层（SQLite / PostgreSQL 双方言）
 *
 * 全部接口返回 Promise，方言差异统一由 db/dialect.js 抽象。
 */
const { query, queryOne, execute } = require('../db/client');
const { nowOffsetExpr, orderNocase } = require('../db/dialect');
const {
    buildCollectionAccessFilter,
    buildDocumentAccessFilter,
    normalizeKnowledgeUser
} = require('../services/knowledge-access');

async function getCollectionForUser(collectionId, user) {
    const access = buildCollectionAccessFilter(user, 'c');
    const row = await queryOne(`
        SELECT c.*
        FROM knowledge_collections c
        WHERE c.id = ? AND c.deleted_at IS NULL AND ${access.sql}
    `, [collectionId, ...access.params]);
    return row || null;
}

function listCollections(user) {
    const normalized = normalizeKnowledgeUser(user);
    const access = buildCollectionAccessFilter(normalized, 'c');
    // is_enabled 在 SQLite 和 PostgreSQL 中均为 BIGINT 0/1 整型，统一使用整数比较
    const isEnabledCond = 'COALESCE(d.is_enabled, 1) != 0';
    return query(`
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
            COALESCE(SUM(CASE WHEN d.status = 'ready' AND ${isEnabledCond} THEN d.chunk_count ELSE 0 END), 0) AS chunk_count
        FROM knowledge_collections c
        LEFT JOIN knowledge_docs d
          ON d.collection_id = c.id
          AND d.user_id = c.user_id
          AND d.deleted_at IS NULL
        WHERE c.deleted_at IS NULL AND ${access.sql}
        GROUP BY c.id
        ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
    `, access.params);
}

async function findCollectionByName(userId, name) {
    const row = await queryOne(`
        SELECT *
        FROM knowledge_collections
        WHERE user_id = ? AND deleted_at IS NULL AND lower(name) = lower(?)
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
    `, [userId, name]);
    return row || null;
}

async function upsertTags(userId, tags, now) {
    if (!Array.isArray(tags) || tags.length === 0) return [];
    for (const tag of tags) {
        await execute(`
            INSERT INTO knowledge_tags (user_id, tag, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, NULL)
            ON CONFLICT(user_id, tag) DO UPDATE
                SET deleted_at = NULL, updated_at = excluded.updated_at
        `, [userId, tag, now, now]);
    }
    return tags;
}

function getDocumentForUser(docId, user, { includeDeleted = false } = {}) {
    const access = buildDocumentAccessFilter(user, 'd', 'c');
    return queryOne(`
        SELECT d.*, c.name AS collection_name, c.scope AS collection_scope,
               c.allowed_units AS collection_allowed_units,
               c.allowed_user_ids AS collection_allowed_user_ids
        FROM knowledge_docs d
        LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
        WHERE d.id = ? ${includeDeleted ? '' : 'AND d.deleted_at IS NULL'}
          AND ${access.sql}
    `, [docId, ...access.params]);
}

async function listDocumentTags(docId, user) {
    const access = buildDocumentAccessFilter(user, 'd', 'c');
    const rows = await query(`
        SELECT t.tag
        FROM knowledge_doc_tags t
        JOIN knowledge_docs d ON d.id = t.doc_id AND d.user_id = t.user_id
        LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
        WHERE t.doc_id = ? AND ${access.sql}
        ORDER BY ${orderNocase('t.tag')} ASC
    `, [docId, ...access.params]);
    return rows.map(row => row.tag);
}

function listDocumentChunks(docId, limit, offset) {
    return query(`
        SELECT id, content, LENGTH(content) AS length
        FROM knowledge_chunks
        WHERE doc_id = ?
        ORDER BY id ASC
        LIMIT ? OFFSET ?
    `, [docId, limit, offset]);
}

async function countDocumentChunks(docId) {
    const row = await queryOne('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE doc_id = ?', [docId]);
    return Number(row?.count || 0);
}

function listAllDocumentChunks(docId) {
    return query(
        'SELECT id AS "chunkId", content FROM knowledge_chunks WHERE doc_id = ? ORDER BY id ASC',
        [docId]
    );
}

/**
 * 拉取可访问的分块向量集合。
 *
 * 历史实现返回 better-sqlite3 的同步迭代器（statement.iterate）；PG 无同源
 * 语义，且调用方随后要在 JS 侧逐条计算余弦相似度，故统一返回数组。
 * 候选集规模由 scopeFilter 与 RAG_CANDIDATE_LIMIT 约束，不会无界膨胀。
 */
function listAccessibleChunkEmbeddings({ userId, scopeFilter, user = null }) {
    const ownerFilter = user ? '' : 'AND d.user_id = ?';
    const params = user
        ? [...scopeFilter.params, ...scopeFilter.accessParams]
        : [userId, ...scopeFilter.params];
    // is_enabled 在 SQLite 和 PostgreSQL 中均为 BIGINT 0/1 整型，统一使用整数比较
    const isEnabledCond = 'COALESCE(d.is_enabled, 1) != 0';
    return query(`
        SELECT c.id, c.content, c.embedding, c.heading_path, d.name
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON c.doc_id = d.id
        ${scopeFilter.accessJoin}
        WHERE c.embedding IS NOT NULL
          AND c.embedding != ''
          ${ownerFilter}
          AND d.status = 'ready'
          AND d.deleted_at IS NULL
          AND ${isEnabledCond}
          ${scopeFilter.sql}
          ${scopeFilter.accessSql}
    `, params);
}

async function getDocumentName(docId) {
    const row = await queryOne('SELECT name FROM knowledge_docs WHERE id = ?', [docId]);
    return row || {};
}

function getDocumentQualityOverview(userId) {
    // is_enabled 在 SQLite 和 PostgreSQL 中均为 BIGINT 0/1 整型，统一使用整数比较
    const isEnabledTrue = 'COALESCE(is_enabled, 1) != 0';
    const isEnabledFalse = 'COALESCE(is_enabled, 1) = 0';
    return queryOne(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN status = 'ready' AND ${isEnabledTrue} THEN 1 ELSE 0 END) AS "readyEnabled",
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN ${isEnabledFalse} THEN 1 ELSE 0 END) AS disabled,
            SUM(CASE WHEN status = 'ready' AND COALESCE(chunk_count, 0) = 0 THEN 1 ELSE 0 END) AS "emptyReady",
            SUM(CASE WHEN status = 'ready' AND COALESCE(updated_at, processed_at, created_at) < ${nowOffsetExpr('-180 days')} THEN 1 ELSE 0 END) AS "staleReady",
            COALESCE(SUM(chunk_count), 0) AS chunks,
            COALESCE(SUM(source_size), 0) AS "sourceSize"
        FROM knowledge_docs
        WHERE user_id = ? AND deleted_at IS NULL
    `, [userId]);
}

function listProblemDocuments(userId) {
    // is_enabled / helpful 在 SQLite 和 PostgreSQL 中均为 BIGINT 0/1 整型，统一使用整数比较
    const isEnabledFalse = 'COALESCE(d.is_enabled, 1) = 0';
    const isHelpfulFalse = 'f.helpful = 0';
    const isHelpfulTrue = 'f.helpful = 1';
    return query(`
        SELECT d.id, d.name, d.status, d.is_enabled, d.chunk_count, d.indexed_chunks,
               d.progress, d.error_message, d.updated_at,
               COALESCE(SUM(CASE WHEN ${isHelpfulFalse} THEN 1 ELSE 0 END), 0) AS unhelpful,
               COALESCE(SUM(CASE WHEN ${isHelpfulTrue} THEN 1 ELSE 0 END), 0) AS helpful
        FROM knowledge_docs d
        LEFT JOIN rag_feedback f ON f.user_id = d.user_id AND f.doc_name = d.name
        WHERE d.user_id = ? AND d.deleted_at IS NULL
        GROUP BY d.id, d.name, d.status, d.is_enabled, d.chunk_count, d.indexed_chunks,
                 d.progress, d.error_message, d.updated_at, d.created_at
        HAVING d.status = 'error'
            OR ${isEnabledFalse}
            OR (d.status = 'ready' AND COALESCE(d.chunk_count, 0) = 0)
            OR COALESCE(SUM(CASE WHEN ${isHelpfulFalse} THEN 1 ELSE 0 END), 0)
             > COALESCE(SUM(CASE WHEN ${isHelpfulTrue} THEN 1 ELSE 0 END), 0)
        ORDER BY
            CASE
                WHEN d.status = 'error' THEN 0
                WHEN ${isEnabledFalse} THEN 1
                WHEN COALESCE(d.chunk_count, 0) = 0 THEN 2
                ELSE 3
            END,
            COALESCE(d.updated_at, d.created_at) DESC
        LIMIT 12
    `, [userId]);
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
    listAccessibleChunkEmbeddings,
    iterateAccessibleChunkEmbeddings: listAccessibleChunkEmbeddings,
    getDocumentName,
    getDocumentQualityOverview,
    listProblemDocuments
};
