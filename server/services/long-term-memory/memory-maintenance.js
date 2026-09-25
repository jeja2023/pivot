const { query, execute, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { logger } = require('../../logger');
const { readTypedEnv } = require('../../config/env-registry');
const { generateEmbedding } = require('../rag-index');
const { MEMORY_STATUS, MEMORY_TYPES } = require('./memory-utils');
const { invalidateMemoryQualityCache } = require('./memory-quality');
const { ensureMemoryVectorIndex } = require('./memory-vector-index');
const { parseEmbedding } = require('./memory-retrieval');
const { isLongTermMemoryEnabled } = require('./memory-gate');

let maintenanceTimer = null;

function embeddingDimensions(embedding) {
    const vector = parseEmbedding(embedding);
    return Array.isArray(vector) ? vector.length : 0;
}

async function maybeGenerateMemoryEmbedding(content, userId, user = null) {
    try {
        return await generateEmbedding(content, null, null, userId, {
            user,
            source: 'memory_embedding'
        });
    } catch (err) {
        logger.warn({ userId, err: err.message }, '长期记忆向量生成失败，将以纯文本存储');
        return null;
    }
}

async function archiveExpiredMemories(userId, options = {}) {
    invalidateMemoryQualityCache(userId);
    const now = getBeijingTimestamp();
    const status = Object.values(MEMORY_STATUS).includes(options.status) ? options.status : MEMORY_STATUS.disabled;
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 500, 1000));
    const rows = await query(`
        SELECT id
        FROM memories
        WHERE user_id = ?
          AND status = ?
          AND expires_at IS NOT NULL
          AND expires_at <= ?
        ORDER BY expires_at ASC, id ASC
        LIMIT ?
    `, [userId, MEMORY_STATUS.active, now, limit]);
    if (rows.length === 0) return { archived: 0, ids: [] };
    const ids = rows.map(row => row.id);
    const changes = await execute(`
        UPDATE memories
        SET status = ?,
            updated_at = ?
        WHERE user_id = ?
          AND id IN (${ids.map(() => '?').join(',')})
    `, [status, now, userId, ...ids]);
    return { archived: changes, ids, status };
}

async function archiveExpiredMemoriesBatch(options = {}) {
    const now = getBeijingTimestamp();
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 500, 5000));
    const rows = await query(`
        SELECT id, user_id
        FROM memories
        WHERE status = ? AND expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC, id ASC LIMIT ?
    `, [MEMORY_STATUS.active, now, limit]);
    if (!rows.length) return { archived: 0, userIds: [] };
    const ids = rows.map(row => row.id);
    const changes = await execute(`
        UPDATE memories
        SET status = ?, revocation_reason = ?, updated_at = ?
        WHERE status = ? AND id IN (${ids.map(() => '?').join(',')})
    `, [MEMORY_STATUS.disabled, 'expired', now, MEMORY_STATUS.active, ...ids]);
    const userIds = [...new Set(rows.map(row => Number(row.user_id)).filter(Number.isSafeInteger))];
    userIds.forEach(invalidateMemoryQualityCache);
    return { archived: changes, userIds };
}

async function archiveStaleLowValueMemoriesBatch(options = {}) {
    const days = Math.max(30, Math.min(Number.parseInt(options.days, 10) || readTypedEnv('LONG_TERM_MEMORY_LOW_VALUE_ARCHIVE_DAYS'), 3650));
    const cutoff = getBeijingTimestamp(new Date(Date.now() - days * 86400000));
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 200, 2000));
    const rows = await query(`
        SELECT id, user_id
        FROM memories
        WHERE status = ?
          AND COALESCE(last_used_at, updated_at, created_at) < ?
          AND salience < 0.35 AND confidence < 0.55
          AND type = ?
        ORDER BY COALESCE(last_used_at, updated_at, created_at) ASC, id ASC
        LIMIT ?
    `, [MEMORY_STATUS.active, cutoff, MEMORY_TYPES.episode, limit]);
    if (!rows.length) return { archived: 0, userIds: [], days };
    const now = getBeijingTimestamp();
    const ids = rows.map(row => row.id);
    const changes = await execute(`
        UPDATE memories
        SET status = ?, revocation_reason = ?, updated_at = ?
        WHERE status = ? AND id IN (${ids.map(() => '?').join(',')})
    `, [MEMORY_STATUS.disabled, 'low_value_unused', now, MEMORY_STATUS.active, ...ids]);
    const userIds = [...new Set(rows.map(row => Number(row.user_id)).filter(Number.isSafeInteger))];
    userIds.forEach(invalidateMemoryQualityCache);
    return { archived: changes, userIds, days };
}

async function recoverMemoryEmbeddings(options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 500));
    const rows = await query(`
        SELECT id, user_id, content
        FROM memories
        WHERE status = ?
          AND (embedding IS NULL OR embedding_status <> 'ready' OR embedding_dimensions <= 0)
        ORDER BY updated_at ASC, id ASC
        LIMIT ?
    `, [MEMORY_STATUS.active, limit]);
    let recovered = 0;
    let skipped = 0;
    let failed = 0;
    const dimensions = new Set();
    for (const row of rows) {
        try {
            if (!(await isLongTermMemoryEnabled(row.user_id))) {
                skipped += 1;
                continue;
            }
            const user = await queryOne('SELECT id, username, nickname, unit, role FROM users WHERE id = ?', [row.user_id]) || { id: row.user_id };
            const embedding = await maybeGenerateMemoryEmbedding(row.content, row.user_id, user);
            const dimensionsCount = embeddingDimensions(embedding);
            if (!embedding || dimensionsCount <= 0) {
                failed += 1;
                continue;
            }
            const changed = await execute(`
                UPDATE memories
                SET embedding = ?, embedding_dimensions = ?, embedding_status = ?, updated_at = ?
                WHERE id = ? AND user_id = ? AND status = ?
            `, [embedding, dimensionsCount, 'ready', getBeijingTimestamp(), row.id, row.user_id, MEMORY_STATUS.active]);
            if (changed > 0) {
                recovered += 1;
                dimensions.add(dimensionsCount);
            }
        } catch (error) {
            failed += 1;
            logger.warn({ memoryId: row.id, userId: row.user_id, err: error.message }, '长期记忆向量恢复失败');
        }
    }
    const indexes = [];
    for (const dimensionsCount of dimensions) {
        indexes.push(await ensureMemoryVectorIndex(dimensionsCount));
    }
    return { scanned: rows.length, recovered, skipped, failed, indexes };
}

function startLongTermMemoryMaintenanceRunner(intervalMs = 6 * 60 * 60 * 1000) {
    if (maintenanceTimer) return maintenanceTimer;
    const safeInterval = Math.max(Number.parseInt(intervalMs, 10) || 6 * 60 * 60 * 1000, 60 * 60 * 1000);
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await archiveExpiredMemoriesBatch();
            await archiveStaleLowValueMemoriesBatch();
            await recoverMemoryEmbeddings({ limit: 50 });
        } catch (error) {
            logger.warn({ err: error.message }, '长期记忆生命周期巡检失败');
        } finally {
            running = false;
        }
    };
    const initial = setTimeout(() => { void tick(); }, 30000);
    initial.unref?.();
    maintenanceTimer = setInterval(() => { void tick(); }, safeInterval);
    maintenanceTimer.unref?.();
    return maintenanceTimer;
}

module.exports = {
    embeddingDimensions,
    maybeGenerateMemoryEmbedding,
    archiveExpiredMemories,
    startLongTermMemoryMaintenanceRunner
};
