const { query, queryOne, execute, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { logger } = require('../../logger');

const {
    MEMORY_SETTING_KEY,
    MEMORY_STATUS,
    MEMORY_ORIGINS,
    MEMORY_ASSERTED_BY,
    MEMORY_TYPES,
    MEMORY_TYPE_LABELS,
    MIN_MEMORY_CONTENT_CHARS,
    EXTRACTION_TIMEOUT_MS,
    MODEL_EXTRACTION_TIMEOUT_MS,
    MEMORY_JOB_STATUS,
    clamp,
    normalizeMemoryType,
    normalizeMemoryScope,
    normalizeMemoryOrigin,
    normalizeMemoryAssertedBy,
    normalizeScopeReference,
    normalizeFactKey,
    normalizeMemoryContent,
    normalizeSourceMessageIds,
    parseJsonArray,
    hasSensitiveContent,
    hasUnsafeMemoryInstruction,
    fingerprintMemory,
    createMemoryValidationError,
    normalizeOptionalTimestamp
} = require('./memory-utils');

const { serializeMemory } = require('./memory-serialization');
const {
    extractMemoryCandidatesWithModel,
    extractMemoryCandidatesFromMessages,
    isModelExtractionTimeoutError,
    isModelExtractionCircuitOpen,
    markModelExtractionTimeout,
    clearModelExtractionCooldown
} = require('./memory-extraction');
const { mergeMemoryContent } = require('./memory-merge');
const { ensureMemoryVectorIndex } = require('./memory-vector-index');
const {
    buildLongTermMemoryContextMessage,
    injectLongTermMemoryBeforeLatestUser
} = require('./memory-retrieval');
const { resolveMemoryGovernance } = require('../memory-governance');
const {
    getMemorySummary,
    getMemoryJobSummary,
    getMemoryMergeSuggestions,
    getMemoryQualitySummary,
    invalidateMemoryQualityCache
} = require('./memory-quality');

const {
    isLongTermMemoryEnabled,
    setLongTermMemoryEnabled,
    lockMemoryGateState,
    assertMemoryWriteGate,
    bumpMemoryRevision
} = require('./memory-gate');

const {
    embeddingDimensions,
    maybeGenerateMemoryEmbedding,
    archiveExpiredMemories,
    startLongTermMemoryMaintenanceRunner
} = require('./memory-maintenance');

const {
    recordMemoryUsage,
    compareMemoryRetrievalShadow,
    getMemoryUsage
} = require('./memory-usage');

const {
    getMemorySource,
    revokeMemoriesForSourceMessages,
    revokeMemoriesForSourceSession
} = require('./memory-sources');

const { retrieveLongTermMemories } = require('./memory-retrieval-query');

const {
    setRunMemoryExtractionHandler,
    cancelMemoryExtractionJobs,
    enqueueMemoryExtractionJob,
    scheduleMemoryExtraction,
    processMemoryExtractionJobs,
    listMemoryExtractionJobs,
    retryFailedMemoryExtractionJobs,
    cleanupMemoryExtractionJobs
} = require('./memory-jobs');

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

async function getMemoryById(userId, memoryId, options = {}) {
    const row = await getMemoryRow(userId, memoryId, options);
    return row ? serializeMemory(row) : null;
}

function createMemoryGateError(gate) {
    const error = new Error(!gate.enabled ? '长期记忆已关闭。' : '长期记忆状态已变更，请重试。');
    error.code = !gate.enabled ? 'MEMORY_DISABLED' : 'MEMORY_REVISION_CHANGED';
    error.statusCode = 409;
    return error;
}

async function assertLockedMemoryWriteGate(trx, userId, expectedRevision) {
    const gate = await lockMemoryGateState(userId, trx);
    if (!gate.enabled || Number(gate.revision) !== Number(expectedRevision)) {
        throw createMemoryGateError(gate);
    }
    return gate;
}

async function listMemories(userId, options = {}) {
    const status = String(options.status || MEMORY_STATUS.active);
    const type = options.type ? normalizeMemoryType(options.type) : '';
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 100, 500));
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const search = normalizeMemoryContent(options.search || '').slice(0, 120);
    const where = ['user_id = ?'];
    const params = [userId];
    if (status !== 'all') {
        where.push('status = ?');
        params.push(status);
    }
    if (type) {
        where.push('type = ?');
        params.push(type);
    }
    if (search) {
        where.push('(content LIKE ? OR source_session_id LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
    }
    const rows = await query(`
        SELECT *
        FROM memories
        WHERE ${where.join(' AND ')}
        ORDER BY
            CASE status WHEN 'active' THEN 0 ELSE 1 END,
            salience DESC,
            COALESCE(last_used_at, updated_at, created_at) DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM memories WHERE ${where.join(' AND ')}`, params);
    const total = Number(totalRow?.count || 0);
    const enabled = await isLongTermMemoryEnabled(userId);
    return {
        enabled,
        total,
        memories: rows.map(serializeMemory)
    };
}

