const crypto = require('crypto');
const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { estimateTokens } = require('../llm');
const { KeyedConcurrencyGuard } = require('./concurrency');
const { forwardChatCompletion } = require('./model-forwarder');
const { buildChatCompletionsUrl, buildModelHeaders } = require('./model-adapter');
const { getAccessibleModel } = require('./models');
const { generateEmbedding, cosineSimilarity, buildKeywordCandidates } = require('./rag-index');

const MEMORY_SETTING_KEY = 'long_term_memory_enabled';
const MEMORY_STATUS = Object.freeze({
    active: 'active',
    deleted: 'deleted',
    disabled: 'disabled'
});
const MEMORY_TYPES = Object.freeze({
    preference: 'preference',
    fact: 'fact',
    decision: 'decision',
    episode: 'episode'
});
const MEMORY_TYPE_LABELS = Object.freeze({
    [MEMORY_TYPES.preference]: '用户偏好',
    [MEMORY_TYPES.fact]: '项目/任务事实',
    [MEMORY_TYPES.decision]: '长期决策',
    [MEMORY_TYPES.episode]: '历史片段'
});

const DEFAULT_RETRIEVAL_BUDGET_RATIO = 0.08;
const MIN_RETRIEVAL_BUDGET_RATIO = 0.05;
const MAX_RETRIEVAL_BUDGET_RATIO = 0.10;
const DEFAULT_MAX_INJECTED_MEMORIES = 8;
const MAX_MEMORY_CONTENT_CHARS = 800;
const MIN_MEMORY_CONTENT_CHARS = 8;
const EXTRACTION_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.LONG_TERM_MEMORY_EXTRACTION_TIMEOUT_MS, 10) || 30000);
const MODEL_EXTRACTION_TIMEOUT_MS = Math.max(3000, Number.parseInt(process.env.LONG_TERM_MEMORY_LLM_EXTRACTION_TIMEOUT_MS, 10) || Math.min(EXTRACTION_TIMEOUT_MS, 15000));
const MODEL_EXTRACTION_MAX_CANDIDATES = 8;
const MODEL_EXTRACTION_DISABLED = String(process.env.LONG_TERM_MEMORY_LLM_EXTRACTION || '').toLowerCase() === 'false';
const MEMORY_JOB_STATUS = Object.freeze({
    queued: 'queued',
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    skipped: 'skipped'
});
const DEFAULT_MEMORY_JOB_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.LONG_TERM_MEMORY_JOB_MAX_ATTEMPTS, 10) || 3);
const MEMORY_JOB_STALE_LOCK_MINUTES = Math.max(1, Number.parseInt(process.env.LONG_TERM_MEMORY_JOB_STALE_LOCK_MINUTES, 10) || 10);
const DEFAULT_COMPLETED_JOB_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.LONG_TERM_MEMORY_JOB_RETENTION_DAYS, 10) || 30);
const extractionGuard = new KeyedConcurrencyGuard({
    maxConcurrent: Math.max(1, Number.parseInt(process.env.LONG_TERM_MEMORY_EXTRACTION_MAX_CONCURRENT, 10) || 2)
});

const SENSITIVE_PATTERNS = [
    /\b(?:api[_-]?key|secret|token|password|passwd|pwd|密钥|密码|口令|令牌)\b\s*[:：=]/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:\d[ -]*?){13,19}\b/,
    /\b\d{15}|\d{17}[\dXx]\b/,
    /\b1[3-9]\d{9}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];

function clamp(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeMemoryType(type) {
    const value = String(type || '').trim().toLowerCase();
    return Object.values(MEMORY_TYPES).includes(value) ? value : MEMORY_TYPES.episode;
}

function normalizeMemoryScope(scope) {
    const value = String(scope || '').trim().toLowerCase();
    if (['user', 'project', 'session', 'global'].includes(value)) return value;
    return 'user';
}

function normalizeMemoryContent(content) {
    return String(content || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_MEMORY_CONTENT_CHARS);
}

function normalizeSourceMessageIds(ids = []) {
    const values = Array.isArray(ids) ? ids : [ids];
    return [...new Set(values
        .map(id => Number.parseInt(id, 10))
        .filter(id => Number.isSafeInteger(id) && id > 0))]
        .slice(0, 20);
}

function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
        return [];
    }
}

function hasSensitiveContent(text) {
    const value = String(text || '');
    return SENSITIVE_PATTERNS.some(pattern => pattern.test(value));
}

function normalizeComparableText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .slice(0, 160);
}

function fingerprintMemory(type, content) {
    return crypto.createHash('sha256')
        .update(`${normalizeMemoryType(type)}:${normalizeComparableText(content)}`)
        .digest('hex');
}

function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            return part.text || part.content || '';
        }).filter(Boolean).join('\n');
    }
    return content ? JSON.stringify(content) : '';
}

function createMemoryValidationError(message, code = 'INVALID_MEMORY') {
    const err = new Error(message);
    err.statusCode = 400;
    err.code = code;
    return err;
}

