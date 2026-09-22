/**
 * server/repositories/knowledge.js
 * 知识库 PostgreSQL 数据访问层。
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
    // is_enabled 以 BIGINT 0/1 存储，统一使用整数比较。
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
            COALESCE(SUM(CASE WHEN d.status IN ('ready', 'lexical_ready') THEN 1 ELSE 0 END), 0) AS ready_count,
            COALESCE(SUM(CASE WHEN d.status IN ('ready', 'lexical_ready') AND ${isEnabledCond} THEN d.chunk_count ELSE 0 END), 0) AS chunk_count
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

function listCollectionResourceDocuments(collectionId, user, limit = 100) {
    const normalizedId = Number.parseInt(collectionId, 10);
    if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) return Promise.resolve([]);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 100);
    const access = buildDocumentAccessFilter(user, 'd', 'c');
    return query(`
        SELECT d.id, d.name, d.status, d.chunk_count, d.updated_at
        FROM knowledge_docs d
        LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
        WHERE d.collection_id = ?
          AND d.deleted_at IS NULL
          AND ${access.sql}
        ORDER BY d.updated_at DESC, d.id DESC
        LIMIT ?
    `, [normalizedId, ...access.params, safeLimit]);
}

function listDocumentChunks(docId, limit, offset) {
    return query(`
        SELECT id, content, chunk_index, char_start, char_end, LENGTH(content) AS length
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
 * 调用方随后要在 JS 侧逐条计算余弦相似度，故统一返回数组。
 * 候选集规模由 scopeFilter 与 RAG_CANDIDATE_LIMIT 约束，不会无界膨胀。
 */
async function listAccessibleChunkEmbeddings({ userId, scopeFilter, user = null, queryVector = null, embeddingProfile = '', limit = null }) {
    const ownerFilter = user ? '' : 'AND d.user_id = ?';
    const accessParams = user
        ? [...scopeFilter.params, ...scopeFilter.accessParams]
        : [userId, ...scopeFilter.params];
    // is_enabled 以 BIGINT 0/1 存储，统一使用整数比较。
    const isEnabledCond = 'COALESCE(d.is_enabled, 1) != 0';
    const vector = Array.isArray(queryVector) && queryVector.length
        ? queryVector.map(value => Number(value)).every(Number.isFinite) ? queryVector : null
        : null;
    const profile = String(embeddingProfile || '').trim().slice(0, 180);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 0, 1), 5000);
    // pgvector 只允许同维度向量参与距离计算。已迁移的新 chunk 用固定维度
    // 谓词查询，能实际命中该维度对应的 HNSW partial index；历史的 NULL/0
    // 维度 chunk 单独以小候选集回退，避免 OR 条件破坏 ANN 查询计划。
    const supportsHnswExpression = vector && Number.isSafeInteger(vector.length) && vector.length > 0 && vector.length <= 2000;
    // 与 partial HNSW 索引的表达式保持字面一致；否则 PostgreSQL 会退化成
    // 精确扫描。profile 也必须相同，不能让同维度的不同 embedding 模型混检。
    const indexedDistanceExpression = supportsHnswExpression
        ? `(c.embedding::vector(${vector.length})) <=> ?::vector`
        : 'c.embedding::vector <=> ?::vector';
    // 旧库的 embedding 可能仍是 TEXT。CASE 保证只有看起来像 pgvector
    // 文本格式的值才会被转换，避免单条坏历史数据中断整次检索。
    const safeEmbeddingDimensions = `CASE
        WHEN trim(c.embedding::text) ~ '^\\s*\\[\\s*-?[0-9]' THEN vector_dims(c.embedding::vector)
        ELSE 0
    END`;
    const selectedColumns = vector
        ? `c.id, c.content, c.heading_path, c.chunk_index, c.char_start, c.char_end, d.name, (1 - (${indexedDistanceExpression})) AS dense_score`
        : 'c.id, c.content, c.embedding, c.heading_path, c.chunk_index, c.char_start, c.char_end, d.name';
    const baseSql = vectorFilter => `
        SELECT ${selectedColumns}
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON c.doc_id = d.id
        ${scopeFilter.accessJoin}
        WHERE c.embedding IS NOT NULL
          ${ownerFilter}
          AND d.status IN ('ready', 'lexical_ready')
          AND d.deleted_at IS NULL
          AND ${isEnabledCond}
          ${scopeFilter.sql}
          ${scopeFilter.accessSql}
          ${vectorFilter}
          ${vector ? `ORDER BY ${indexedDistanceExpression} ASC, c.id ASC LIMIT ?` : 'LIMIT ?'}
    `;
    if (!vector) {
        return await query(baseSql(profile ? 'AND c.embedding_profile = ?' : ''), [
            ...accessParams,
            ...(profile ? [profile] : []),
            safeLimit
        ]);
    }

    const vectorPayload = JSON.stringify(vector);
    const indexedRows = await query(baseSql(`AND c.embedding_dimensions = ? AND (${safeEmbeddingDimensions}) = ?${profile ? ' AND c.embedding_profile = ?' : ''}`), [
        vectorPayload,
        ...accessParams,
        vector.length,
        vector.length,
        ...(profile ? [profile] : []),
        vectorPayload,
        safeLimit
    ]);
    if (indexedRows.length >= safeLimit) return indexedRows;

    // 只为升级期间尚未补齐 profile 的旧记录保留有限回退，避免全库精确扫描。
    const remaining = Math.min(Math.max(safeLimit - indexedRows.length, 1), 200);
    // 空 profile 只可能来自升级前的历史投影；它们不会进入 HNSW 主查询，
    // 仅在剩余 200 条的兼容池中参与，避免旧库升级后语义召回完全消失。
    const legacyRows = await query(baseSql(`AND COALESCE(c.embedding_dimensions, 0) = 0 AND (${safeEmbeddingDimensions}) = ?`), [
        vectorPayload,
        ...accessParams,
        vector.length,
        vectorPayload,
        remaining
    ]);
    return indexedRows.concat(legacyRows).slice(0, safeLimit);
}