async function upsertMemorySuppression(trx, userId, memory, reason = 'user_forget') {
    const fingerprint = fingerprintMemory(memory.type, memory.content);
    await trx.execute(`
        INSERT INTO memory_suppressions (
            user_id, fingerprint, source_session_id, source_message_ids, reason, created_at, released_at, released_by
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, '')
        ON CONFLICT(user_id, fingerprint) DO UPDATE SET
            source_session_id = excluded.source_session_id,
            source_message_ids = excluded.source_message_ids,
            reason = excluded.reason,
            created_at = excluded.created_at,
            released_at = NULL,
            released_by = ''
    `, [
        Number(userId),
        fingerprint,
        memory.source_session_id || null,
        JSON.stringify(parseJsonArray(memory.source_message_ids)),
        String(reason || 'user_forget').slice(0, 80),
        getBeijingTimestamp()
    ]);
    return fingerprint;
}

async function softDeleteMemory(userId, memoryId, options = {}) {
    const id = Number.parseInt(memoryId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    invalidateMemoryQualityCache(userId);
    const now = getBeijingTimestamp();
    let deleted = false;
    await transaction(async trx => {
        const memory = await trx.queryOne(`
            SELECT * FROM memories
            WHERE id = ? AND user_id = ? AND status != ?
            FOR UPDATE
        `, [id, Number(userId), MEMORY_STATUS.deleted]);
        if (!memory) return;
        await bumpMemoryRevision(userId, trx);
        if (options.suppress !== false) {
            await upsertMemorySuppression(trx, userId, memory, options.reason || 'user_forget');
        }
        await trx.execute(`
            UPDATE memories
            SET status = ?, revoked_at = ?, revocation_reason = ?, updated_at = ?
            WHERE id = ? AND user_id = ? AND status != ?
        `, [
            MEMORY_STATUS.deleted,
            now,
            String(options.reason || 'user_forget').slice(0, 80),
            now,
            id,
            Number(userId),
            MEMORY_STATUS.deleted
        ]);
        deleted = true;
    });
    return deleted;
}

async function updateMemoryStatus(userId, memoryId, status) {
    if (status === MEMORY_STATUS.deleted) return softDeleteMemory(userId, memoryId);
    invalidateMemoryQualityCache(userId);
    const normalized = Object.values(MEMORY_STATUS).includes(status) ? status : MEMORY_STATUS.active;
    const now = getBeijingTimestamp();
    const changes = await execute(`
        UPDATE memories
        SET status = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [normalized, now, memoryId, userId]);
    return changes > 0;
}

function normalizeMemoryIds(ids = []) {
    const values = Array.isArray(ids) ? ids : [ids];
    return [...new Set(values
        .map(id => Number.parseInt(id, 10))
        .filter(id => Number.isSafeInteger(id) && id > 0))]
        .slice(0, 500);
}

async function updateMemoryStatuses(userId, memoryIds = [], status = MEMORY_STATUS.active) {
    invalidateMemoryQualityCache(userId);
    const ids = normalizeMemoryIds(memoryIds);
    if (ids.length === 0) return { updated: 0 };
    const normalized = Object.values(MEMORY_STATUS).includes(status) ? status : MEMORY_STATUS.active;
    if (normalized === MEMORY_STATUS.deleted) {
        const results = await Promise.all(ids.map(id => softDeleteMemory(userId, id)));
        return { updated: results.filter(Boolean).length, ids };
    }
    const now = getBeijingTimestamp();
    const changes = await execute(`
        UPDATE memories
        SET status = ?, updated_at = ?
        WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
    `, [normalized, now, userId, ...ids]);
    return { updated: changes, ids };
}

async function exportMemories(userId, options = {}) {
    const pageSize = Math.max(1, Math.min(Number.parseInt(options.pageSize || options.limit, 10) || 500, 500));
    const maxRecords = Math.max(pageSize, Math.min(Number.parseInt(options.maxRecords, 10) || 10000, 100000));
    const memories = [];
    let offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    let total = 0;
    let enabled = true;
    while (memories.length < maxRecords) {
        const listed = await listMemories(userId, {
            status: options.status || 'all',
            type: options.type || '',
            search: options.search || '',
            limit: Math.min(pageSize, maxRecords - memories.length),
            offset
        });
        total = listed.total;
        enabled = listed.enabled;
        memories.push(...listed.memories);
        offset += listed.memories.length;
        if (listed.memories.length < pageSize || offset >= total) break;
    }
    const summary = await getMemorySummary(userId);
    return {
        exportedAt: getBeijingTimestamp(),
        version: 2,
        summary,
        enabled,
        total,
        complete: memories.length >= total,
        nextOffset: memories.length >= total ? null : offset,
        memories
    };
}

async function updateMemory(userId, memoryId, updates = {}, options = {}) {
    invalidateMemoryQualityCache(userId);
    const writeGate = await assertMemoryWriteGate(userId);
    if (!writeGate.allowed) throw createMemoryGateError(writeGate.gate);
    const existing = await getMemoryRow(userId, memoryId);
    if (!existing) return null;
    const hasContent = Object.prototype.hasOwnProperty.call(updates, 'content');
    const content = hasContent ? normalizeMemoryContent(updates.content) : existing.content;
    if (content.length < MIN_MEMORY_CONTENT_CHARS) {
        throw createMemoryValidationError('Memory content is too short');
    }
    if (hasSensitiveContent(content) || hasUnsafeMemoryInstruction(content)) {
        throw createMemoryValidationError('Sensitive or instruction-like content cannot be stored as long-term memory', 'UNSAFE_MEMORY');
    }
    const type = Object.prototype.hasOwnProperty.call(updates, 'type') ? normalizeMemoryType(updates.type) : normalizeMemoryType(existing.type);
    const scope = Object.prototype.hasOwnProperty.call(updates, 'scope') ? normalizeMemoryScope(updates.scope) : normalizeMemoryScope(existing.scope);
    const scopeReference = Object.prototype.hasOwnProperty.call(updates, 'scopeReference')
        ? normalizeScopeReference(updates.scopeReference)
        : normalizeScopeReference(existing.scope_reference);
    const projectId = Object.prototype.hasOwnProperty.call(updates, 'projectId')
        ? normalizeScopeReference(updates.projectId)
        : normalizeScopeReference(existing.project_id);
    const factKey = Object.prototype.hasOwnProperty.call(updates, 'factKey')
        ? normalizeFactKey(updates.factKey, type, content)
        : normalizeFactKey(existing.fact_key, type, content);
    const salience = Object.prototype.hasOwnProperty.call(updates, 'salience')
        ? clamp(updates.salience, 0, 1, Number(existing.salience || 0.5))
        : Number(existing.salience || 0.5);
    const confidence = Object.prototype.hasOwnProperty.call(updates, 'confidence')
        ? clamp(updates.confidence, 0, 1, Number(existing.confidence || 0.6))
        : Number(existing.confidence || 0.6);
    const status = Object.prototype.hasOwnProperty.call(updates, 'status') && Object.values(MEMORY_STATUS).includes(updates.status)
        ? updates.status
        : existing.status;
    if (status === MEMORY_STATUS.deleted) {
        throw createMemoryValidationError('Use delete endpoint to remove a memory');
    }
    const expiresAt = Object.prototype.hasOwnProperty.call(updates, 'expiresAt') || Object.prototype.hasOwnProperty.call(updates, 'expires_at')
        ? normalizeOptionalTimestamp(updates.expiresAt ?? updates.expires_at)
        : existing.expires_at;
    const validFrom = Object.prototype.hasOwnProperty.call(updates, 'validFrom') || Object.prototype.hasOwnProperty.call(updates, 'valid_from')
        ? normalizeOptionalTimestamp(updates.validFrom ?? updates.valid_from)
        : existing.valid_from;
    const now = getBeijingTimestamp();
    const embedding = hasContent && content !== existing.content && !options.skipEmbedding
        ? await maybeGenerateMemoryEmbedding(content, userId, options.user || null)
        : existing.embedding;
    const revisionChanged = content !== existing.content
        || type !== normalizeMemoryType(existing.type)
        || factKey !== normalizeFactKey(existing.fact_key, existing.type, existing.content);
    if (revisionChanged) {
        const updated = await transaction(async trx => {
            await assertLockedMemoryWriteGate(trx, userId, writeGate.gate.revision);
            const inserted = await trx.queryOne(`
                INSERT INTO memories (
                    user_id, scope, scope_reference, project_id, type, governance_class, retention_mode,
                    sensitive, origin, asserted_by, fact_key, supersedes_id, content, embedding, embedding_status,
                    embedding_dimensions, search_content, salience, confidence, source_session_id, source_message_ids,
                    status, valid_from, expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
            `, [
                Number(userId), scope, scopeReference, projectId, type,
                existing.governance_class || 'fact', existing.retention_mode || 'persistent',
                existing.sensitive === true || existing.sensitive === 1,
                normalizeMemoryOrigin(existing.origin), normalizeMemoryAssertedBy(existing.asserted_by),
                factKey, existing.id, content, embedding, embedding ? 'ready' : 'lexical_ready', embeddingDimensions(embedding), content,
                salience, confidence, existing.source_session_id || null,
                JSON.stringify(parseJsonArray(existing.source_message_ids)), status, validFrom, expiresAt, now, now
            ]);
            await trx.execute(`
                INSERT INTO memory_source_evidence (
                    memory_id, user_id, session_id, message_id, source_kind, asserted_by, evidence_excerpt, created_at
                )
                SELECT ?, user_id, session_id, message_id, source_kind, asserted_by, evidence_excerpt, ?
                FROM memory_source_evidence WHERE memory_id = ? AND user_id = ?
                ON CONFLICT(memory_id, message_id) DO NOTHING
            `, [inserted.id, now, existing.id, Number(userId)]);
            await trx.execute(`
                UPDATE memories
                SET status = ?, revocation_reason = ?, updated_at = ?
                WHERE id = ? AND user_id = ?
            `, [MEMORY_STATUS.disabled, 'superseded', now, existing.id, Number(userId)]);
            return inserted;
        });
        return serializeMemory(updated);
    }
    const updated = await transaction(async trx => {
        await assertLockedMemoryWriteGate(trx, userId, writeGate.gate.revision);
        await trx.execute(`
            UPDATE memories
            SET scope = ?,
                scope_reference = ?,
                project_id = ?,
                type = ?,
                fact_key = ?,
                content = ?,
                embedding = ?,
                embedding_status = ?,
                embedding_dimensions = ?,
                search_content = ?,
                salience = ?,
                confidence = ?,
                status = ?,
                valid_from = ?,
                expires_at = ?,
                updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [
            scope,
            scopeReference,
            projectId,
            type,
            factKey,
            content,
            embedding,
            embedding ? 'ready' : 'lexical_ready',
            embeddingDimensions(embedding),
            content,
            salience,
            confidence,
            status,
            validFrom,
            expiresAt,
            now,
            existing.id,
            userId
        ]);
        return await trx.queryOne('SELECT * FROM memories WHERE id = ? AND user_id = ?', [existing.id, userId]);
    });
    return serializeMemory(updated);
}