function normalizeOptionalTimestamp(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = Date.parse(text.replace(' ', 'T'));
    if (!Number.isFinite(parsed)) return null;
    return text.slice(0, 64);
}

function getMemoryRow(userId, memoryId, options = {}) {
    const id = Number.parseInt(memoryId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const includeDeleted = options.includeDeleted === true;
    return db.prepare(`
        SELECT *
        FROM memories
        WHERE id = ? AND user_id = ?${includeDeleted ? '' : ' AND status != ?'}
    `).get(...(includeDeleted ? [id, userId] : [id, userId, MEMORY_STATUS.deleted])) || null;
}

function normalizeExtractorCandidates(rawCandidates = [], context = {}) {
    const sourceMessageIds = normalizeSourceMessageIds(context.sourceMessageIds);
    const sourceSessionId = context.sessionId || null;
    const byKey = new Map();
    (Array.isArray(rawCandidates) ? rawCandidates : []).forEach(raw => {
        if (!raw || typeof raw !== 'object') return;
        const content = normalizeMemoryContent(raw.content || raw.memory || raw.text || raw.value || '');
        if (content.length < MIN_MEMORY_CONTENT_CHARS || hasSensitiveContent(content)) return;
        const candidate = buildCandidate({
            type: normalizeMemoryType(raw.type || raw.category),
            content,
            salience: clamp(raw.salience ?? raw.importance, 0, 1, 0.55),
            confidence: clamp(raw.confidence, 0, 1, 0.62),
            sourceSessionId: raw.sourceSessionId || sourceSessionId,
            sourceMessageIds: normalizeSourceMessageIds(raw.sourceMessageIds || sourceMessageIds)
        });
        const key = fingerprintMemory(candidate.type, candidate.content);
        const existing = byKey.get(key);
        if (!existing || candidate.salience > existing.salience) byKey.set(key, candidate);
    });
    return Array.from(byKey.values()).slice(0, MODEL_EXTRACTION_MAX_CANDIDATES);
}

function parseExtractorJson(text) {
    const raw = String(text || '').trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();
    const attempts = [raw];
    const firstObject = raw.indexOf('{');
    const lastObject = raw.lastIndexOf('}');
    if (firstObject !== -1 && lastObject > firstObject) attempts.push(raw.slice(firstObject, lastObject + 1));
    const firstArray = raw.indexOf('[');
    const lastArray = raw.lastIndexOf(']');
    if (firstArray !== -1 && lastArray > firstArray) attempts.push(raw.slice(firstArray, lastArray + 1));

    for (const attempt of attempts) {
        try {
            const parsed = JSON.parse(attempt);
            if (Array.isArray(parsed)) return parsed;
            if (Array.isArray(parsed?.memories)) return parsed.memories;
            if (Array.isArray(parsed?.candidates)) return parsed.candidates;
        } catch (_err) {
            // Try the next relaxed JSON boundary.
        }
    }
    return [];
}

function extractModelMessageText(data) {
    const message = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? data?.output_text;
    return contentText(message);
}

function buildExtractorMessages(messages = []) {
    const source = messages
        .filter(message => ['user', 'assistant'].includes(message?.role))
        .map(message => {
            const text = contentText(message.content).slice(0, 4000);
            return `[message_id:${message.id} role:${message.role}]\n${text}`;
        })
        .join('\n\n');
    return [
        {
            role: 'system',
            content: [
                'Extract durable long-term memory candidates from the conversation.',
                'Return only JSON with this shape: {"memories":[{"type":"preference|fact|decision|episode","content":"...","salience":0.0,"confidence":0.0}]}',
                'Keep only stable user preferences, project/task facts, long-term decisions, or useful historical episodes.',
                'Do not include secrets, tokens, passwords, private keys, payment card numbers, phone numbers, government IDs, or transient chit-chat.',
                'Use concise standalone content. Return at most 8 memories.'
            ].join('\n')
        },
        {
            role: 'user',
            content: source || 'No source messages.'
        }
    ];
}

async function extractMemoryCandidatesWithModel(messages = [], context = {}) {
    if (MODEL_EXTRACTION_DISABLED || !context.modelCfg?.url) return [];
    const modelCfg = context.modelCfg;
    const url = buildChatCompletionsUrl(modelCfg.url);
    const res = await forwardChatCompletion({
        modelCfg,
        user: context.user || null,
        url,
        headers: buildModelHeaders(modelCfg, { acceptJson: true }),
        timeout: MODEL_EXTRACTION_TIMEOUT_MS,
        data: {
            model: modelCfg.model_name || modelCfg.name || modelCfg.model || 'memory-extractor',
            messages: buildExtractorMessages(messages),
            temperature: 0,
            stream: false,
            response_format: { type: 'json_object' }
        }
    });
    const rawCandidates = parseExtractorJson(extractModelMessageText(res.data));
    return normalizeExtractorCandidates(rawCandidates, {
        sessionId: context.sessionId,
        sourceMessageIds: messages.map(message => message.id)
    });
}

function isLongTermMemoryEnabled(userId) {
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, MEMORY_SETTING_KEY);
    if (!row) return true;
    return row.value !== 'false';
}

