const { query, queryOne, execute, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { logger } = require('../../logger');
const { KeyedConcurrencyGuard } = require('../concurrency');
const { getAccessibleModelAsync } = require('../models');
const { generateEmbedding, cosineSimilarity } = require('../rag-index');
const {
    getUserSettingValueAsync,
    setUserSettingAsync
} = require('../user-settings');

const {
    MEMORY_SETTING_KEY,
    MEMORY_STATUS,
    MEMORY_TYPES,
    MEMORY_TYPE_LABELS,
    DEFAULT_MAX_INJECTED_MEMORIES,
    MIN_MEMORY_CONTENT_CHARS,
    EXTRACTION_TIMEOUT_MS,
    MODEL_EXTRACTION_TIMEOUT_MS,
    MEMORY_JOB_STATUS,
    DEFAULT_MEMORY_JOB_MAX_ATTEMPTS,
    MEMORY_JOB_STALE_LOCK_MINUTES,
    DEFAULT_COMPLETED_JOB_RETENTION_DAYS,
    clamp,
    normalizeMemoryType,
    normalizeMemoryScope,
    normalizeMemoryContent,
    normalizeSourceMessageIds,
    parseJsonArray,
    hasSensitiveContent,
    normalizeComparableText,
    fingerprintMemory,
    createMemoryValidationError,
    normalizeOptionalTimestamp
} = require('./memory-utils');
const { serializeMemory, serializeMemoryJob, buildMemoryJobDedupeKey } = require('./memory-serialization');

const {
    extractMemoryCandidatesWithModel,
    extractMemoryCandidatesFromMessages,
    isModelExtractionTimeoutError,
    isModelExtractionCircuitOpen,
    markModelExtractionTimeout,
    clearModelExtractionCooldown
} = require('./memory-extraction');
const { memoryPairSimilarity, mergeMemoryContent } = require('./memory-merge');
const {
    parseEmbedding,
    keywordScore,
    recencyScore,
    buildLongTermMemoryContextMessage,
    injectLongTermMemoryBeforeLatestUser
} = require('./memory-retrieval'); const { filterMemoriesForRetrieval, resolveMemoryGovernance } = require('../memory-governance');

const extractionGuard = new KeyedConcurrencyGuard({
    maxConcurrent: Math.max(1, Number.parseInt(process.env.LONG_TERM_MEMORY_EXTRACTION_MAX_CONCURRENT, 10) || 2)
});

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

async function isLongTermMemoryEnabled(userId) {
    const value = await getUserSettingValueAsync(userId, MEMORY_SETTING_KEY);
    if (value === undefined) return true;
    return value !== 'false';
}

async function setLongTermMemoryEnabled(userId, enabled) {
    const value = enabled ? 'true' : 'false';
    await setUserSettingAsync(userId, MEMORY_SETTING_KEY, value, { updatedAt: getBeijingTimestamp() });
    return await isLongTermMemoryEnabled(userId);
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

async function getMemorySummary(userId) {
    const rows = await query(`
        SELECT type, status, COUNT(*) AS count
        FROM memories
        WHERE user_id = ?
        GROUP BY type, status
    `, [userId]);
    const enabled = await isLongTermMemoryEnabled(userId);
    const summary = {
        enabled,
        active: 0,
        deleted: 0,
        disabled: 0,
        byType: Object.fromEntries(Object.values(MEMORY_TYPES).map(type => [type, 0]))
    };
    rows.forEach(row => {
        const count = Number(row.count || 0);
        if (row.status === MEMORY_STATUS.active) {
            summary.active += count;
            summary.byType[normalizeMemoryType(row.type)] = (summary.byType[normalizeMemoryType(row.type)] || 0) + count;
        } else if (row.status === MEMORY_STATUS.deleted) {
            summary.deleted += count;
        } else if (row.status === MEMORY_STATUS.disabled) {
            summary.disabled += count;
        }
    });
    return summary;
}

async function getMemoryJobSummary(userId) {
    const rows = await query(`
        SELECT status, COUNT(*) AS count
        FROM memory_extraction_jobs
        WHERE user_id = ?
        GROUP BY status
    `, [userId]);
    const byStatus = Object.fromEntries(Object.values(MEMORY_JOB_STATUS).map(status => [status, 0]));
    rows.forEach(row => {
        byStatus[row.status] = Number(row.count || 0);
    });
    const recentRows = await query(`
        SELECT status
        FROM memory_extraction_jobs
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 50
    `, [userId]);
    const completed = recentRows.filter(row => [MEMORY_JOB_STATUS.succeeded, MEMORY_JOB_STATUS.failed, MEMORY_JOB_STATUS.skipped].includes(row.status));
    const succeeded = completed.filter(row => row.status === MEMORY_JOB_STATUS.succeeded).length;
    return {
        byStatus,
        queued: byStatus[MEMORY_JOB_STATUS.queued] || 0,
        running: byStatus[MEMORY_JOB_STATUS.running] || 0,
        failed: byStatus[MEMORY_JOB_STATUS.failed] || 0,
        recentSuccessRate: completed.length ? succeeded / completed.length : 1
    };
}

async function getMemoryQualitySummary(userId) {
    const now = getBeijingTimestamp();
    const base = await getMemorySummary(userId);
    const lowConfidenceRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM memories
        WHERE user_id = ? AND status = ? AND confidence < 0.55
    `, [userId, MEMORY_STATUS.active]);
    const lowConfidence = Number(lowConfidenceRow?.count || 0);

    const expiredRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM memories
        WHERE user_id = ? AND status = ? AND expires_at IS NOT NULL AND expires_at <= ?
    `, [userId, MEMORY_STATUS.active, now]);
    const expired = Number(expiredRow?.count || 0);

    const unusedCutoff = getBeijingTimestamp(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const unusedRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM memories
        WHERE user_id = ?
          AND status = ?
          AND last_used_at IS NULL
          AND created_at < ?
    `, [userId, MEMORY_STATUS.active, unusedCutoff]);
    const unused = Number(unusedRow?.count || 0);

    const mergeSuggestions = await getMemoryMergeSuggestions(userId, { limit: 20 });
    const jobSummary = await getMemoryJobSummary(userId);
    const risks = [];
    if (lowConfidence > 0) risks.push({ type: 'low_confidence', count: lowConfidence });
    if (expired > 0) risks.push({ type: 'expired', count: expired });
    if (mergeSuggestions.length > 0) risks.push({ type: 'duplicates', count: mergeSuggestions.length });
    if (jobSummary.failed > 0) risks.push({ type: 'failed_jobs', count: jobSummary.failed });
    if (jobSummary.queued + jobSummary.running > 20) risks.push({ type: 'backlog', count: jobSummary.queued + jobSummary.running });
    return {
        ...base,
        quality: {
            lowConfidence,
            expired,
            unused,
            duplicateSuggestions: mergeSuggestions.length,
            jobSummary,
            risks,
            status: risks.length === 0 ? 'healthy' : risks.some(risk => ['failed_jobs', 'backlog'].includes(risk.type)) ? 'attention' : 'review'
        }
    };
}

async function softDeleteMemory(userId, memoryId) {
    const now = getBeijingTimestamp();
    const changes = await execute(`
        UPDATE memories
        SET status = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status != ?
    `, [MEMORY_STATUS.deleted, now, memoryId, userId, MEMORY_STATUS.deleted]);
    return changes > 0;
}

async function updateMemoryStatus(userId, memoryId, status) {
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
    const ids = normalizeMemoryIds(memoryIds);
    if (ids.length === 0) return { updated: 0 };
    const normalized = Object.values(MEMORY_STATUS).includes(status) ? status : MEMORY_STATUS.active;
    const now = getBeijingTimestamp();
    const changes = await execute(`
        UPDATE memories
        SET status = ?, updated_at = ?
        WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
    `, [normalized, now, userId, ...ids]);
    return { updated: changes, ids };
}

async function archiveExpiredMemories(userId, options = {}) {
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

async function exportMemories(userId, options = {}) {
    const listed = await listMemories(userId, {
        status: options.status || 'all',
        type: options.type || '',
        search: options.search || '',
        limit: Math.min(Number.parseInt(options.limit, 10) || 500, 500),
        offset: options.offset || 0
    });
    const summary = await getMemorySummary(userId);
    return {
        exportedAt: getBeijingTimestamp(),
        version: 1,
        summary,
        memories: listed.memories
    };
}

async function updateMemory(userId, memoryId, updates = {}, options = {}) {
    const existing = await getMemoryRow(userId, memoryId);
    if (!existing) return null;
    const hasContent = Object.prototype.hasOwnProperty.call(updates, 'content');
    const content = hasContent ? normalizeMemoryContent(updates.content) : existing.content;
    if (content.length < MIN_MEMORY_CONTENT_CHARS) {
        throw createMemoryValidationError('Memory content is too short');
    }
    if (hasSensitiveContent(content)) {
        throw createMemoryValidationError('Sensitive content cannot be stored as long-term memory', 'SENSITIVE_MEMORY');
    }
    const type = Object.prototype.hasOwnProperty.call(updates, 'type') ? normalizeMemoryType(updates.type) : normalizeMemoryType(existing.type);
    const scope = Object.prototype.hasOwnProperty.call(updates, 'scope') ? normalizeMemoryScope(updates.scope) : normalizeMemoryScope(existing.scope);
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
    const expiresAt = Object.prototype.hasOwnProperty.call(updates, 'expiresAt')
        ? normalizeOptionalTimestamp(updates.expiresAt)
        : existing.expires_at;
    const now = getBeijingTimestamp();
    const embedding = hasContent && content !== existing.content && !options.skipEmbedding
        ? await maybeGenerateMemoryEmbedding(content, userId, options.user || null)
        : existing.embedding;
    await execute(`
        UPDATE memories
        SET scope = ?,
            type = ?,
            content = ?,
            embedding = ?,
            salience = ?,
            confidence = ?,
            status = ?,
            expires_at = ?,
            updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [scope, type, content, embedding, salience, confidence, status, expiresAt, now, existing.id, userId]);
    const updated = await queryOne('SELECT * FROM memories WHERE id = ? AND user_id = ?', [existing.id, userId]);
    return serializeMemory(updated);
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
    return {
        memory: serializeMemory(row),
        session: session ? {
            id: session.id,
            title: session.title || '',
            createdAt: session.created_at || null,
            updatedAt: session.updated_at || null
        } : null,
        messages
    };
}

async function getMemoryMergeSuggestions(userId, options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 20, 100));
    const rows = await query(`
        SELECT *
        FROM memories
        WHERE user_id = ?
          AND status = ?
        ORDER BY type ASC, salience DESC, updated_at DESC
        LIMIT 500
    `, [userId, MEMORY_STATUS.active]);
    const suggestions = [];
    for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
            if (rows[i].type !== rows[j].type) continue;
            const score = memoryPairSimilarity(rows[i], rows[j]);
            if (score < 0.52) continue;
            const first = rows[i];
            const second = rows[j];
            const primary = Number(first.salience || 0) >= Number(second.salience || 0) ? first : second;
            const duplicate = primary.id === first.id ? second : first;
            suggestions.push({
                score,
                reason: score >= 0.9 ? 'overlap' : 'similar_terms',
                primary: serializeMemory(primary),
                duplicate: serializeMemory(duplicate)
            });
        }
    }
    return suggestions.sort((a, b) => b.score - a.score).slice(0, limit);
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
    const now = getBeijingTimestamp();
    const content = mergeMemoryContent(target, source);
    if (hasSensitiveContent(content)) {
        throw createMemoryValidationError('Sensitive content cannot be stored as long-term memory', 'SENSITIVE_MEMORY');
    }
    const sourceMessageIds = [...new Set([
        ...parseJsonArray(target.source_message_ids),
        ...parseJsonArray(source.source_message_ids)
    ])].slice(-20);
    const embedding = options.skipEmbedding
        ? target.embedding
        : await maybeGenerateMemoryEmbedding(content, userId, options.user || null);

    await transaction(async (trx) => {
        await trx.execute(`
            UPDATE memories
            SET content = ?,
                embedding = ?,
                salience = ?,
                confidence = ?,
                source_session_id = COALESCE(source_session_id, ?),
                source_message_ids = ?,
                updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [
            content,
            embedding,
            Math.max(Number(target.salience || 0), Number(source.salience || 0)),
            Math.max(Number(target.confidence || 0), Number(source.confidence || 0)),
            source.source_session_id || null,
            JSON.stringify(sourceMessageIds),
            now,
            target.id,
            userId
        ]);
        await trx.execute(`
            UPDATE memories
            SET status = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [MEMORY_STATUS.deleted, now, source.id, userId]);
    });

    const updatedTarget = await queryOne('SELECT * FROM memories WHERE id = ? AND user_id = ?', [target.id, userId]);
    return {
        merged: true,
        target: serializeMemory(updatedTarget),
        deletedSourceId: source.id
    };
}