async function mergeMemories(userId, targetId, sourceId, options = {}) {
    const normalizedTargetId = Number.parseInt(targetId, 10);
    const normalizedSourceId = Number.parseInt(sourceId, 10);
    if (!Number.isSafeInteger(normalizedTargetId) || !Number.isSafeInteger(normalizedSourceId) || normalizedTargetId === normalizedSourceId) {
        throw createMemoryValidationError('Invalid memory merge target');
    }
    const target = await getMemoryRow(userId, normalizedTargetId);
    const source = await getMemoryRow(userId, normalizedSourceId);
    if (!target || !source) return null;
    if (normalizeMemoryType(target.type) !== normalizeMemoryType(source.type)) {
        throw createMemoryValidationError('Only memories of the same type can be merged');
    }
    if (normalizeMemoryScope(target.scope) !== normalizeMemoryScope(source.scope)
        || normalizeScopeReference(target.scope_reference) !== normalizeScopeReference(source.scope_reference)
        || normalizeScopeReference(target.project_id) !== normalizeScopeReference(source.project_id)) {
        throw createMemoryValidationError('Only memories in the same scope can be merged', 'MEMORY_SCOPE_MISMATCH');
    }
    const writeGate = await assertMemoryWriteGate(userId);
    if (!writeGate.allowed) throw createMemoryGateError(writeGate.gate);
    const now = getBeijingTimestamp();
    const content = mergeMemoryContent(target, source);
    if (hasSensitiveContent(content) || hasUnsafeMemoryInstruction(content)) {
        throw createMemoryValidationError('Sensitive or instruction-like content cannot be stored as long-term memory', 'UNSAFE_MEMORY');
    }
    const sourceMessageIds = [...new Set([
        ...parseJsonArray(target.source_message_ids),
        ...parseJsonArray(source.source_message_ids)
    ])].slice(-20);
    const embedding = options.skipEmbedding
        ? target.embedding
        : await maybeGenerateMemoryEmbedding(content, userId, options.user || null);

    await transaction(async (trx) => {
        await assertLockedMemoryWriteGate(trx, userId, writeGate.gate.revision);
        await trx.execute(`
            UPDATE memories
            SET content = ?,
                embedding = ?,
                embedding_status = ?,
                embedding_dimensions = ?,
                salience = ?,
                confidence = ?,
                source_session_id = COALESCE(source_session_id, ?),
                source_message_ids = ?,
                updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [
            content,
            embedding,
            embedding ? 'ready' : 'lexical_ready',
            embeddingDimensions(embedding),
            Math.max(Number(target.salience || 0), Number(source.salience || 0)),
            Math.max(Number(target.confidence || 0), Number(source.confidence || 0)),
            source.source_session_id || null,
            JSON.stringify(sourceMessageIds),
            now,
            target.id,
            userId
        ]);
        await trx.execute(`
                INSERT INTO memory_source_evidence (
                memory_id, user_id, session_id, message_id, source_kind, asserted_by, evidence_excerpt, created_at
            )
            SELECT ?, user_id, session_id, message_id, source_kind, asserted_by, evidence_excerpt, ?
            FROM memory_source_evidence WHERE memory_id = ? AND user_id = ?
            ON CONFLICT(memory_id, message_id) DO NOTHING
        `, [target.id, now, source.id, Number(userId)]);
        await trx.execute(`
            UPDATE memories
            SET status = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [MEMORY_STATUS.deleted, now, source.id, userId]);
    });

    invalidateMemoryQualityCache(userId);
    const updatedTarget = await queryOne('SELECT * FROM memories WHERE id = ? AND user_id = ?', [target.id, userId]);
    return {
        merged: true,
        target: serializeMemory(updatedTarget),
        deletedSourceId: source.id
    };
}