function setLongTermMemoryEnabled(userId, enabled) {
    const value = enabled ? 'true' : 'false';
    db.prepare(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
    `).run(userId, MEMORY_SETTING_KEY, value, getBeijingTimestamp());
    return isLongTermMemoryEnabled(userId);
}

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
        result: row.result ? (() => {
            try { return JSON.parse(row.result); } catch (_err) { return null; }
        })() : null,
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

function listMemories(userId, options = {}) {
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
    const rows = db.prepare(`
        SELECT *
        FROM memories
        WHERE ${where.join(' AND ')}
        ORDER BY
            CASE status WHEN 'active' THEN 0 ELSE 1 END,
            salience DESC,
            COALESCE(last_used_at, updated_at, created_at) DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${where.join(' AND ')}`).get(...params).count;
    return {
        enabled: isLongTermMemoryEnabled(userId),
        total,
        memories: rows.map(serializeMemory)
    };
}

function getMemorySummary(userId) {
    const rows = db.prepare(`
        SELECT type, status, COUNT(*) AS count
        FROM memories
        WHERE user_id = ?
        GROUP BY type, status
    `).all(userId);
    const summary = {
        enabled: isLongTermMemoryEnabled(userId),
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

function getMemoryJobSummary(userId) {
    const rows = db.prepare(`
        SELECT status, COUNT(*) AS count
        FROM memory_extraction_jobs
        WHERE user_id = ?
        GROUP BY status
    `).all(userId);
    const byStatus = Object.fromEntries(Object.values(MEMORY_JOB_STATUS).map(status => [status, 0]));
    rows.forEach(row => {
        byStatus[row.status] = Number(row.count || 0);
    });
    const recentRows = db.prepare(`
        SELECT status
        FROM memory_extraction_jobs
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 50
    `).all(userId);
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

function getMemoryQualitySummary(userId) {
    const now = getBeijingTimestamp();
    const base = getMemorySummary(userId);
    const lowConfidence = db.prepare(`
        SELECT COUNT(*) AS count
        FROM memories
        WHERE user_id = ? AND status = ? AND confidence < 0.55
    `).get(userId, MEMORY_STATUS.active).count || 0;
    const expired = db.prepare(`
        SELECT COUNT(*) AS count
        FROM memories
        WHERE user_id = ? AND status = ? AND expires_at IS NOT NULL AND expires_at <= ?
    `).get(userId, MEMORY_STATUS.active, now).count || 0;
    const unused = db.prepare(`
        SELECT COUNT(*) AS count
        FROM memories
        WHERE user_id = ?
          AND status = ?
          AND last_used_at IS NULL
          AND created_at < datetime('now', '+8 hours', '-30 days')
    `).get(userId, MEMORY_STATUS.active).count || 0;
    const mergeSuggestions = getMemoryMergeSuggestions(userId, { limit: 20 });
    const jobSummary = getMemoryJobSummary(userId);
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

function softDeleteMemory(userId, memoryId) {
    const now = getBeijingTimestamp();
    const info = db.prepare(`
        UPDATE memories
        SET status = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status != ?
    `).run(MEMORY_STATUS.deleted, now, memoryId, userId, MEMORY_STATUS.deleted);
    return info.changes > 0;
}

function updateMemoryStatus(userId, memoryId, status) {
    const normalized = Object.values(MEMORY_STATUS).includes(status) ? status : MEMORY_STATUS.active;
    const now = getBeijingTimestamp();
    const info = db.prepare(`
        UPDATE memories
        SET status = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(normalized, now, memoryId, userId);
    return info.changes > 0;
}

function normalizeMemoryIds(ids = []) {
    const values = Array.isArray(ids) ? ids : [ids];
    return [...new Set(values
        .map(id => Number.parseInt(id, 10))
        .filter(id => Number.isSafeInteger(id) && id > 0))]
        .slice(0, 500);
}

function updateMemoryStatuses(userId, memoryIds = [], status = MEMORY_STATUS.active) {
    const ids = normalizeMemoryIds(memoryIds);
    if (ids.length === 0) return { updated: 0 };
    const normalized = Object.values(MEMORY_STATUS).includes(status) ? status : MEMORY_STATUS.active;
    const now = getBeijingTimestamp();
    const info = db.prepare(`
        UPDATE memories
        SET status = ?, updated_at = ?
        WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
    `).run(normalized, now, userId, ...ids);
    return { updated: info.changes, ids };
}

function archiveExpiredMemories(userId, options = {}) {
    const now = getBeijingTimestamp();
    const status = Object.values(MEMORY_STATUS).includes(options.status) ? options.status : MEMORY_STATUS.disabled;
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 500, 1000));
    const rows = db.prepare(`
        SELECT id
        FROM memories
        WHERE user_id = ?
          AND status = ?
          AND expires_at IS NOT NULL
          AND expires_at <= ?
        ORDER BY expires_at ASC, id ASC
        LIMIT ?
    `).all(userId, MEMORY_STATUS.active, now, limit);
    if (rows.length === 0) return { archived: 0, ids: [] };
    const ids = rows.map(row => row.id);
    const info = db.prepare(`
        UPDATE memories
        SET status = ?,
            updated_at = ?
        WHERE user_id = ?
          AND id IN (${ids.map(() => '?').join(',')})
    `).run(status, now, userId, ...ids);
    return { archived: info.changes, ids, status };
}

