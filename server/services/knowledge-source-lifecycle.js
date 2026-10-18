'use strict';

// 原始资料、图谱、Wiki 与检索缓存之间的失效不能依赖“尽力而为”的散落调用。
// 此模块采用可领取、可重试的 outbox；写资料状态的事务只负责入队，后台负责将
// 同一来源事件投递给所有派生读模型。
const crypto = require('crypto');
const { execute, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { clearRagCacheForUser } = require('./rag-cache');

const DEFAULT_POLL_MS = 1000;
const DEFAULT_CLAIM_LIMIT = 30;
const CLAIM_TIMEOUT_MS = 90 * 1000;
const GRAPH_INVALIDATING_EVENTS = new Set(['source_deleted', 'source_disabled', 'source_expired', 'source_archived']);

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeWorkerId(value = '') {
    return String(value || '').trim().slice(0, 120) || `knowledge-lifecycle-${process.pid}`;
}

function lifecycleEventKey({ legacyDocId, documentId, eventType, payload = {} }) {
    const identity = JSON.stringify({
        legacyDocId: normalizeId(legacyDocId),
        documentId: normalizeId(documentId),
        eventType: String(eventType || '').trim().slice(0, 80),
        versionId: normalizeId(payload?.versionId ?? payload?.version_id),
        sourceHash: String(payload?.sourceHash ?? payload?.source_hash ?? '').slice(0, 160),
        revision: String(payload?.revision ?? payload?.reason ?? '').slice(0, 160)
    });
    return 'sha256:' + crypto.createHash('sha256').update(identity).digest('hex');
}

function knowledgeMemorySourceReference(event = {}) {
    const documentId = normalizeId(event.document_id ?? event.documentId);
    const legacyDocId = normalizeId(event.legacy_doc_id ?? event.legacyDocId);
    return documentId ? `knowledge_document:${documentId}` : legacyDocId ? `knowledge_legacy_document:${legacyDocId}` : '';
}

function knowledgeMemorySourceFingerprintInput(event = {}, payload = {}) {
    const sourceRef = knowledgeMemorySourceReference(event);
    const sourceHash = String(payload?.sourceHash ?? payload?.source_hash ?? '').trim().slice(0, 160);
    const version = String(payload?.versionId ?? payload?.version_id ?? '').trim().slice(0, 80);
    return { sourceKind: 'knowledge_document', sourceRef, content: sourceHash, version };
}

async function enqueueKnowledgeSourceLifecycleEvent({
    userId,
    legacyDocId = null,
    documentId = null,
    eventType = 'source_changed',
    payload = {}
} = {}, deps = {}) {
    const safeUserId = normalizeId(userId);
    const safeLegacyDocId = normalizeId(legacyDocId);
    const safeDocumentId = normalizeId(documentId);
    const safeType = String(eventType || '').trim().slice(0, 80);
    if (!safeUserId || !safeType || (!safeLegacyDocId && !safeDocumentId)) return null;
    const now = getBeijingTimestamp();
    const eventKey = lifecycleEventKey({ legacyDocId: safeLegacyDocId, documentId: safeDocumentId, eventType: safeType, payload });
    const runner = deps.trx || null;
    const insert = async db => await db.queryOne(`
        INSERT INTO knowledge_source_lifecycle_outbox (
            id, event_key, user_id, legacy_doc_id, document_id, event_type, payload_json,
            status, attempts, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, 'pending', 0, ?, ?, ?)
        ON CONFLICT (event_key) DO UPDATE
        SET payload_json = EXCLUDED.payload_json,
            status = 'pending', attempts = 0, available_at = EXCLUDED.available_at,
            locked_by = '', locked_at = NULL, handled_at = NULL, last_error = '',
            updated_at = EXCLUDED.updated_at
        RETURNING *
    `, [crypto.randomUUID(), eventKey, safeUserId, safeLegacyDocId, safeDocumentId, safeType, JSON.stringify(payload || {}), now, now, now]);
    if (runner) return await insert(runner);
    const transactionFn = deps.transaction || transaction;
    return await transactionFn(insert);
}

async function claimKnowledgeSourceLifecycleEvents({ workerId = '', limit = DEFAULT_CLAIM_LIMIT } = {}, deps = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || DEFAULT_CLAIM_LIMIT, 1), 200);
    const now = getBeijingTimestamp();
    const staleBefore = getBeijingTimestamp(new Date(Date.now() - CLAIM_TIMEOUT_MS));
    const transactionFn = deps.transaction || transaction;
    return await transactionFn(async trx => {
        await trx.execute(`
            UPDATE knowledge_source_lifecycle_outbox
            SET status = 'pending', locked_at = NULL, locked_by = '', available_at = ?, updated_at = ?
            WHERE status = 'claimed' AND locked_at IS NOT NULL AND locked_at < ?
        `, [now, now, staleBefore]);
        const rows = await trx.query(`
            SELECT * FROM knowledge_source_lifecycle_outbox
            WHERE status = 'pending' AND available_at <= ?
            ORDER BY created_at ASC
            LIMIT ? FOR UPDATE SKIP LOCKED
        `, [now, safeLimit]);
        for (const row of rows) {
            await trx.execute(`
                UPDATE knowledge_source_lifecycle_outbox
                SET status = 'claimed', attempts = attempts + 1, locked_by = ?, locked_at = ?, updated_at = ?
                WHERE id = ?
            `, [safeWorkerId, now, now, row.id]);
        }
        return rows.map(row => ({ ...row, status: 'claimed', locked_by: safeWorkerId, payload: parseJson(row.payload_json, {}) }));
    });
}