async function findSimilarMemory(userId, type, content, factKey = '', scope = {}) {
    const fingerprint = fingerprintMemory(type, content);
    const normalizedScope = normalizeMemoryScope(scope.scope);
    const scopeReference = normalizeScopeReference(scope.scopeReference || scope.scope_reference);
    const projectId = normalizeScopeReference(scope.projectId || scope.project_id);
    const rows = await query(`
        SELECT *
        FROM memories
        WHERE user_id = ? AND type = ? AND status = ?
          AND scope = ?
          AND COALESCE(scope_reference, '') = ?
          AND COALESCE(project_id, '') = ?
        ORDER BY updated_at DESC, id DESC
    `, [userId, type, MEMORY_STATUS.active, normalizedScope, scopeReference, projectId]);
    const exact = rows.find(row => fingerprintMemory(row.type, row.content) === fingerprint) || null;
    const sameFact = factKey
        ? rows.find(row => String(row.fact_key || '') === String(factKey) && !exact) || null
        : null;
    return { exact, sameFact };
}

async function areCandidateSourcesActive(userId, candidate = {}, origin = MEMORY_ORIGINS.automatic) {
    if (![MEMORY_ORIGINS.automatic, MEMORY_ORIGINS.learning].includes(normalizeMemoryOrigin(origin))) return true;
    const sessionId = normalizeScopeReference(candidate.sourceSessionId || candidate.source_session_id);
    if (sessionId) {
        const session = await queryOne('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [sessionId, Number(userId)]);
        if (!session) return false;
    }
    const sourceMessageIds = normalizeSourceMessageIds(candidate.sourceMessageIds);
    if (!sourceMessageIds.length) return true;
    const row = await queryOne(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE user_id = ? AND deleted_at IS NULL AND id IN (${sourceMessageIds.map(() => '?').join(',')})
    `, [Number(userId), ...sourceMessageIds]);
    return Number(row?.count || 0) === sourceMessageIds.length;
}

async function findActiveMemorySuppression(userId, fingerprint, candidate = {}) {
    const rows = await query(`
        SELECT id, fingerprint, source_session_id, source_message_ids
        FROM memory_suppressions
        WHERE user_id = ? AND released_at IS NULL
        ORDER BY id DESC LIMIT 500
    `, [Number(userId)]);
    const sourceSessionId = normalizeScopeReference(candidate.sourceSessionId || candidate.source_session_id);
    const sourceMessageIds = new Set(normalizeSourceMessageIds(candidate.sourceMessageIds));
    return rows.find(row => {
        if (String(row.fingerprint || '') === fingerprint) return true;
        if (sourceSessionId && String(row.source_session_id || '') === sourceSessionId) return true;
        const suppressedIds = parseJsonArray(row.source_message_ids).map(Number);
        return suppressedIds.some(id => sourceMessageIds.has(id));
    }) || null;
}

async function writeMemoryEvidence(trx, memoryId, userId, candidate = {}, origin = MEMORY_ORIGINS.automatic, assertedBy = MEMORY_ASSERTED_BY.user) {
    const sourceMessageIds = normalizeSourceMessageIds(candidate.sourceMessageIds);
    const sessionId = String(candidate.sourceSessionId || '').trim() || null;
    const excerpts = new Map((Array.isArray(candidate.sourceEvidence) ? candidate.sourceEvidence : [])
        .map(item => [Number(item?.messageId ?? item?.message_id), normalizeMemoryContent(item?.excerpt || item?.evidenceExcerpt || '').slice(0, 400)])
        .filter(([messageId, excerpt]) => Number.isSafeInteger(messageId) && messageId > 0 && excerpt));
    if (sourceMessageIds.length === 0) return;
    for (const messageId of sourceMessageIds) {
        await trx.execute(`
            INSERT INTO memory_source_evidence (
                memory_id, user_id, session_id, message_id, source_kind, asserted_by, evidence_excerpt, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(memory_id, message_id) DO UPDATE SET
                session_id = COALESCE(excluded.session_id, memory_source_evidence.session_id),
                source_kind = excluded.source_kind,
                asserted_by = excluded.asserted_by,
                evidence_excerpt = CASE
                    WHEN excluded.evidence_excerpt <> '' THEN excluded.evidence_excerpt
                    ELSE memory_source_evidence.evidence_excerpt
                END
        `, [
            Number(memoryId),
            Number(userId),
            sessionId,
            messageId,
            normalizeMemoryOrigin(origin),
            normalizeMemoryAssertedBy(assertedBy),
            excerpts.get(messageId) || '',
            getBeijingTimestamp()
        ]);
    }
}

async function stagePendingMemory(userId, candidate, options, fields = {}) {
    const now = getBeijingTimestamp();
    const existing = await queryOne(`
        SELECT id FROM memories
        WHERE user_id = ? AND type = ? AND fact_key = ? AND status IN (?, ?)
        ORDER BY id DESC LIMIT 1
    `, [Number(userId), fields.type, fields.factKey, MEMORY_STATUS.active, MEMORY_STATUS.pending]);
    if (existing) return { staged: true, deduped: true, id: existing.id, reason: 'confirmation_required' };
    const row = await transaction(async trx => {
        const lockedGate = await lockMemoryGateState(userId, trx);
        if (!lockedGate.enabled || lockedGate.revision !== Number(options.memoryRevision || 0)) {
            const error = new Error('记忆写入门禁状态已变化。');
            error.code = !lockedGate.enabled ? 'MEMORY_DISABLED' : 'MEMORY_REVISION_CHANGED';
            throw error;
        }
        const inserted = await trx.queryOne(`
            INSERT INTO memories (
                user_id, scope, scope_reference, project_id, type, governance_class, retention_mode,
                sensitive, origin, asserted_by, fact_key, content, embedding, embedding_dimensions, embedding_status,
                search_content, salience, confidence, source_session_id, source_message_ids,
                status, valid_from, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?, ?, ?, NULL, 0, 'lexical_ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [
            Number(userId),
            fields.scope,
            fields.scopeReference,
            fields.projectId,
            fields.type,
            fields.governance.category,
            fields.governance.retentionMode,
            fields.origin,
            fields.assertedBy,
            fields.factKey,
            fields.content,
            fields.content,
            fields.salience,
            fields.confidence,
            candidate.sourceSessionId || null,
            JSON.stringify(fields.sourceMessageIds),
            MEMORY_STATUS.pending,
            normalizeOptionalTimestamp(candidate.validFrom || candidate.valid_from) || now,
            candidate.expiresAt || null,
            now,
            now
        ]);
        await writeMemoryEvidence(trx, inserted.id, userId, candidate, fields.origin, fields.assertedBy);
        return inserted;
    });
    invalidateMemoryQualityCache(userId);
    return { staged: true, id: row?.id, reason: 'confirmation_required' };
}