function exportMemories(userId, options = {}) {
    const listed = listMemories(userId, {
        status: options.status || 'all',
        type: options.type || '',
        search: options.search || '',
        limit: Math.min(Number.parseInt(options.limit, 10) || 500, 500),
        offset: options.offset || 0
    });
    return {
        exportedAt: getBeijingTimestamp(),
        version: 1,
        summary: getMemorySummary(userId),
        memories: listed.memories
    };
}

async function updateMemory(userId, memoryId, updates = {}, options = {}) {
    const existing = getMemoryRow(userId, memoryId);
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
    db.prepare(`
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
    `).run(scope, type, content, embedding, salience, confidence, status, expiresAt, now, existing.id, userId);
    return serializeMemory(db.prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?').get(existing.id, userId));
}

function getMemorySource(userId, memoryId) {
    const row = getMemoryRow(userId, memoryId);
    if (!row) return null;
    const sourceIds = parseJsonArray(row.source_message_ids);
    let messages = [];
    if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => '?').join(',');
        messages = db.prepare(`
            SELECT id, session_id, role, content, created_at
            FROM messages
            WHERE user_id = ?
              AND id IN (${placeholders})
              AND deleted_at IS NULL
            ORDER BY id ASC
        `).all(userId, ...sourceIds).map(message => ({
            id: message.id,
            sessionId: message.session_id,
            role: message.role,
            content: message.content || '',
            createdAt: message.created_at || null
        }));
    }
    const session = row.source_session_id
        ? db.prepare('SELECT id, title, created_at, updated_at FROM sessions WHERE id = ? AND user_id = ?').get(row.source_session_id, userId)
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

function tokenSetForSimilarity(text) {
    return new Set(buildKeywordCandidates(text, 32)
        .map(term => String(term || '').toLowerCase().trim())
        .filter(term => term.length >= 2));
}

function characterNgramDice(textA, textB, size = 2) {
    const aText = normalizeComparableText(textA);
    const bText = normalizeComparableText(textB);
    if (aText.length < size || bText.length < size) return 0;
    const build = (text) => {
        const grams = new Map();
        for (let i = 0; i <= text.length - size; i += 1) {
            const gram = text.slice(i, i + size);
            grams.set(gram, (grams.get(gram) || 0) + 1);
        }
        return grams;
    };
    const aGrams = build(aText);
    const bGrams = build(bText);
    let overlap = 0;
    let totalA = 0;
    let totalB = 0;
    aGrams.forEach((count, gram) => {
        totalA += count;
        overlap += Math.min(count, bGrams.get(gram) || 0);
    });
    bGrams.forEach(count => {
        totalB += count;
    });
    return totalA + totalB > 0 ? (2 * overlap) / (totalA + totalB) : 0;
}

function memoryPairSimilarity(a, b) {
    const aText = normalizeComparableText(a.content);
    const bText = normalizeComparableText(b.content);
    if (!aText || !bText) return 0;
    if (aText === bText) return 1;
    if (aText.includes(bText) || bText.includes(aText)) return 0.92;
    const aTerms = tokenSetForSimilarity(a.content);
    const bTerms = tokenSetForSimilarity(b.content);
    let intersection = 0;
    aTerms.forEach(term => {
        if (bTerms.has(term)) intersection += 1;
    });
    const union = new Set([...aTerms, ...bTerms]).size;
    const keywordScoreValue = union > 0 ? intersection / union : 0;
    return Math.max(keywordScoreValue, characterNgramDice(a.content, b.content));
}

function getMemoryMergeSuggestions(userId, options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 20, 100));
    const rows = db.prepare(`
        SELECT *
        FROM memories
        WHERE user_id = ?
          AND status = ?
        ORDER BY type ASC, salience DESC, updated_at DESC
        LIMIT 500
    `).all(userId, MEMORY_STATUS.active);
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

function mergeMemoryContent(target, source) {
    const targetContent = normalizeMemoryContent(target.content);
    const sourceContent = normalizeMemoryContent(source.content);
    const targetComparable = normalizeComparableText(targetContent);
    const sourceComparable = normalizeComparableText(sourceContent);
    if (targetComparable.includes(sourceComparable)) return targetContent;
    if (sourceComparable.includes(targetComparable)) return sourceContent;
    return normalizeMemoryContent(`${targetContent}; ${sourceContent}`);
}