async function findSimilarMemory(userId, type, content) {
    const fingerprint = fingerprintMemory(type, content);
    const rows = await query(`
        SELECT *
        FROM memories
        WHERE user_id = ? AND type = ? AND status = ?
        ORDER BY updated_at DESC
        LIMIT 200
    `, [userId, type, MEMORY_STATUS.active]);
    return rows.find(row => fingerprintMemory(row.type, row.content) === fingerprint)
        || rows.find(row => {
            const a = normalizeComparableText(row.content);
            const b = normalizeComparableText(content);
            if (!a || !b) return false;
            return a.includes(b) || b.includes(a);
        })
        || null;
}

async function maybeGenerateMemoryEmbedding(content, userId, user = null) {
    try {
        const vector = await generateEmbedding(content, null, null, userId, { user, source: 'memory_embedding' });
        return JSON.stringify(vector);
    } catch (err) {
        logger.warn({ userId, err: err.message }, '长期记忆向量生成失败，已保留为关键词可检索记忆');
        return null;
    }
}

async function upsertMemory(userId, candidate, options = {}) {
    const content = normalizeMemoryContent(candidate.content);
    if (content.length < MIN_MEMORY_CONTENT_CHARS || hasSensitiveContent(content)) {
        return { skipped: true, reason: 'invalid_or_sensitive' };
    }
    const type = normalizeMemoryType(candidate.type);
    const governance = await resolveMemoryGovernance(userId, { type, category: candidate.governanceClass || candidate.category, content, retentionMode: candidate.retentionMode }, options); if (!governance.allowed) return { skipped: true, reason: governance.reason || 'memory_policy_blocked' };
    const scope = normalizeMemoryScope(candidate.scope);
    const salience = clamp(candidate.salience, 0, 1, 0.5);
    const confidence = clamp(candidate.confidence, 0, 1, 0.6);
    const sourceMessageIds = normalizeSourceMessageIds(candidate.sourceMessageIds);
    const now = getBeijingTimestamp();
    const existing = await findSimilarMemory(userId, type, content);

    if (existing) {
        const mergedMessageIds = [...new Set([
            ...parseJsonArray(existing.source_message_ids),
            ...sourceMessageIds
        ])].slice(-20);
        const mergedContent = content.length > String(existing.content || '').length ? content : existing.content;
        await execute(`
            UPDATE memories
            SET content = ?,
                scope = ?,
                salience = ?,
                confidence = ?,
                source_session_id = COALESCE(?, source_session_id),
                source_message_ids = ?,
                updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [
            mergedContent,
            scope,
            Math.max(Number(existing.salience || 0), salience),
            Math.max(Number(existing.confidence || 0), confidence),
            candidate.sourceSessionId || null,
            JSON.stringify(mergedMessageIds),
            now,
            existing.id,
            userId
        ]);
        return { merged: true, id: existing.id };
    }

    const embedding = options.skipEmbedding ? null : await maybeGenerateMemoryEmbedding(content, userId, options.user || null);
    const row = await queryOne(`
        INSERT INTO memories (
            user_id, scope, type, governance_class, retention_mode, sensitive, content, embedding, salience, confidence, source_session_id, source_message_ids, status, expires_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
    `, [
        userId,
        scope,
        type, governance.category, governance.retentionMode,
        content,
        embedding,
        salience,
        confidence,
        candidate.sourceSessionId || null,
        JSON.stringify(sourceMessageIds),
        MEMORY_STATUS.active,
        candidate.expiresAt || null,
        now,
        now
    ]);
    return { inserted: true, id: row?.id };
}

async function enqueueMemoryExtractionJob({ userId, sessionId, messageIds = [], modelId = null } = {}) {
    if (!userId || !sessionId || !Array.isArray(messageIds) || messageIds.length === 0) {
        return { queued: false, reason: 'missing_context' };
    }
    if (!(await isLongTermMemoryEnabled(userId))) {
        return { queued: false, reason: 'disabled' };
    }
    const ids = normalizeSourceMessageIds(messageIds);
    if (ids.length === 0) return { queued: false, reason: 'missing_context' };
    const now = getBeijingTimestamp();
    const dedupeKey = buildMemoryJobDedupeKey(userId, sessionId, ids);
    const existing = await queryOne(`
        SELECT *
        FROM memory_extraction_jobs
        WHERE dedupe_key = ?
          AND status IN (?, ?)
        ORDER BY id DESC
        LIMIT 1
    `, [dedupeKey, MEMORY_JOB_STATUS.queued, MEMORY_JOB_STATUS.running]);
    if (existing) {
        return {
            queued: true,
            deduped: true,
            job: serializeMemoryJob(existing),
            messageIds: ids
        };
    }

    const row = await queryOne(`
        INSERT INTO memory_extraction_jobs (
            user_id, session_id, message_ids, model_id, dedupe_key,
            status, attempts, max_attempts, created_at, updated_at, next_run_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        RETURNING id
    `, [
        userId,
        sessionId,
        JSON.stringify(ids),
        modelId || null,
        dedupeKey,
        MEMORY_JOB_STATUS.queued,
        DEFAULT_MEMORY_JOB_MAX_ATTEMPTS,
        now,
        now,
        now
    ]);
    const insertedId = row?.id;

    const insertedJob = await queryOne('SELECT * FROM memory_extraction_jobs WHERE id = ?', [insertedId]);
    return {
        queued: true,
        job: serializeMemoryJob(insertedJob),
        messageIds: ids
    };
}

async function resolveMemoryJobUser(row) {
    const user = await queryOne('SELECT id, username, nickname, unit, role, status FROM users WHERE id = ? AND status = ?', [row.user_id, 'active']);
    return user || { id: row.user_id, role: 'user' };
}

async function resolveMemoryJobModel(row, user) {
    if (!row.model_id) return null;
    const model = await getAccessibleModelAsync(row.model_id, user);
    if (!model || model.secret_error) return null;
    return model;
}

function triggerMemoryExtractionWorker() {
    setTimeout(() => {
        processMemoryExtractionJobs()
            .catch(err => {
                if (/database connection is not open/i.test(String(err.message || ''))) return;
                logger.warn({ err: err.message }, '长期记忆抽取工作线程失败');
            });
    }, 0).unref?.();
}

async function scheduleMemoryExtraction({ userId, sessionId, messageIds = [], user = null, modelCfg = null } = {}) {
    void user;
    const queued = await enqueueMemoryExtractionJob({
        userId,
        sessionId,
        messageIds,
        modelId: modelCfg?.id || null
    });
    if (!queued.queued) {
        return { scheduled: false, reason: queued.reason };
    }
    triggerMemoryExtractionWorker();
    return {
        scheduled: true,
        queued: true,
        deduped: queued.deduped === true,
        jobId: queued.job?.id || null,
        messageIds: queued.messageIds
    };
}

async function claimMemoryExtractionJobs(limit = 5) {
    const now = getBeijingTimestamp();
    const staleBefore = getBeijingTimestamp(new Date(Date.now() - MEMORY_JOB_STALE_LOCK_MINUTES * 60000));
    const rows = await query(`
        SELECT *
        FROM memory_extraction_jobs
        WHERE (
            status = ? AND COALESCE(next_run_at, created_at) <= ?
        ) OR (
            status = ? AND locked_at IS NOT NULL AND locked_at < ?
        )
        ORDER BY COALESCE(next_run_at, created_at) ASC, id ASC
        LIMIT ?
    `, [MEMORY_JOB_STATUS.queued, now, MEMORY_JOB_STATUS.running, staleBefore, Math.max(1, Math.min(Number(limit) || 5, 20))]);

    const claimed = [];
    for (const row of rows) {
        const changes = await execute(`
            UPDATE memory_extraction_jobs
            SET status = ?,
                locked_at = ?,
                attempts = attempts + 1,
                updated_at = ?
            WHERE id = ?
              AND (
                  status = ?
                  OR (status = ? AND locked_at IS NOT NULL AND locked_at < ?)
              )
        `, [MEMORY_JOB_STATUS.running, now, now, row.id, MEMORY_JOB_STATUS.queued, MEMORY_JOB_STATUS.running, staleBefore]);
        if (changes > 0) {
            const freshRow = await queryOne('SELECT * FROM memory_extraction_jobs WHERE id = ?', [row.id]);
            if (freshRow) claimed.push(freshRow);
        }
    }
    return claimed;
}

function nextMemoryJobRunAt(attempts) {
    const delaySeconds = Math.min(3600, Math.max(15, 15 * (2 ** Math.max(0, Number(attempts || 1) - 1))));
    return getBeijingTimestamp(new Date(Date.now() + delaySeconds * 1000));
}

async function finishMemoryExtractionJob(jobId, status, fields = {}) {
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE memory_extraction_jobs
        SET status = ?,
            locked_at = NULL,
            last_error = ?,
            result = ?,
            next_run_at = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
    `, [
        status,
        fields.lastError || null,
        fields.result ? JSON.stringify(fields.result).slice(0, 4000) : null,
        fields.nextRunAt || null,
        [MEMORY_JOB_STATUS.succeeded, MEMORY_JOB_STATUS.failed, MEMORY_JOB_STATUS.skipped].includes(status) ? now : null,
        now,
        jobId
    ]);
}

async function processMemoryExtractionJob(row) {
    const user = await resolveMemoryJobUser(row);
    const modelCfg = await resolveMemoryJobModel(row, user);
    const result = await runMemoryExtraction({
        userId: row.user_id,
        sessionId: row.session_id,
        messageIds: parseJsonArray(row.message_ids),
        user,
        modelCfg
    });
    const finalStatus = result.skipped ? MEMORY_JOB_STATUS.skipped : MEMORY_JOB_STATUS.succeeded;
    await finishMemoryExtractionJob(row.id, finalStatus, { result });
    return result;
}

async function processMemoryExtractionJobs(options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 5, 20));
    const rows = await claimMemoryExtractionJobs(limit);
    const results = [];
    for (const row of rows) {
        const key = `${row.user_id}:${row.session_id}:${row.id}`;
        try {
            const result = await extractionGuard.run(key, () => processMemoryExtractionJob(row));
            results.push({ id: row.id, ok: true, result });
        } catch (err) {
            const latest = (await queryOne('SELECT attempts, max_attempts FROM memory_extraction_jobs WHERE id = ?', [row.id])) || row;
            const attempts = Number(latest.attempts || row.attempts || 1);
            const maxAttempts = Number(latest.max_attempts || DEFAULT_MEMORY_JOB_MAX_ATTEMPTS);
            const exhausted = attempts >= maxAttempts;
            await finishMemoryExtractionJob(row.id, exhausted ? MEMORY_JOB_STATUS.failed : MEMORY_JOB_STATUS.queued, {
                lastError: String(err.message || err).slice(0, 1000),
                nextRunAt: exhausted ? null : nextMemoryJobRunAt(attempts)
            });
            results.push({ id: row.id, ok: false, error: err.message || String(err), retry: !exhausted });
        }
    }
    return {
        claimed: rows.length,
        succeeded: results.filter(item => item.ok).length,
        failed: results.filter(item => !item.ok && !item.retry).length,
        retried: results.filter(item => item.retry).length,
        results
    };
}

async function listMemoryExtractionJobs(userId, options = {}) {
    const status = String(options.status || 'all');
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200));
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const where = ['user_id = ?'];
    const params = [userId];
    if (status !== 'all' && Object.values(MEMORY_JOB_STATUS).includes(status)) {
        where.push('status = ?');
        params.push(status);
    }
    const rows = await query(`
        SELECT *
        FROM memory_extraction_jobs
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM memory_extraction_jobs WHERE ${where.join(' AND ')}`, params);
    const total = Number(totalRow?.count || 0);
    const summary = await getMemoryJobSummary(userId);
    return { total, jobs: rows.map(serializeMemoryJob), summary };
}

