'use strict';

const { queryOne, execute } = require('../../db/client');
const { logger: defaultLogger } = require('../../logger');

const MIN_DIMENSIONS = 1;
const MAX_DIMENSIONS = 2000;
const MIN_ROWS_FOR_HNSW = 100;

function normalizeDimensions(value) {
    const dimensions = Number.parseInt(value, 10);
    return Number.isSafeInteger(dimensions) && dimensions >= MIN_DIMENSIONS && dimensions <= MAX_DIMENSIONS
        ? dimensions : null;
}

function indexNameForDimensions(dimensions) {
    const safe = normalizeDimensions(dimensions);
    return safe ? `idx_memories_embedding_hnsw_${safe}` : '';
}

function buildMemoryHnswIndexSql(dimensions) {
    const safe = normalizeDimensions(dimensions);
    if (!safe) throw new Error('长期记忆向量维度不支持 HNSW 索引');
    return `
        CREATE INDEX IF NOT EXISTS ${indexNameForDimensions(safe)}
        ON memories USING hnsw ((embedding::vector(${safe})) vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
        WHERE embedding IS NOT NULL AND embedding_dimensions = ${safe} AND status = 'active'
    `;
}

async function ensureMemoryVectorIndex(dimensions, options = {}) {
    const safe = normalizeDimensions(dimensions);
    if (!safe) return { created: false, reason: 'unsupported_dimensions' };
    const minRows = Math.max(1, Number.parseInt(options.minRows, 10) || MIN_ROWS_FOR_HNSW);
    const countRow = await (options.queryOne || queryOne)(`
        SELECT COUNT(*) AS count FROM memories
        WHERE status = 'active' AND embedding IS NOT NULL AND embedding_dimensions = ?
    `, [safe]);
    const count = Number(countRow?.count || 0);
    if (count < minRows) return { created: false, reason: 'below_threshold', dimensions: safe, count, minRows };
    try {
        await (options.execute || execute)(buildMemoryHnswIndexSql(safe));
        return { created: true, dimensions: safe, count, indexName: indexNameForDimensions(safe) };
    } catch (error) {
        (options.logger || defaultLogger).warn({ err: error.message, dimensions: safe }, '长期记忆 HNSW 索引创建失败，继续精确向量检索');
        return { created: false, reason: 'create_failed', dimensions: safe, count, error: error.message };
    }
}

module.exports = {
    buildMemoryHnswIndexSql,
    ensureMemoryVectorIndex,
    indexNameForDimensions,
    normalizeDimensions
};