async function mergeMemories(userId, targetId, sourceId, options = {}) {
    const normalizedTargetId = Number.parseInt(targetId, 10);
    const normalizedSourceId = Number.parseInt(sourceId, 10);
    if (!Number.isSafeInteger(normalizedTargetId) || !Number.isSafeInteger(normalizedSourceId) || normalizedTargetId === normalizedSourceId) {
        throw createMemoryValidationError('Invalid memory merge target');
    }
    const target = getMemoryRow(userId, normalizedTargetId);
    const source = getMemoryRow(userId, normalizedSourceId);
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
    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE memories
            SET content = ?,
                embedding = ?,
                salience = ?,
                confidence = ?,
                source_session_id = COALESCE(source_session_id, ?),
                source_message_ids = ?,
                updated_at = ?
            WHERE id = ? AND user_id = ?
        `).run(
            content,
            embedding,
            Math.max(Number(target.salience || 0), Number(source.salience || 0)),
            Math.max(Number(target.confidence || 0), Number(source.confidence || 0)),
            source.source_session_id || null,
            JSON.stringify(sourceMessageIds),
            now,
            target.id,
            userId
        );
        db.prepare(`
            UPDATE memories
            SET status = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `).run(MEMORY_STATUS.deleted, now, source.id, userId);
    });
    tx();
    return {
        merged: true,
        target: serializeMemory(db.prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?').get(target.id, userId)),
        deletedSourceId: source.id
    };
}

function findSimilarMemory(userId, type, content) {
    const fingerprint = fingerprintMemory(type, content);
    const rows = db.prepare(`
        SELECT *
        FROM memories
        WHERE user_id = ? AND type = ? AND status = ?
        ORDER BY updated_at DESC
        LIMIT 200
    `).all(userId, type, MEMORY_STATUS.active);
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
    const scope = normalizeMemoryScope(candidate.scope);
    const salience = clamp(candidate.salience, 0, 1, 0.5);
    const confidence = clamp(candidate.confidence, 0, 1, 0.6);
    const sourceMessageIds = normalizeSourceMessageIds(candidate.sourceMessageIds);
    const now = getBeijingTimestamp();
    const existing = findSimilarMemory(userId, type, content);

    if (existing) {
        const mergedMessageIds = [...new Set([
            ...parseJsonArray(existing.source_message_ids),
            ...sourceMessageIds
        ])].slice(-20);
        const mergedContent = content.length > String(existing.content || '').length ? content : existing.content;
        db.prepare(`
            UPDATE memories
            SET content = ?,
                scope = ?,
                salience = ?,
                confidence = ?,
                source_session_id = COALESCE(?, source_session_id),
                source_message_ids = ?,
                updated_at = ?
            WHERE id = ? AND user_id = ?
        `).run(
            mergedContent,
            scope,
            Math.max(Number(existing.salience || 0), salience),
            Math.max(Number(existing.confidence || 0), confidence),
            candidate.sourceSessionId || null,
            JSON.stringify(mergedMessageIds),
            now,
            existing.id,
            userId
        );
        return { merged: true, id: existing.id };
    }

    const embedding = options.skipEmbedding ? null : await maybeGenerateMemoryEmbedding(content, userId, options.user || null);
    const info = db.prepare(`
        INSERT INTO memories (
            user_id, scope, type, content, embedding, salience, confidence,
            source_session_id, source_message_ids, status, expires_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        userId,
        scope,
        type,
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
    );
    return { inserted: true, id: info.lastInsertRowid };
}

function buildCandidate({ type, content, salience, confidence, sourceSessionId, sourceMessageIds }) {
    return {
        type,
        scope: 'user',
        content: normalizeMemoryContent(content),
        salience,
        confidence,
        sourceSessionId,
        sourceMessageIds
    };
}

function splitMeaningfulLines(text) {
    return String(text || '')
        .split(/[\r\n。！？!?；;]+/)
        .map(line => line.trim())
        .filter(line => line.length >= MIN_MEMORY_CONTENT_CHARS)
        .slice(0, 20);
}

function classifyLine(line) {
    const text = String(line || '').trim();
    if (!text || hasSensitiveContent(text)) return null;
    if (/(我|本人|用户).{0,8}(喜欢|偏好|习惯|希望|倾向|不喜欢|不要|默认|优先|更喜欢)/.test(text)
        || /(prefer|preference|like|dislike|default|always|never)/i.test(text)) {
        return { type: MEMORY_TYPES.preference, salience: 0.78, confidence: 0.72 };
    }
    if (/(决定|约定|确认|以后|长期|固定|统一|最终|不再|保持|采用)/.test(text)
        || /(decided|decision|agreed|keep using|standardize)/i.test(text)) {
        return { type: MEMORY_TYPES.decision, salience: 0.86, confidence: 0.7 };
    }
    if (/(项目|任务|系统|模块|接口|数据库|表|字段|版本|部署|环境|模型|用户|团队|客户|需求).{0,80}(是|为|叫|使用|采用|位于|属于|负责|需要|已经|正在)/.test(text)
        || /(project|task|module|database|api|service|version|uses|requires|located)/i.test(text)) {
        return { type: MEMORY_TYPES.fact, salience: 0.68, confidence: 0.64 };
    }
    if (text.length >= 24 && /(今天|刚才|上次|这轮|之前|已经|完成|修复|新增|讨论|提到)/.test(text)) {
        return { type: MEMORY_TYPES.episode, salience: 0.48, confidence: 0.52 };
    }
    return null;
}

