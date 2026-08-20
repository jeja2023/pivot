const crypto = require('crypto');
const {
    MEMORY_STATUS,
    MEMORY_TYPE_LABELS,
    MEMORY_JOB_STATUS,
    normalizeMemoryType,
    normalizeSourceMessageIds,
    parseJsonArray
} = require('./memory-utils');

function serializeMemory(row) {
    return {
        id: row.id,
        userId: row.user_id,
        scope: row.scope || 'user',
        type: normalizeMemoryType(row.type),
        typeLabel: MEMORY_TYPE_LABELS[normalizeMemoryType(row.type)],
        content: row.content || '',
        salience: Number(row.salience || 0),
        confidence: Number(row.confidence || 0),
        sourceSessionId: row.source_session_id || '',
        sourceMessageIds: parseJsonArray(row.source_message_ids),
        status: row.status || MEMORY_STATUS.active,
        lastUsedAt: row.last_used_at || null,
        expiresAt: row.expires_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

function serializeMemoryJob(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        sessionId: row.session_id,
        messageIds: parseJsonArray(row.message_ids),
        modelId: row.model_id || null,
        status: row.status || MEMORY_JOB_STATUS.queued,
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || 0),
        lockedAt: row.locked_at || null,
        lastError: row.last_error || '',
        result: row.result
            ? (typeof row.result === 'object' ? row.result : (() => {
                try { return JSON.parse(row.result); } catch (_err) { return null; }
            })())
            : null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        nextRunAt: row.next_run_at || null,
        completedAt: row.completed_at || null
    };
}

function buildMemoryJobDedupeKey(userId, sessionId, messageIds = []) {
    const ids = normalizeSourceMessageIds(messageIds);
    return crypto.createHash('sha256')
        .update(`${userId}:${sessionId}:${ids.join(',')}`)
        .digest('hex');
}

module.exports = {
    serializeMemory,
    serializeMemoryJob,
    buildMemoryJobDedupeKey
};
