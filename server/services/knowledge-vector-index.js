'use strict';

// PostgreSQL pgvector 的 ANN 索引按固定维度建立。embedding 列本身允许历史
// 数据混用维度，因此不能建立一个无条件 HNSW；每个已确认 profile/dimension
// 使用独立 partial index，检索 SQL 同时带 embedding_dimensions 条件。
const { query, execute } = require('../db/client');
const { logger: defaultLogger } = require('../logger');
const crypto = require('crypto');

const MIN_INDEXABLE_DIMENSIONS = 1;
const MAX_HNSW_DIMENSIONS = 2000;
const MIN_ROWS_FOR_HNSW = 100;

function normalizeDimensions(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < MIN_INDEXABLE_DIMENSIONS || parsed > MAX_HNSW_DIMENSIONS) return null;
    return parsed;
}

function indexNameForDimensions(dimensions) {
    const safe = normalizeDimensions(dimensions);
    if (!safe) return '';
    return `idx_knowledge_chunks_embedding_hnsw_${safe}`;
}

function normalizeEmbeddingProfile(value) {
    return String(value || '').trim().slice(0, 180);
}

function indexNameForProfile(dimensions, embeddingProfile = '') {
    const base = indexNameForDimensions(dimensions);
    const profile = normalizeEmbeddingProfile(embeddingProfile);
    if (!base || !profile) return base;
    return `${base}_${crypto.createHash('sha256').update(profile).digest('hex').slice(0, 12)}`;
}

function quoteSqlLiteral(value) {
    return `'${String(value || '').replace(/'/g, "''")}'`;
}

function buildHnswIndexSql(dimensions, embeddingProfile = '', { concurrently = true } = {}) {
    const safe = normalizeDimensions(dimensions);
    if (!safe) throw new Error('向量维度不支持 HNSW 索引');
    const profile = normalizeEmbeddingProfile(embeddingProfile);
    const indexName = indexNameForProfile(safe, profile);
    const profilePredicate = profile ? ` AND embedding_profile = ${quoteSqlLiteral(profile)}` : '';
    return `
        CREATE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${indexName}
        ON knowledge_chunks USING hnsw ((embedding::vector(${safe})) vector_cosine_ops)
        WHERE embedding IS NOT NULL AND embedding_dimensions = ${safe}${profilePredicate}
        WITH (m = 16, ef_construction = 64)
    `;
}

async function ensureKnowledgeVectorIndex(dimensions, embeddingProfile = '', {
    queryFn = query,
    executeFn = execute,
    minRows = MIN_ROWS_FOR_HNSW,
    logger = defaultLogger
} = {}) {
    const safe = normalizeDimensions(dimensions);
    if (!safe) {
        return { created: false, reason: 'unsupported_dimensions', dimensions: Number(dimensions) || 0 };
    }
    const threshold = Math.max(1, Number.parseInt(minRows, 10) || MIN_ROWS_FOR_HNSW);
    const profile = normalizeEmbeddingProfile(embeddingProfile);
    const countRow = await queryFn(`
        SELECT COUNT(*) AS count
        FROM knowledge_chunks
        WHERE embedding IS NOT NULL AND embedding_dimensions = ? ${profile ? 'AND embedding_profile = ?' : ''}
    `, profile ? [safe, profile] : [safe]);
    const count = Number(countRow?.[0]?.count || countRow?.count || 0);
    if (count < threshold) {
        return { created: false, reason: 'below_threshold', dimensions: safe, count, threshold };
    }
    const indexName = indexNameForProfile(safe, profile);
    try {
        await executeFn(buildHnswIndexSql(safe, profile));
        return { created: true, indexName, dimensions: safe, embeddingProfile: profile, count };
    } catch (error) {
        // HNSW 建索引失败不允许影响写入路径：旧版 pgvector、维度超限或数据库
        // 权限不足都继续使用精确向量排序，并保留可观测日志。
        logger.warn({ err: error.message, dimensions: safe, indexName }, '知识库 HNSW 索引创建失败，继续使用精确向量检索');
        return { created: false, reason: 'create_failed', dimensions: safe, embeddingProfile: profile, count, error: error.message };
    }
}

module.exports = {
    buildHnswIndexSql,
    ensureKnowledgeVectorIndex,
    indexNameForProfile,
    normalizeDimensions
};