function extractMemoryCandidatesFromMessages(messages = [], context = {}) {
    const sourceMessageIds = normalizeSourceMessageIds(messages.map(message => message.id));
    const sourceSessionId = context.sessionId || messages.find(message => message.session_id)?.session_id || null;
    const candidates = [];
    messages
        .filter(message => ['user', 'assistant'].includes(message?.role))
        .forEach(message => {
            splitMeaningfulLines(contentText(message.content)).forEach(line => {
                const classification = classifyLine(line);
                if (!classification) return;
                candidates.push(buildCandidate({
                    ...classification,
                    content: line,
                    sourceSessionId,
                    sourceMessageIds
                }));
            });
        });

    const byKey = new Map();
    candidates.forEach(candidate => {
        const key = fingerprintMemory(candidate.type, candidate.content);
        const existing = byKey.get(key);
        if (!existing || candidate.salience > existing.salience) byKey.set(key, candidate);
    });
    return Array.from(byKey.values()).slice(0, 8);
}

function enqueueMemoryExtractionJob({ userId, sessionId, messageIds = [], modelId = null } = {}) {
    if (!userId || !sessionId || !Array.isArray(messageIds) || messageIds.length === 0) {
        return { queued: false, reason: 'missing_context' };
    }
    if (!isLongTermMemoryEnabled(userId)) {
        return { queued: false, reason: 'disabled' };
    }
    const ids = normalizeSourceMessageIds(messageIds);
    if (ids.length === 0) return { queued: false, reason: 'missing_context' };
    const now = getBeijingTimestamp();
    const dedupeKey = buildMemoryJobDedupeKey(userId, sessionId, ids);
    const existing = db.prepare(`
        SELECT *
        FROM memory_extraction_jobs
        WHERE dedupe_key = ?
          AND status IN (?, ?)
        ORDER BY id DESC
        LIMIT 1
    `).get(dedupeKey, MEMORY_JOB_STATUS.queued, MEMORY_JOB_STATUS.running);
    if (existing) {
        return {
            queued: true,
            deduped: true,
            job: serializeMemoryJob(existing),
            messageIds: ids
        };
    }
    const info = db.prepare(`
        INSERT INTO memory_extraction_jobs (
            user_id, session_id, message_ids, model_id, dedupe_key,
            status, attempts, max_attempts, created_at, updated_at, next_run_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
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
    );
    return {
        queued: true,
        job: serializeMemoryJob(db.prepare('SELECT * FROM memory_extraction_jobs WHERE id = ?').get(info.lastInsertRowid)),
        messageIds: ids
    };
}

function resolveMemoryJobUser(row) {
    return db.prepare('SELECT id, username, nickname, unit, role, status FROM users WHERE id = ? AND status = ?')
        .get(row.user_id, 'active')
        || { id: row.user_id, role: 'user' };
}

function resolveMemoryJobModel(row, user) {
    if (!row.model_id) return null;
    const model = getAccessibleModel(row.model_id, user);
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

function scheduleMemoryExtraction({ userId, sessionId, messageIds = [], user = null, modelCfg = null } = {}) {
    void user;
    const queued = enqueueMemoryExtractionJob({
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

function claimMemoryExtractionJobs(limit = 5) {
    const now = getBeijingTimestamp();
    const staleBefore = new Date(Date.now() - MEMORY_JOB_STALE_LOCK_MINUTES * 60000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
    const rows = db.prepare(`
        SELECT *
        FROM memory_extraction_jobs
        WHERE (
            status = ? AND COALESCE(next_run_at, created_at) <= ?
        ) OR (
            status = ? AND locked_at IS NOT NULL AND locked_at < ?
        )
        ORDER BY COALESCE(next_run_at, created_at) ASC, id ASC
        LIMIT ?
    `).all(MEMORY_JOB_STATUS.queued, now, MEMORY_JOB_STATUS.running, staleBefore, Math.max(1, Math.min(Number(limit) || 5, 20)));
    const claimed = [];
    rows.forEach(row => {
        const info = db.prepare(`
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
        `).run(MEMORY_JOB_STATUS.running, now, now, row.id, MEMORY_JOB_STATUS.queued, MEMORY_JOB_STATUS.running, staleBefore);
        if (info.changes > 0) {
            claimed.push(db.prepare('SELECT * FROM memory_extraction_jobs WHERE id = ?').get(row.id));
        }
    });
    return claimed;
}

function nextMemoryJobRunAt(attempts) {
    const delaySeconds = Math.min(3600, Math.max(15, 15 * (2 ** Math.max(0, Number(attempts || 1) - 1))));
    return new Date(Date.now() + delaySeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function finishMemoryExtractionJob(jobId, status, fields = {}) {
    const now = getBeijingTimestamp();
    db.prepare(`
        UPDATE memory_extraction_jobs
        SET status = ?,
            locked_at = NULL,
            last_error = ?,
            result = ?,
            next_run_at = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
    `).run(
        status,
        fields.lastError || null,
        fields.result ? JSON.stringify(fields.result).slice(0, 4000) : null,
        fields.nextRunAt || null,
        [MEMORY_JOB_STATUS.succeeded, MEMORY_JOB_STATUS.failed, MEMORY_JOB_STATUS.skipped].includes(status) ? now : null,
        now,
        jobId
    );
}

async function processMemoryExtractionJob(row) {
    const user = resolveMemoryJobUser(row);
    const modelCfg = resolveMemoryJobModel(row, user);
    const result = await runMemoryExtraction({
        userId: row.user_id,
        sessionId: row.session_id,
        messageIds: parseJsonArray(row.message_ids),
        user,
        modelCfg
    });
    const finalStatus = result.skipped ? MEMORY_JOB_STATUS.skipped : MEMORY_JOB_STATUS.succeeded;
    finishMemoryExtractionJob(row.id, finalStatus, { result });
    return result;
}

async function processMemoryExtractionJobs(options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 5, 20));
    const rows = claimMemoryExtractionJobs(limit);
    const results = [];
    for (const row of rows) {
        const key = `${row.user_id}:${row.session_id}:${row.id}`;
        try {
            const result = await extractionGuard.run(key, () => processMemoryExtractionJob(row));
            results.push({ id: row.id, ok: true, result });
        } catch (err) {
            const latest = db.prepare('SELECT attempts, max_attempts FROM memory_extraction_jobs WHERE id = ?').get(row.id) || row;
            const attempts = Number(latest.attempts || row.attempts || 1);
            const maxAttempts = Number(latest.max_attempts || DEFAULT_MEMORY_JOB_MAX_ATTEMPTS);
            const exhausted = attempts >= maxAttempts;
            finishMemoryExtractionJob(row.id, exhausted ? MEMORY_JOB_STATUS.failed : MEMORY_JOB_STATUS.queued, {
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

function listMemoryExtractionJobs(userId, options = {}) {
    const status = String(options.status || 'all');
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200));
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const where = ['user_id = ?'];
    const params = [userId];
    if (status !== 'all' && Object.values(MEMORY_JOB_STATUS).includes(status)) {
        where.push('status = ?');
        params.push(status);
    }
    const rows = db.prepare(`
        SELECT *
        FROM memory_extraction_jobs
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM memory_extraction_jobs WHERE ${where.join(' AND ')}`).get(...params).count || 0;
    return { total, jobs: rows.map(serializeMemoryJob), summary: getMemoryJobSummary(userId) };
}

function retryFailedMemoryExtractionJobs(userId, jobIds = []) {
    const ids = normalizeMemoryIds(jobIds);
    const now = getBeijingTimestamp();
    const where = ['user_id = ?', 'status = ?'];
    const params = [userId, MEMORY_JOB_STATUS.failed];
    if (ids.length > 0) {
        where.push(`id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
    }
    const info = db.prepare(`
        UPDATE memory_extraction_jobs
        SET status = ?,
            locked_at = NULL,
            last_error = NULL,
            next_run_at = ?,
            updated_at = ?
        WHERE ${where.join(' AND ')}
    `).run(MEMORY_JOB_STATUS.queued, now, now, ...params);
    if (info.changes > 0) triggerMemoryExtractionWorker();
    return { queued: info.changes };
}