function listChunkEmbeddingsByIds(ids = []) {
    const safeIds = [...new Set(ids.map(value => Number.parseInt(value, 10)).filter(value => Number.isSafeInteger(value) && value > 0))].slice(0, 500);
    if (!safeIds.length) return Promise.resolve([]);
    return query(`SELECT id, embedding FROM knowledge_chunks WHERE id IN (${safeIds.map(() => '?').join(',')})`, safeIds);
}

function listCitationKeysByChunkIds(ids = []) {
    const safeIds = [...new Set(ids.map(value => Number.parseInt(value, 10)).filter(value => Number.isSafeInteger(value) && value > 0))].slice(0, 500);
    if (!safeIds.length) return Promise.resolve([]);
    return query(`
        SELECT legacy_chunk_id, citation_key
        FROM knowledge_citations
        WHERE legacy_chunk_id IN (${safeIds.map(() => '?').join(',')})
        ORDER BY id DESC
    `, safeIds);
}

async function getDocumentName(docId) {
    const row = await queryOne('SELECT name FROM knowledge_docs WHERE id = ?', [docId]);
    return row || {};
}

function getDocumentQualityOverview(userId) {
    // is_enabled 以 BIGINT 0/1 存储，统一使用整数比较。
    const isEnabledTrue = 'COALESCE(is_enabled, 1) != 0';
    const isEnabledFalse = 'COALESCE(is_enabled, 1) = 0';
    return queryOne(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status IN ('ready', 'lexical_ready') THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN status IN ('ready', 'lexical_ready') AND ${isEnabledTrue} THEN 1 ELSE 0 END) AS "readyEnabled",
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN ${isEnabledFalse} THEN 1 ELSE 0 END) AS disabled,
            SUM(CASE WHEN status IN ('ready', 'lexical_ready') AND COALESCE(chunk_count, 0) = 0 THEN 1 ELSE 0 END) AS "emptyReady",
            SUM(CASE WHEN status IN ('ready', 'lexical_ready') AND COALESCE(updated_at, processed_at, created_at) < ${nowOffsetExpr('-180 days')} THEN 1 ELSE 0 END) AS "staleReady",
            COALESCE(SUM(chunk_count), 0) AS chunks,
            COALESCE(SUM(source_size), 0) AS "sourceSize"
        FROM knowledge_docs
        WHERE user_id = ? AND deleted_at IS NULL
    `, [userId]);
}

function listProblemDocuments(userId) {
    // is_enabled / helpful 以 BIGINT 0/1 存储，统一使用整数比较。
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
            OR (d.status IN ('ready', 'lexical_ready') AND COALESCE(d.chunk_count, 0) = 0)
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
    listCollectionResourceDocuments,
    listDocumentChunks,
    countDocumentChunks,
    listAllDocumentChunks,
    listAccessibleChunkEmbeddings,
    listChunkEmbeddingsByIds,
    listCitationKeysByChunkIds,
    iterateAccessibleChunkEmbeddings: listAccessibleChunkEmbeddings,
    getDocumentName,
    getDocumentQualityOverview,
    listProblemDocuments
};