async function completeKnowledgeSourceLifecycleEvent(id, workerId = '', deps = {}) {
    const now = getBeijingTimestamp();
    return await (deps.execute || execute)(`
        UPDATE knowledge_source_lifecycle_outbox
        SET status = 'completed', handled_at = ?, locked_at = NULL, locked_by = '', last_error = '', updated_at = ?
        WHERE id = ? AND status = 'claimed' AND locked_by = ?
    `, [now, now, id, normalizeWorkerId(workerId)]);
}

async function failKnowledgeSourceLifecycleEvent(id, workerId = '', error, deps = {}) {
    const now = getBeijingTimestamp();
    const attempts = Math.max(1, Number(error?.attempts || 1));
    const delayMs = Math.min(5 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 8)));
    const retryAt = getBeijingTimestamp(new Date(Date.now() + delayMs));
    return await (deps.execute || execute)(`
        UPDATE knowledge_source_lifecycle_outbox
        SET status = 'pending', available_at = ?, locked_at = NULL, locked_by = '',
            last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed' AND locked_by = ?
    `, [retryAt, String(error?.message || error || 'lifecycle dispatch failed').slice(0, 1000), now, id, normalizeWorkerId(workerId)]);
}

async function handleKnowledgeSourceLifecycleEvent(event, deps = {}) {
    const graph = deps.graph || require('./knowledge-graph');
    const wiki = deps.wiki || require('./knowledge-wiki');
    const clearCache = deps.clearRagCacheForUser || clearRagCacheForUser;
    const payload = event?.payload || parseJson(event?.payload_json, {});
    const eventType = String(event?.event_type || '').trim();
    const legacyDocId = normalizeId(event?.legacy_doc_id);
    const documentId = normalizeId(event?.document_id);
    let graphInvalidated = 0;
    if (GRAPH_INVALIDATING_EVENTS.has(eventType) && legacyDocId) {
        const result = await graph.invalidateKnowledgeGraphSources({ userId: event.user_id, docId: legacyDocId, reason: eventType }, deps);
        graphInvalidated = Number(result?.relations || 0) + Number(result?.mentions || 0);
    }
    if (['source_enabled', 'manual_version_published'].includes(eventType) && legacyDocId) {
        const rebuilt = await graph.rebuildGraphForDocument({ userId: event.user_id, docId: legacyDocId });
        graphInvalidated = Number(rebuilt?.entities || 0) + Number(rebuilt?.relations || 0);
    }
    const wikiResult = await wiki.markWikiPagesStaleForDocument({
        documentId,
        legacyDocId,
        reason: eventType || payload.reason || 'source_changed'
    }, deps);
    const sourceRef = knowledgeMemorySourceReference(event);
    let memoryResult = { reviewed: 0, revoked: 0, skipped: !sourceRef };
    if (sourceRef && event?.user_id) {
        const memory = deps.memory || require('./long-term-memory');
        if (['source_deleted', 'source_archived'].includes(eventType)) {
            memoryResult = await memory.revokeMemoriesForSourceReference(event.user_id, 'knowledge_document', sourceRef, {
                reason: `knowledge_${eventType}`
            });
        } else if (['source_disabled', 'source_expired'].includes(eventType)) {
            memoryResult = await memory.markMemoriesForSourceReview(event.user_id, {
                sourceKind: 'knowledge_document', sourceRef, reason: `knowledge_${eventType}`
            });
        } else {
            const input = knowledgeMemorySourceFingerprintInput(event, payload);
            const fingerprint = memory.sourceFingerprint(input);
            memoryResult = fingerprint
                ? await memory.markMemoriesForChangedSource(event.user_id, {
                    sourceKind: input.sourceKind, sourceRef: input.sourceRef, sourceFingerprint: fingerprint,
                    reason: `knowledge_${eventType || 'source_changed'}`
                })
                : { reviewed: 0, revoked: 0, skipped: true, reason: 'fingerprint_secret_missing' };
        }
    }
    clearCache?.(event.user_id);
    return { graphInvalidated, wikiResult: wikiResult || { stalePages: 0 }, memoryResult };
}