async function retryFailedMemoryExtractionJobs(userId, jobIds = []) {
    const ids = normalizeMemoryIds(jobIds);
    const now = getBeijingTimestamp();
    const where = ['user_id = ?', 'status = ?'];
    const params = [userId, MEMORY_JOB_STATUS.failed];
    if (ids.length > 0) {
        where.push(`id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
    }
    const changes = await execute(`
        UPDATE memory_extraction_jobs
        SET status = ?,
            locked_at = NULL,
            last_error = NULL,
            next_run_at = ?,
            updated_at = ?
        WHERE ${where.join(' AND ')}
    `, [MEMORY_JOB_STATUS.queued, now, now, ...params]);
    if (changes > 0) triggerMemoryExtractionWorker();
    return { queued: changes };
}

async function cleanupMemoryExtractionJobs(userId, options = {}) {
    const retentionDays = Math.max(1, Math.min(Number.parseInt(options.retentionDays, 10) || DEFAULT_COMPLETED_JOB_RETENTION_DAYS, 365));
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 1000, 5000));
    const cutoff = getBeijingTimestamp(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000));
    const rows = await query(`
        SELECT id
        FROM memory_extraction_jobs
        WHERE user_id = ?
          AND status IN (?, ?, ?)
          AND COALESCE(completed_at, updated_at, created_at) < ?
        ORDER BY COALESCE(completed_at, updated_at, created_at) ASC, id ASC
        LIMIT ?
    `, [
        userId,
        MEMORY_JOB_STATUS.succeeded,
        MEMORY_JOB_STATUS.failed,
        MEMORY_JOB_STATUS.skipped,
        cutoff,
        limit
    ]);
    if (rows.length === 0) return { deleted: 0, cutoff, retentionDays };
    const ids = rows.map(row => row.id);
    const changes = await execute(`
        DELETE FROM memory_extraction_jobs
        WHERE user_id = ?
          AND id IN (${ids.map(() => '?').join(',')})
    `, [userId, ...ids]);
    return { deleted: changes, cutoff, retentionDays };
}

async function runMemoryExtraction({ userId, sessionId, messageIds = [], user = null, modelCfg = null } = {}) {
    const ids = normalizeSourceMessageIds(messageIds);
    if (!(await isLongTermMemoryEnabled(userId)) || ids.length === 0) {
        return { skipped: true };
    }
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
    if (modelCfg?.url && !isModelExtractionCircuitOpen(modelCfg)) {
        try {
            candidates = await extractMemoryCandidatesWithModel(messages, { sessionId, user, modelCfg });
            if (candidates.length > 0) extractor = 'model';
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
    if (candidates.length === 0) {
        candidates = extractMemoryCandidatesFromMessages(messages, { sessionId });
        extractor = 'heuristic';
    }
    const startedAt = Date.now();
    const results = [];
    for (const candidate of candidates) {
        if (Date.now() - startedAt > EXTRACTION_TIMEOUT_MS) break;
        results.push(await upsertMemory(userId, candidate, { user }));
    }
    return {
        candidates: candidates.length,
        extractor,
        modelFallbackReason,
        inserted: results.filter(item => item.inserted).length,
        merged: results.filter(item => item.merged).length,
        skipped: results.filter(item => item.skipped).length
    };
}

async function retrieveLongTermMemories(userId, queryText, options = {}) {
    if (!(await isLongTermMemoryEnabled(userId))) return [];
    const normalizedQuery = String(queryText || '').trim();
    if (!normalizedQuery) return [];
    const now = getBeijingTimestamp();
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || DEFAULT_MAX_INJECTED_MEMORIES, 20));
    const rows = await filterMemoriesForRetrieval(userId, await query(`
        SELECT *
        FROM memories
        WHERE user_id = ?
          AND status = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY salience DESC, confidence DESC, updated_at DESC
        LIMIT 200
    `, [userId, MEMORY_STATUS.active, now]));
    if (rows.length === 0) return [];

    let queryVector = null;
    if (rows.some(row => row.embedding)) {
        try {
            queryVector = await generateEmbedding(normalizedQuery, null, null, userId, {
                user: options.user || null,
                source: 'memory_embedding'
            });
        } catch (err) {
            logger.warn({ userId, err: err.message }, '长期记忆查询向量生成失败，已回退关键词排序');
        }
    }

    const scored = rows.map(row => {
        const vector = queryVector ? parseEmbedding(row.embedding) : null;
        const semantic = vector && vector.length === queryVector.length
            ? Math.max(0, cosineSimilarity(queryVector, vector))
            : 0;
        const lexical = keywordScore(row, normalizedQuery);
        const relevance = queryVector ? Math.max(semantic, lexical * 0.75) : lexical;
        const salience = clamp(row.salience, 0, 1, 0.5);
        const confidence = clamp(row.confidence, 0, 1, 0.6);
        const recent = recencyScore(row);
        const score = relevance * 0.52 + salience * 0.22 + confidence * 0.16 + recent * 0.10;
        return {
            ...serializeMemory(row),
            score,
            relevance,
            recent
        };
    })
        .filter(item => item.relevance > 0 || item.salience >= 0.75)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    if (scored.length > 0) {
        const ids = scored.map(item => item.id);
        await execute(`UPDATE memories SET last_used_at = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [now, userId, ...ids]);
    }
    return scored;
}

module.exports = {
    MEMORY_SETTING_KEY,
    MEMORY_JOB_STATUS,
    MEMORY_STATUS,
    MEMORY_TYPES,
    MEMORY_TYPE_LABELS,
    buildLongTermMemoryContextMessage,
    archiveExpiredMemories,
    cleanupMemoryExtractionJobs,
    enqueueMemoryExtractionJob,
    exportMemories,
    extractMemoryCandidatesFromMessages,
    getMemoryJobSummary,
    getMemoryMergeSuggestions,
    getMemoryQualitySummary,
    getMemorySummary,
    getMemorySource,
    injectLongTermMemoryBeforeLatestUser,
    isLongTermMemoryEnabled,
    listMemoryExtractionJobs,
    listMemories,
    mergeMemories,
    processMemoryExtractionJobs,
    retrieveLongTermMemories,
    retryFailedMemoryExtractionJobs,
    runMemoryExtraction,
    scheduleMemoryExtraction,
    setLongTermMemoryEnabled,
    softDeleteMemory,
    updateMemory,
    updateMemoryStatus,
    updateMemoryStatuses,
    upsertMemory
};
