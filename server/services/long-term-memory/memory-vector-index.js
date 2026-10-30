'use strict';

const { queryOne } = require('../../db/client');
const { logger: defaultLogger } = require('../../logger');
const { getPgPool } = require('../../db/pg-connection');

const MIN_DIMENSIONS = 1;
const MAX_DIMENSIONS = 2000;
const MIN_ROWS_FOR_HNSW = 100;
const INDEX_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

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
        CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexNameForDimensions(safe)}
        ON memories USING hnsw ((embedding::vector(${safe})) vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
        WHERE embedding IS NOT NULL AND embedding_dimensions = ${safe} AND status = 'active'
    `;
}

async function createMemoryIndexSafely(dimensions, pool = getPgPool()) {
    const indexName = indexNameForDimensions(dimensions);
    const client = await pool.connect();
    let locked = false;
    let releaseError = null;
    let previousTimeout = null;
    try {
        const timeout = await client.query("SELECT current_setting('statement_timeout') AS timeout");
        previousTimeout = timeout.rows[0]?.timeout || '0';
        await client.query("SELECT set_config('statement_timeout', $1, false)", [String(INDEX_BUILD_TIMEOUT_MS)]);
        const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('pivot:memory-hnsw'), hashtext(current_schema() || ':' || $1)) AS acquired", [indexName]);
        locked = lock.rows[0]?.acquired === true;
        if (!locked) return { created: false, reason: 'build_in_progress' };
        const state = await client.query(`
            SELECT n.nspname AS schema_name, i.indisvalid AS valid,
                   pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS can_inspect_builders,
                   EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.index_relid = c.oid) AS building
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_index i ON i.indexrelid = c.oid
            WHERE n.nspname = current_schema() AND c.relname = $1
        `, [indexName]);
        const existing = state.rows[0];
        if (existing?.valid) return { created: false, reason: 'already_exists' };
        if (existing?.building) return { created: false, reason: 'build_in_progress' };
        // 无法观察其他角色的建索引进程时，不能确定无效索引是否仍在构建。
        if (existing && !existing.can_inspect_builders) return { created: false, reason: 'invalid_index_requires_admin' };
        if (existing) {
            const quote = value => `"${String(value).replace(/"/g, '""')}"`;
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quote(existing.schema_name)}.${quote(indexName)}`);
        }
        await client.query(buildMemoryHnswIndexSql(dimensions));
        return { created: true };
    } finally {
        if (locked) {
            try { await client.query("SELECT pg_advisory_unlock(hashtext('pivot:memory-hnsw'), hashtext(current_schema() || ':' || $1))", [indexName]); }
            catch (error) { releaseError = error; }
        }
        if (previousTimeout !== null) {
            try { await client.query("SELECT set_config('statement_timeout', $1, false)", [previousTimeout]); }
            catch (error) { releaseError = releaseError || error; }
        }
        client.release(releaseError || undefined);
        if (releaseError) throw releaseError;
    }
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
        const result = options.execute
            ? (await options.execute(buildMemoryHnswIndexSql(safe)), { created: true })
            : await createMemoryIndexSafely(safe, options.pool);
        return { ...result, dimensions: safe, count, indexName: indexNameForDimensions(safe) };
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