async function upsertMemory(userId, candidate, options = {}) {
    const content = normalizeMemoryContent(candidate.content);
    if (content.length < MIN_MEMORY_CONTENT_CHARS || hasSensitiveContent(content) || hasUnsafeMemoryInstruction(content)) {
        return { skipped: true, reason: 'invalid_or_sensitive' };
    }
    const gate = await assertMemoryWriteGate(userId, options);
    if (!gate.allowed) return { skipped: true, reason: gate.reason };
    const type = normalizeMemoryType(candidate.type);
    const origin = normalizeMemoryOrigin(candidate.origin || options.origin);
    const assertedBy = normalizeMemoryAssertedBy(candidate.assertedBy || options.assertedBy,
        origin === MEMORY_ORIGINS.learning ? MEMORY_ASSERTED_BY.system : MEMORY_ASSERTED_BY.user);
    if (options.requireActiveSources === true && !(await areCandidateSourcesActive(userId, candidate, origin))) {
        return { skipped: true, reason: 'source_revoked' };
    }
    const governance = await resolveMemoryGovernance(userId, {
        type,
        category: candidate.governanceClass || candidate.category,
        content,
        retentionMode: candidate.retentionMode,
        origin,
        explicit: origin === MEMORY_ORIGINS.explicit
    }, options);
    const scope = normalizeMemoryScope(candidate.scope);
    const scopeReference = normalizeScopeReference(candidate.scopeReference || candidate.scope_reference);
    const projectId = normalizeScopeReference(candidate.projectId || candidate.project_id);
    const salience = clamp(candidate.salience, 0, 1, 0.5);
    const confidence = clamp(candidate.confidence, 0, 1, 0.6);
    const sourceMessageIds = normalizeSourceMessageIds(candidate.sourceMessageIds);
    const factKey = normalizeFactKey(candidate.factKey || candidate.fact_key, type, content);
    const validFrom = normalizeOptionalTimestamp(candidate.validFrom || candidate.valid_from) || getBeijingTimestamp();
    if (!governance.allowed) {
        if (governance.reason === 'confirmation_required' && options.stagePending === true) {
            return stagePendingMemory(userId, candidate, options, {
                type, origin, assertedBy, governance, scope, scopeReference, projectId,
                salience, confidence, sourceMessageIds, factKey, content
            });
        }
        return { skipped: true, reason: governance.reason || 'memory_policy_blocked' };
    }
    const fingerprint = fingerprintMemory(type, content);
    const suppression = await findActiveMemorySuppression(userId, fingerprint, candidate);
    if (suppression && !(origin === MEMORY_ORIGINS.explicit && options.confirmed === true)) {
        return { skipped: true, reason: 'suppressed_by_user' };
    }
    const now = getBeijingTimestamp();
    const similar = await findSimilarMemory(userId, type, content, factKey, {
        scope,
        scopeReference,
        projectId
    });
    const existing = similar.exact;

    if (existing) {
        invalidateMemoryQualityCache(userId);
        const mergedMessageIds = [...new Set([
            ...parseJsonArray(existing.source_message_ids),
            ...sourceMessageIds
        ])].slice(-20);
        await transaction(async trx => {
            const lockedGate = await lockMemoryGateState(userId, trx);
            if (!lockedGate.enabled || lockedGate.revision !== gate.gate.revision) {
                const error = new Error('记忆写入门禁状态已变化。');
                error.code = !lockedGate.enabled ? 'MEMORY_DISABLED' : 'MEMORY_REVISION_CHANGED';
                throw error;
            }
            await trx.execute(`
                UPDATE memories
                SET scope = ?, scope_reference = ?, project_id = ?, salience = ?, confidence = ?,
                    source_session_id = COALESCE(?, source_session_id), source_message_ids = ?,
                    search_content = ?, updated_at = ?
                WHERE id = ? AND user_id = ?
            `, [
                scope,
                scopeReference,
                projectId,
                Math.max(Number(existing.salience || 0), salience),
                Math.max(Number(existing.confidence || 0), confidence),
                candidate.sourceSessionId || null,
                JSON.stringify(mergedMessageIds),
                content,
                now,
                existing.id,
                userId
            ]);
            await writeMemoryEvidence(trx, existing.id, userId, candidate, origin, assertedBy);
        });
        return { merged: true, id: existing.id };
    }

    const embedding = options.skipEmbedding ? null : await maybeGenerateMemoryEmbedding(content, userId, options.user || null);
    const dimensions = embeddingDimensions(embedding);
    const finalGate = await assertMemoryWriteGate(userId, { ...options, memoryRevision: gate.gate.revision });
    if (!finalGate.allowed) return { skipped: true, reason: finalGate.reason };
    const row = await transaction(async trx => {
        const lockedGate = await lockMemoryGateState(userId, trx);
        if (!lockedGate.enabled || lockedGate.revision !== gate.gate.revision) {
            const error = new Error('记忆写入门禁状态已变化。');
            error.code = !lockedGate.enabled ? 'MEMORY_DISABLED' : 'MEMORY_REVISION_CHANGED';
            throw error;
        }
        if (suppression && origin === MEMORY_ORIGINS.explicit && options.confirmed === true) {
            await trx.execute(`
                UPDATE memory_suppressions
                SET released_at = ?, released_by = ?
                WHERE id = ? AND user_id = ?
            `, [now, 'user', suppression.id, Number(userId)]);
        }
        if (similar.sameFact) {
            await trx.execute(`
                UPDATE memories SET status = ?, supersedes_id = ?, updated_at = ?
                WHERE id = ? AND user_id = ? AND status = ?
            `, [MEMORY_STATUS.disabled, null, now, similar.sameFact.id, Number(userId), MEMORY_STATUS.active]);
        }
        const inserted = await trx.queryOne(`
            INSERT INTO memories (
                user_id, scope, scope_reference, project_id, type, governance_class, retention_mode,
                sensitive, origin, asserted_by, fact_key, supersedes_id, content, embedding, embedding_status,
                embedding_dimensions, search_content, salience, confidence, source_session_id, source_message_ids,
                status, valid_from, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [
            userId,
            scope,
            scopeReference,
            projectId,
            type,
            governance.category,
            governance.retentionMode,
            origin,
            assertedBy,
            factKey,
            similar.sameFact?.id || null,
            content,
            embedding,
            embedding ? 'ready' : 'lexical_ready',
            dimensions,
            content,
            salience,
            confidence,
            candidate.sourceSessionId || null,
            JSON.stringify(sourceMessageIds),
            MEMORY_STATUS.active,
            validFrom,
            candidate.expiresAt || null,
            now,
            now
        ]);
        await writeMemoryEvidence(trx, inserted.id, userId, candidate, origin, assertedBy);
        return inserted;
    });
    invalidateMemoryQualityCache(userId);
    if (dimensions > 0) void ensureMemoryVectorIndex(dimensions).catch(error => logger.warn({ userId, err: error.message }, '长期记忆向量索引检查失败'));
    return { inserted: true, id: row?.id, supersededId: similar.sameFact?.id || null };
}

async function runMemoryExtraction({ userId, sessionId, messageIds = [], user = null, modelCfg = null, memoryRevision } = {}) {
    const ids = normalizeSourceMessageIds(messageIds);
    const gate = await assertMemoryWriteGate(userId, { memoryRevision });
    if (!gate.allowed || ids.length === 0) return { skipped: true, reason: !gate.allowed ? gate.reason : 'missing_context' };
    const placeholders = ids.map(() => '?').join(',');
    const messages = await query(`
        SELECT id, session_id, role, content
        FROM messages
        WHERE user_id = ? AND session_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL
        ORDER BY id ASC
    `, [userId, sessionId, ...ids]);
    let extractor = 'heuristic';
    let candidates = [];
    let modelFallbackReason = null;
    let modelCompleted = false;
    if (modelCfg?.url && !isModelExtractionCircuitOpen(modelCfg)) {
        try {
            const extracted = await extractMemoryCandidatesWithModel(messages, { sessionId, user, modelCfg });
            candidates = extracted.candidates || [];
            modelCompleted = extracted.completed === true;
            extractor = 'model';
            clearModelExtractionCooldown(modelCfg);
        } catch (err) {
            const timedOut = isModelExtractionTimeoutError(err);
            modelFallbackReason = timedOut ? 'timeout' : 'error';
            if (timedOut) markModelExtractionTimeout(modelCfg);
            const logContext = {
                userId,
                sessionId,
                modelId: modelCfg.id || null,
                timeoutMs: MODEL_EXTRACTION_TIMEOUT_MS,
                errorCode: err.code || null,
                err: err.message
            };
            if (timedOut) logger.debug(logContext, '长期记忆模型抽取超时，已回退到启发式规则');
            else logger.warn(logContext, '长期记忆模型抽取失败，已回退到启发式规则');
        }
    } else if (modelCfg?.url) {
        modelFallbackReason = 'cooldown';
    }
    // 模型合法返回空候选代表明确“不保存”；只有服务或熔断异常才允许使用
    // 受限的规则兜底。
    if (!modelCompleted && candidates.length === 0) {
        candidates = extractMemoryCandidatesFromMessages(messages, { sessionId });
        extractor = 'heuristic';
    }
    const startedAt = Date.now();
    const results = [];
    for (const candidate of candidates) {
        if (Date.now() - startedAt > EXTRACTION_TIMEOUT_MS) break;
        results.push(await upsertMemory(userId, candidate, {
            user,
            memoryRevision: gate.gate.revision,
            origin: MEMORY_ORIGINS.automatic,
            assertedBy: MEMORY_ASSERTED_BY.user,
            stagePending: true,
            requireActiveSources: true
        }));
    }
    return {
        candidates: candidates.length,
        extractor,
        modelCompleted,
        modelFallbackReason,
        inserted: results.filter(item => item.inserted).length,
        staged: results.filter(item => item.staged).length,
        merged: results.filter(item => item.merged).length,
        skipped: results.filter(item => item.skipped).length
    };
}

// 连接后台工作线程
setRunMemoryExtractionHandler(runMemoryExtraction);

module.exports = {
    MEMORY_SETTING_KEY,
    MEMORY_JOB_STATUS,
    MEMORY_STATUS,
    MEMORY_TYPES,
    MEMORY_TYPE_LABELS,
    buildLongTermMemoryContextMessage,
    archiveExpiredMemories,
    cancelMemoryExtractionJobs,
    cleanupMemoryExtractionJobs,
    compareMemoryRetrievalShadow,
    enqueueMemoryExtractionJob,
    exportMemories,
    extractMemoryCandidatesFromMessages,
    getMemoryJobSummary,
    getMemoryById,
    getMemoryMergeSuggestions,
    getMemoryQualitySummary,
    getMemorySummary,
    getMemorySource,
    getMemoryUsage,
    injectLongTermMemoryBeforeLatestUser,
    isLongTermMemoryEnabled,
    listMemoryExtractionJobs,
    listMemories,
    mergeMemories,
    processMemoryExtractionJobs,
    recordMemoryUsage,
    retrieveLongTermMemories,
    retryFailedMemoryExtractionJobs,
    revokeMemoriesForSourceMessages,
    revokeMemoriesForSourceSession,
    runMemoryExtraction,
    scheduleMemoryExtraction,
    setLongTermMemoryEnabled,
    startLongTermMemoryMaintenanceRunner,
    softDeleteMemory,
    updateMemory,
    updateMemoryStatus,
    updateMemoryStatuses,
    upsertMemory
};