function cleanupMemoryExtractionJobs(userId, options = {}) {
    const retentionDays = Math.max(1, Math.min(Number.parseInt(options.retentionDays, 10) || DEFAULT_COMPLETED_JOB_RETENTION_DAYS, 365));
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 1000, 5000));
    const cutoff = db.prepare("SELECT datetime('now', '+8 hours', ?) AS cutoff")
        .get(`-${retentionDays} days`).cutoff;
    const rows = db.prepare(`
        SELECT id
        FROM memory_extraction_jobs
        WHERE user_id = ?
          AND status IN (?, ?, ?)
          AND COALESCE(completed_at, updated_at, created_at) < ?
        ORDER BY COALESCE(completed_at, updated_at, created_at) ASC, id ASC
        LIMIT ?
    `).all(
        userId,
        MEMORY_JOB_STATUS.succeeded,
        MEMORY_JOB_STATUS.failed,
        MEMORY_JOB_STATUS.skipped,
        cutoff,
        limit
    );
    if (rows.length === 0) return { deleted: 0, cutoff, retentionDays };
    const ids = rows.map(row => row.id);
    const info = db.prepare(`
        DELETE FROM memory_extraction_jobs
        WHERE user_id = ?
          AND id IN (${ids.map(() => '?').join(',')})
    `).run(userId, ...ids);
    return { deleted: info.changes, cutoff, retentionDays };
}