async function dispatchKnowledgeSourceLifecycleBatch({ workerId = '', limit = DEFAULT_CLAIM_LIMIT } = {}, deps = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const events = await claimKnowledgeSourceLifecycleEvents({ workerId: safeWorkerId, limit }, deps);
    let completed = 0;
    for (const event of events) {
        try {
            await handleKnowledgeSourceLifecycleEvent(event, deps);
            await completeKnowledgeSourceLifecycleEvent(event.id, safeWorkerId, deps);
            completed += 1;
        } catch (error) {
            await failKnowledgeSourceLifecycleEvent(event.id, safeWorkerId, { ...error, attempts: event.attempts }, deps).catch(() => {});
            logger.warn({ err: error.message, eventId: event.id, eventType: event.event_type }, '知识来源生命周期事件投递失败');
        }
    }
    return { claimed: events.length, completed };
}

function createKnowledgeSourceLifecycleWorker({ workerId = '', pollIntervalMs = DEFAULT_POLL_MS, logger: log = logger, deps = {} } = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const interval = Math.min(Math.max(Number.parseInt(pollIntervalMs, 10) || DEFAULT_POLL_MS, 250), 60000);
    let timer = null;
    let running = false;
    const runOnce = async () => {
        if (running) return null;
        running = true;
        try { return await dispatchKnowledgeSourceLifecycleBatch({ workerId: safeWorkerId }, deps); }
        catch (error) { log.warn?.({ err: error.message }, '知识来源生命周期 Worker 执行失败'); return null; }
        finally { running = false; }
    };
    return {
        start() {
            if (timer) return { workerId: safeWorkerId, started: true };
            timer = setInterval(() => { void runOnce(); }, interval);
            timer.unref?.();
            void runOnce();
            return { workerId: safeWorkerId, started: true };
        },
        stop() { if (timer) clearInterval(timer); timer = null; },
        runOnce,
        getRuntimeStatus: () => ({ workerId: safeWorkerId, started: Boolean(timer), running })
    };
}

async function getKnowledgeSourceLifecycleMetrics(userId, { lookbackDays = 30 } = {}, deps = {}) {
    const safeUserId = normalizeId(userId);
    if (!safeUserId) return null;
    const days = Math.min(Math.max(Number.parseInt(lookbackDays, 10) || 30, 1), 3650);
    const row = await (deps.queryOne || queryOne)(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'completed') AS completed,
               COUNT(*) FILTER (WHERE status = 'pending' OR status = 'claimed') AS pending,
               COALESCE(percentile_cont(0.95) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (handled_at - created_at))
               ) FILTER (WHERE status = 'completed' AND handled_at IS NOT NULL), 0) AS p95_seconds
        FROM knowledge_source_lifecycle_outbox
        WHERE user_id = ? AND created_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 day')
    `, [safeUserId, days]);
    const p95LatencySeconds = Number(row?.p95_seconds || 0);
    return {
        lookbackDays: days,
        total: Number(row?.total || 0), completed: Number(row?.completed || 0), pending: Number(row?.pending || 0),
        p95LatencySeconds,
        slo: {
            targetP95Seconds: 300,
            met: Number(row?.total || 0) === 0 ? null : p95LatencySeconds <= 300
        }
    };
}

module.exports = {
    createKnowledgeSourceLifecycleWorker,
    enqueueKnowledgeSourceLifecycleEvent,
    getKnowledgeSourceLifecycleMetrics,
    handleKnowledgeSourceLifecycleEvent,
    knowledgeMemorySourceFingerprintInput,
    knowledgeMemorySourceReference,
    lifecycleEventKey
};
