const { query, queryOne, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const {
    MEMORY_STATUS,
    MEMORY_ORIGINS,
    normalizeMemoryOrigin,
    normalizeScopeReference,
    normalizeSourceMessageIds,
    parseJsonArray
} = require('./memory-utils');
const { serializeMemory } = require('./memory-serialization');
const { invalidateMemoryQualityCache } = require('./memory-quality');

async function getMemoryRow(userId, memoryId, options = {}) {
    const id = Number.parseInt(memoryId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const includeDeleted = options.includeDeleted === true;
    return await queryOne(`
        SELECT *
        FROM memories
        WHERE id = ? AND user_id = ?${includeDeleted ? '' : ' AND status != ?'}
    `, includeDeleted ? [id, userId] : [id, userId, MEMORY_STATUS.deleted]);
}

async function getMemorySource(userId, memoryId) {
    const row = await getMemoryRow(userId, memoryId);
    if (!row) return null;
    const sourceIds = parseJsonArray(row.source_message_ids);
    let messages = [];
    if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => '?').join(',');
        const rows = await query(`
            SELECT id, session_id, role, content, created_at
            FROM messages
            WHERE user_id = ?
              AND id IN (${placeholders})
              AND deleted_at IS NULL
            ORDER BY id ASC
        `, [userId, ...sourceIds]);
        messages = rows.map(message => ({
            id: message.id,
            sessionId: message.session_id,
            role: message.role,
            content: message.content || '',
            createdAt: message.created_at || null
        }));
    }
    const session = row.source_session_id
        ? await queryOne('SELECT id, title, created_at, updated_at FROM sessions WHERE id = ? AND user_id = ?', [row.source_session_id, userId])
        : null;
    const evidence = await query(`
        SELECT session_id, message_id, source_kind, asserted_by, created_at
        FROM memory_source_evidence
        WHERE memory_id = ? AND user_id = ?
        ORDER BY created_at ASC, id ASC
    `, [row.id, Number(userId)]);
    return {
        memory: serializeMemory(row),
        session: session ? {
            id: session.id,
            title: session.title || '',
            createdAt: session.created_at || null,
            updatedAt: session.updated_at || null
        } : null,
        messages,
        evidence: evidence.map(item => ({
            sessionId: item.session_id || null,
            messageId: item.message_id ? Number(item.message_id) : null,
            sourceKind: item.source_kind || 'automatic',
            assertedBy: item.asserted_by || 'user',
            createdAt: item.created_at || null
        }))
    };
}

async function revokeMemoriesForSource(userId, options = {}) {
    const sessionId = normalizeScopeReference(options.sessionId || options.session_id);
    const messageIds = normalizeSourceMessageIds(options.messageIds || options.message_ids);
    if (!sessionId && messageIds.length === 0) return { revoked: 0, evidenceRemoved: 0 };
    const where = ['e.user_id = ?'];
    const params = [Number(userId)];
    if (sessionId) {
        where.push('e.session_id = ?');
        params.push(sessionId);
    }
    if (messageIds.length) {
        where.push(`e.message_id IN (${messageIds.map(() => '?').join(',')})`);
        params.push(...messageIds);
    }
    const related = await query(`
        SELECT DISTINCT m.*
        FROM memories m
        JOIN memory_source_evidence e ON e.memory_id = m.id
        WHERE ${where.join(' AND ')} AND m.user_id = ? AND m.status != ?
    `, [...params, Number(userId), MEMORY_STATUS.deleted]);
    if (related.length === 0) return { revoked: 0, evidenceRemoved: 0 };
    const now = getBeijingTimestamp();
    let revoked = 0;
    let evidenceRemoved = 0;
    await transaction(async trx => {
        for (const memory of related) {
            const before = await trx.query(`
                SELECT id FROM memory_source_evidence
                WHERE memory_id = ? AND user_id = ?
            `, [memory.id, Number(userId)]);
            const removalWhere = ['memory_id = ?', 'user_id = ?'];
            const removalParams = [memory.id, Number(userId)];
            if (sessionId) {
                removalWhere.push('session_id = ?');
                removalParams.push(sessionId);
            }
            if (messageIds.length) {
                removalWhere.push(`message_id IN (${messageIds.map(() => '?').join(',')})`);
                removalParams.push(...messageIds);
            }
            evidenceRemoved += await trx.execute(`DELETE FROM memory_source_evidence WHERE ${removalWhere.join(' AND ')}`, removalParams);
            const remaining = await trx.query(`
                SELECT session_id, message_id FROM memory_source_evidence
                WHERE memory_id = ? AND user_id = ? ORDER BY id ASC
            `, [memory.id, Number(userId)]);
            const remainingIds = remaining.map(item => Number(item.message_id)).filter(Number.isSafeInteger).slice(-20);
            const remainingSession = remaining.find(item => item.session_id)?.session_id || null;
            const automatic = [MEMORY_ORIGINS.automatic, MEMORY_ORIGINS.learning].includes(normalizeMemoryOrigin(memory.origin));
            if (before.length > 0 && remaining.length === 0 && automatic) {
                await trx.execute(`
                    UPDATE memories
                    SET status = ?, revoked_at = ?, revocation_reason = ?, source_session_id = NULL,
                        source_message_ids = '[]'::jsonb, updated_at = ?
                    WHERE id = ? AND user_id = ?
                `, [MEMORY_STATUS.deleted, now, String(options.reason || 'source_deleted').slice(0, 80), now, memory.id, Number(userId)]);
                revoked += 1;
            } else {
                await trx.execute(`
                    UPDATE memories
                    SET source_session_id = ?, source_message_ids = ?, updated_at = ?
                    WHERE id = ? AND user_id = ?
                `, [remainingSession, JSON.stringify(remainingIds), now, memory.id, Number(userId)]);
            }
        }
    });
    if (revoked || evidenceRemoved) invalidateMemoryQualityCache(userId);
    return { revoked, evidenceRemoved };
}

async function revokeMemoriesForSourceSession(userId, sessionId, options = {}) {
    return revokeMemoriesForSource(userId, { ...options, sessionId, reason: options.reason || 'source_session_deleted' });
}

async function revokeMemoriesForSourceMessages(userId, messageIds, options = {}) {
    return revokeMemoriesForSource(userId, { ...options, messageIds, reason: options.reason || 'source_message_deleted' });
}

module.exports = {
    getMemorySource,
    revokeMemoriesForSourceSession,
    revokeMemoriesForSourceMessages
};