async function runMemoryExtraction({ userId, sessionId, messageIds = [], user = null, modelCfg = null } = {}) {
    const ids = normalizeSourceMessageIds(messageIds);
    if (!isLongTermMemoryEnabled(userId) || ids.length === 0) {
        return { skipped: true };
    }
    const placeholders = ids.map(() => '?').join(',');
    const messages = db.prepare(`
        SELECT id, session_id, role, content
        FROM messages
        WHERE user_id = ? AND session_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL
        ORDER BY id ASC
    `).all(userId, sessionId, ...ids);
    let extractor = 'heuristic';
    let candidates = [];
    if (modelCfg?.url) {
        try {
            candidates = await extractMemoryCandidatesWithModel(messages, { sessionId, user, modelCfg });
            if (candidates.length > 0) extractor = 'model';
        } catch (err) {
            logger.warn({ userId, sessionId, err: err.message }, '长期记忆模型抽取失败，已回退到启发式规则');
        }
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
        inserted: results.filter(item => item.inserted).length,
        merged: results.filter(item => item.merged).length,
        skipped: results.filter(item => item.skipped).length
    };
}

function parseEmbedding(raw) {
    if (!raw) return null;
    try {
        const vector = JSON.parse(raw);
        return Array.isArray(vector) ? vector.map(Number).filter(Number.isFinite) : null;
    } catch (_err) {
        return null;
    }
}

function keywordScore(memory, query) {
    const terms = buildKeywordCandidates(query, 24);
    if (terms.length === 0) return 0;
    const haystack = `${memory.content || ''} ${memory.type || ''}`.toLowerCase();
    let matched = 0;
    let total = 0;
    terms.forEach(term => {
        const text = String(term || '').toLowerCase();
        const weight = Math.min(text.length, 8) || 1;
        total += weight;
        if (text && haystack.includes(text)) matched += weight;
    });
    return total > 0 ? matched / total : 0;
}

function recencyScore(memory) {
    const raw = memory.last_used_at || memory.updated_at || memory.created_at;
    const time = raw ? Date.parse(String(raw).replace(' ', 'T')) : 0;
    if (!Number.isFinite(time) || time <= 0) return 0.2;
    const ageDays = Math.max(0, (Date.now() - time) / 86400000);
    return 1 / (1 + ageDays / 30);
}

async function retrieveLongTermMemories(userId, query, options = {}) {
    if (!isLongTermMemoryEnabled(userId)) return [];
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return [];
    const now = getBeijingTimestamp();
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || DEFAULT_MAX_INJECTED_MEMORIES, 20));
    const rows = db.prepare(`
        SELECT *
        FROM memories
        WHERE user_id = ?
          AND status = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY salience DESC, confidence DESC, updated_at DESC
        LIMIT 200
    `).all(userId, MEMORY_STATUS.active, now);
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
        db.prepare(`UPDATE memories SET last_used_at = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
            .run(now, userId, ...ids);
    }
    return scored;
}

function buildLongTermMemoryContextMessage(memories = [], options = {}) {
    if (!Array.isArray(memories) || memories.length === 0) return null;
    const ratio = clamp(
        options.budgetRatio,
        MIN_RETRIEVAL_BUDGET_RATIO,
        MAX_RETRIEVAL_BUDGET_RATIO,
        DEFAULT_RETRIEVAL_BUDGET_RATIO
    );
    const inputBudget = Math.max(0, Number(options.inputBudget || 0));
    const maxTokens = inputBudget > 0
        ? Math.max(256, Math.floor(inputBudget * ratio))
        : Math.max(512, Number(options.maxTokens || 1200));
    const header = [
        'PIVOT_LONG_TERM_MEMORY_BEGIN',
        '以下为跨会话长期记忆，按相关性、近期性和重要性排序；仅在与当前问题相关时使用，不要向用户暴露记忆编号或内部字段。'
    ];
    const lines = [];
    let used = estimateTokens(header.join('\n') + '\nPIVOT_LONG_TERM_MEMORY_END');
    for (const memory of memories) {
        const label = MEMORY_TYPE_LABELS[normalizeMemoryType(memory.type)] || '历史片段';
        const line = `- [${label} | 重要度 ${Number(memory.salience || 0).toFixed(2)} | 置信度 ${Number(memory.confidence || 0).toFixed(2)}] ${memory.content}`;
        const next = estimateTokens(`${line}\n`);
        if (used + next > maxTokens) break;
        lines.push(line);
        used += next;
    }
    if (lines.length === 0) return null;
    return {
        role: 'system',
        content: [...header, ...lines, 'PIVOT_LONG_TERM_MEMORY_END'].join('\n'),
        metadata: {
            type: 'long_term_memory',
            memoryCount: lines.length,
            budgetTokens: maxTokens
        }
    };
}

function injectLongTermMemoryBeforeLatestUser(messages = [], memoryMessage = null) {
    if (!memoryMessage) return messages;
    const output = Array.isArray(messages) ? messages.slice() : [];
    for (let i = output.length - 1; i >= 0; i -= 1) {
        if (output[i]?.role === 'user') {
            output.splice(i, 0, memoryMessage);
            return output;
        }
    }
    output.push(memoryMessage);
    return output;
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
