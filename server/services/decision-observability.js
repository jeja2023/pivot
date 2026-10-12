'use strict';

const crypto = require('crypto');
const { execute, query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { sanitizeDecisionContext, normalizeActionId } = require('./decision-provider');
const { logger } = require('../logger');

const MAX_PENDING = 5000;
const FLUSH_INTERVAL_MS = 1000;
const pendingDecisions = new Map();
const pendingOutcomes = [];
let flushTimer = null;
let flushInFlight = null;

const UPSERT_DECISION_SQL = [
    'INSERT INTO decision_records (decision_id, scenario, tenant_id, user_id, session_id, request_state, candidate_actions, provider_outputs, policy_outcome, selected_action_id, created_at, updated_at)',
    'VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?)',
    'ON CONFLICT (decision_id) DO UPDATE SET provider_outputs = EXCLUDED.provider_outputs, policy_outcome = EXCLUDED.policy_outcome, selected_action_id = EXCLUDED.selected_action_id, updated_at = EXCLUDED.updated_at'
].join(' ');

const GET_DECISION_RECORD_SQL = 'SELECT decision_id, candidate_actions, selected_action_id FROM decision_records WHERE decision_id = ?';

const INSERT_OUTCOME_SQL = [
    'INSERT INTO decision_outcomes (id, decision_id, event_type, source, status, selected_action_id, verified_action_id, is_verified, duration_ms, reason_code, result_reference, metadata, occurred_at, created_at, review_status)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)',
    'ON CONFLICT (id) DO NOTHING'
].join(' ');

function safeText(value, max = 160) {
    return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeJson(value, fallback = {}) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return fallback; }
}

function serializeProviderOutputs(outputs = []) {
    return (Array.isArray(outputs) ? outputs : []).slice(0, 8).map(output => ({
        providerId: safeText(output?.providerId, 80),
        providerVersion: safeText(output?.providerVersion, 128),
        selectedActionId: normalizeActionId(output?.selectedActionId),
        scores: Object.fromEntries(Object.entries(output?.scores || {}).slice(0, 32).map(([id, score]) => [normalizeActionId(id), Math.max(0, Math.min(1, Number(score) || 0))]).filter(([id]) => id)),
        durationMs: Math.max(0, Math.round(Number(output?.durationMs) || 0)),
        error: safeText(output?.error, 240),
        metadata: {
            model: safeText(output?.metadata?.model, 128),
            configurationVersion: safeText(output?.metadata?.configurationVersion, 128)
        }
    }));
}

function serializePolicy(value = {}) {
    return {
        policyVersion: safeText(value.policyVersion, 128),
        mode: safeText(value.mode, 24),
        selectedActionId: normalizeActionId(value.selectedActionId),
        suggestedActionId: normalizeActionId(value.suggestedActionId),
        fallbackActionId: normalizeActionId(value.fallbackActionId),
        confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
        threshold: Math.max(0, Math.min(1, Number(value.threshold) || 0)),
        reasonCode: safeText(value.reasonCode, 80),
        policyArtifactId: safeText(value.policyArtifactId, 128),
        policyArtifactStatus: safeText(value.policyArtifactStatus, 32),
        applied: value.applied === true
    };
}

function serializeDecision(value = {}) {
    const context = sanitizeDecisionContext(value.context || value);
    const decisionId = safeText(value.decisionId || context.decisionId, 128);
    if (!decisionId) return null;
    const now = value.createdAt || getBeijingTimestamp();
    return {
        decisionId,
        scenario: context.scenario,
        tenantId: Number.isSafeInteger(Number(value.tenantId ?? context.tenantId)) ? Number(value.tenantId ?? context.tenantId) : null,
        userId: Number.isSafeInteger(Number(value.userId)) ? Number(value.userId) : null,
        sessionId: safeText(value.sessionId, 128),
        requestState: { ...context.requestState, language: context.language },
        candidates: context.candidates,
        providerOutputs: serializeProviderOutputs(value.providerOutputs),
        policy: serializePolicy(value.policy),
        selectedActionId: normalizeActionId(value.selectedActionId || value.policy?.selectedActionId),
        createdAt: now,
        updatedAt: now
    };
}

function serializeOutcome(value = {}) {
    const decisionId = safeText(value.decisionId, 128);
    if (!decisionId) return null;
    const eventType = ['execution', 'feedback', 'verification'].includes(String(value.eventType || '').toLowerCase())
        ? String(value.eventType).toLowerCase()
        : 'execution';
    const source = ['runtime', 'user', 'admin', 'system'].includes(String(value.source || '').toLowerCase())
        ? String(value.source).toLowerCase()
        : 'runtime';
    const verifiedActionId = normalizeActionId(value.verifiedActionId);
    const isVerified = eventType === 'verification'
        && ['user', 'admin', 'system'].includes(source)
        && Boolean(verifiedActionId);
    return {
        id: safeText(value.id, 128) || 'outcome_' + crypto.randomUUID(),
        decisionId,
        eventType,
        source,
        status: ['success', 'partial', 'failure', 'skipped', 'unknown'].includes(String(value.status || '').toLowerCase())
            ? String(value.status).toLowerCase()
            : 'unknown',
        selectedActionId: normalizeActionId(value.selectedActionId),
        verifiedActionId,
        isVerified,
        durationMs: Math.max(0, Math.round(Number(value.durationMs) || 0)),
        reasonCode: safeText(value.reasonCode, 120),
        resultReference: safeText(value.resultReference, 160),
        metadata: safeJson(value.metadata && typeof value.metadata === 'object' ? value.metadata : {}, {}),
        occurredAt: value.occurredAt || getBeijingTimestamp(),
        createdAt: getBeijingTimestamp()
    };
}

function scheduleFlush() {
    if (flushTimer || flushInFlight || (!pendingDecisions.size && !pendingOutcomes.length)) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPendingDecisionObservability().catch(error => logger.warn({ err: error.message }, '决策观测数据持久化失败'));
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
}

function recordDecision(value = {}, { persist = true } = {}) {
    const decision = serializeDecision(value);
    if (!decision) return null;
    if (persist) {
        if (pendingDecisions.size >= MAX_PENDING && !pendingDecisions.has(decision.decisionId)) pendingDecisions.delete(pendingDecisions.keys().next().value);
        pendingDecisions.set(decision.decisionId, decision);
        scheduleFlush();
    }
    return decision;
}

function recordDecisionOutcome(value = {}, { persist = true } = {}) {
    const outcome = serializeOutcome(value);
    if (!outcome) return null;
    if (persist) {
        if (pendingOutcomes.length >= MAX_PENDING) pendingOutcomes.shift();
        pendingOutcomes.push(outcome);
        scheduleFlush();
    }
    return outcome;
}

function candidateAllowsVerifiedAction(candidateActions, actionId) {
    let candidates = [];
    try { candidates = typeof candidateActions === 'string' ? JSON.parse(candidateActions) : candidateActions; } catch (_) {}
    return Array.isArray(candidates) && candidates.some(candidate => candidate?.allowed !== false && normalizeActionId(candidate?.id) === actionId);
}

const OWNED_DECISION_SQL = 'SELECT decision_id, user_id, session_id, candidate_actions, selected_action_id FROM decision_records WHERE decision_id = ?';

const USER_FEEDBACK_REASON_CODES = new Set([
    'intent_mismatch',
    'missing_evidence',
    'tool_not_suitable',
    'preference_mismatch',
    'other'
]);

const UPSERT_USER_FEEDBACK_SQL = [
    'INSERT INTO decision_outcomes (id, decision_id, event_type, source, status, selected_action_id, verified_action_id, is_verified, duration_ms, reason_code, result_reference, metadata, occurred_at, created_at, review_status)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)',
    "ON CONFLICT (decision_id) WHERE event_type = 'feedback' AND source = 'user' AND review_status = 'pending'",
    'DO UPDATE SET status = EXCLUDED.status, selected_action_id = EXCLUDED.selected_action_id, verified_action_id = EXCLUDED.verified_action_id, reason_code = EXCLUDED.reason_code, result_reference = EXCLUDED.result_reference, metadata = EXCLUDED.metadata, occurred_at = EXCLUDED.occurred_at',
    'RETURNING id, review_status'
].join(' ');

const LIST_USER_FEEDBACK_SQL = [
    'SELECT o.id AS feedback_id, o.decision_id, d.scenario, d.tenant_id, d.session_id,',
    'o.selected_action_id, o.verified_action_id AS corrected_action_id, o.status, o.reason_code, o.metadata,',
    'o.review_status, o.reviewed_by, o.reviewed_at, o.review_note, o.occurred_at,',
    'u.username, u.nickname',
    'FROM decision_outcomes o',
    'JOIN decision_records d ON d.decision_id = o.decision_id',
    'LEFT JOIN users u ON u.id = d.user_id',
    "WHERE o.event_type = 'feedback' AND o.source = 'user' AND o.review_status = ?",
    'ORDER BY o.occurred_at DESC, o.id DESC LIMIT ?'
].join(' ');

const USER_SESSION_FEEDBACK_STATUS_SQL = [
    'SELECT DISTINCT ON (o.decision_id) o.decision_id, o.verified_action_id AS corrected_action_id,',
    'o.review_status, o.reviewed_at, o.occurred_at',
    'FROM decision_outcomes o JOIN decision_records d ON d.decision_id = o.decision_id',
    "WHERE d.user_id = ? AND d.session_id = ? AND o.event_type = 'feedback' AND o.source = 'user'",
    'ORDER BY o.decision_id, o.occurred_at DESC, o.id DESC'
].join(' ');

const PENDING_USER_FEEDBACK_SQL = [
    'SELECT o.id AS feedback_id, o.decision_id, o.verified_action_id AS corrected_action_id,',
    'd.selected_action_id, d.candidate_actions',
    'FROM decision_outcomes o JOIN decision_records d ON d.decision_id = o.decision_id',
    "WHERE o.id = ? AND o.event_type = 'feedback' AND o.source = 'user' AND o.review_status = 'pending'",
    'FOR UPDATE'
].join(' ');

const REVIEW_USER_FEEDBACK_SQL = [
    "UPDATE decision_outcomes SET review_status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?",
    "WHERE id = ? AND event_type = 'feedback' AND source = 'user' AND review_status = 'pending'",
    'RETURNING id, decision_id, review_status, reviewed_at'
].join(' ');

function outcomeSqlParams(item, reviewStatus = null) {
    const resolvedReviewStatus = reviewStatus || (item.eventType === 'feedback' && item.source === 'user' ? 'pending' : 'not_required');
    return [item.id, item.decisionId, item.eventType, item.source, item.status, item.selectedActionId, item.verifiedActionId, item.isVerified, item.durationMs, item.reasonCode, item.resultReference, JSON.stringify(item.metadata), item.occurredAt, item.createdAt, resolvedReviewStatus];
}

function normalizeFeedbackReason(value) {
    const reason = String(value || '').trim().toLowerCase();
    return USER_FEEDBACK_REASON_CODES.has(reason) ? reason : 'other';
}

function normalizeReviewStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return ['accepted', 'rejected'].includes(status) ? status : '';
}

async function recordUserDecisionFeedback(value = {}, deps = {}) {
    const decisionId = safeText(value.decisionId, 128);
    const correctedActionId = normalizeActionId(value.correctedActionId || value.verifiedActionId);
    const userId = Number.parseInt(value.userId, 10);
    const sessionId = safeText(value.sessionId, 128);
    if (!decisionId || !correctedActionId || !Number.isSafeInteger(userId) || userId <= 0 || !sessionId) return null;
    const row = await (deps.queryOne || queryOne)(OWNED_DECISION_SQL, [decisionId]);
    if (!row || Number(row.user_id) !== userId || String(row.session_id || '') !== sessionId
        || normalizeActionId(row.selected_action_id) === correctedActionId
        || !candidateAllowsVerifiedAction(row.candidate_actions, correctedActionId)) return null;
    const outcome = serializeOutcome({
        decisionId,
        eventType: 'feedback',
        source: 'user',
        // 原路由仅以持久化决策记录为准，不能信任浏览器传参以免污染核验上下文。
        status: 'partial',
        selectedActionId: row.selected_action_id,
        verifiedActionId: correctedActionId,
        reasonCode: `user_action_correction.${normalizeFeedbackReason(value.reason)}`,
        resultReference: sessionId,
        metadata: {
            feedbackReason: normalizeFeedbackReason(value.reason),
            note: safeText(value.note, 500)
        }
    });
    if (!outcome) return null;
    if (deps.persist === false) return { ...outcome, reviewStatus: 'pending' };

    // 用户提交属于可审核操作，需同步落库；同一决策只保留一条待核验建议，避免重试产生矛盾标签。
    const persisted = await (deps.queryOne || queryOne)(UPSERT_USER_FEEDBACK_SQL, outcomeSqlParams(outcome, 'pending'));
    return {
        ...outcome,
        id: safeText(persisted?.id, 128) || outcome.id,
        reviewStatus: safeText(persisted?.review_status, 24) || 'pending'
    };
}

async function listUserDecisionFeedback({ reviewStatus = 'pending', limit = 50 } = {}, deps = {}) {
    const status = ['pending', 'accepted', 'rejected', 'superseded'].includes(String(reviewStatus || '').trim().toLowerCase())
        ? String(reviewStatus).trim().toLowerCase()
        : 'pending';
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
    return await (deps.query || query)(LIST_USER_FEEDBACK_SQL, [status, safeLimit]);
}

async function listUserDecisionFeedbackStatuses({ userId, sessionId } = {}, deps = {}) {
    const safeUserId = Number.parseInt(userId, 10);
    const safeSessionId = safeText(sessionId, 128);
    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0 || !safeSessionId) return [];
    return await (deps.query || query)(USER_SESSION_FEEDBACK_STATUS_SQL, [safeUserId, safeSessionId]);
}

async function reviewUserDecisionFeedback(value = {}, deps = {}) {
    const feedbackId = safeText(value.feedbackId, 128);
    const reviewerId = Number.parseInt(value.reviewerId, 10);
    const reviewStatus = normalizeReviewStatus(value.reviewStatus);
    const reviewNote = safeText(value.reviewNote, 500);
    if (!feedbackId || !Number.isSafeInteger(reviewerId) || reviewerId <= 0 || !reviewStatus) return null;

    const transactionFn = deps.transaction || transaction;
    return await transactionFn(async trx => {
        const feedback = await trx.queryOne(PENDING_USER_FEEDBACK_SQL, [feedbackId]);
        if (!feedback || (reviewStatus === 'accepted' && !candidateAllowsVerifiedAction(feedback.candidate_actions, feedback.corrected_action_id))) return null;

        const reviewedAt = getBeijingTimestamp();
        const reviewed = await trx.queryOne(REVIEW_USER_FEEDBACK_SQL, [reviewStatus, reviewerId, reviewedAt, reviewNote, feedbackId]);
        if (!reviewed) return null;

        let verification = null;
        if (reviewStatus === 'accepted') {
            verification = serializeOutcome({
                decisionId: feedback.decision_id,
                eventType: 'verification',
                source: 'admin',
                status: 'partial',
                selectedActionId: feedback.selected_action_id,
                verifiedActionId: feedback.corrected_action_id,
                reasonCode: 'accepted_user_route_feedback',
                resultReference: feedbackId,
                metadata: { feedbackId }
            });
            if (!verification) return null;
            await trx.execute(INSERT_OUTCOME_SQL, outcomeSqlParams(verification));
        }

        return {
            feedbackId: reviewed.id,
            decisionId: reviewed.decision_id,
            reviewStatus: reviewed.review_status,
            reviewedAt: reviewed.reviewed_at,
            verification
        };
    });
}

async function recordVerifiedDecisionOutcome(value = {}, deps = {}) {
    const decisionId = safeText(value.decisionId, 128);
    const verifiedActionId = normalizeActionId(value.verifiedActionId);
    if (!decisionId || !verifiedActionId) return null;
    const row = await (deps.queryOne || queryOne)(GET_DECISION_RECORD_SQL, [decisionId]);
    if (!row || !candidateAllowsVerifiedAction(row.candidate_actions, verifiedActionId)) return null;
    return recordDecisionOutcome({
        ...value,
        decisionId,
        verifiedActionId,
        eventType: 'verification',
        source: ['admin', 'system'].includes(String(value.source || '').toLowerCase()) ? String(value.source).toLowerCase() : 'admin'
    }, { persist: deps.persist !== false });
}

async function flushPendingDecisionObservability(deps = {}) {
    if (flushInFlight) return await flushInFlight;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    const decisions = Array.from(pendingDecisions.values());
    const outcomes = pendingOutcomes.splice(0, pendingOutcomes.length);
    pendingDecisions.clear();
    if (!decisions.length && !outcomes.length) return { decisions: 0, outcomes: 0 };
    const executeFn = deps.execute || execute;
    const work = (async () => {
        let decisionCount = 0;
        let outcomeCount = 0;
        for (const item of decisions) {
            try {
                await executeFn(UPSERT_DECISION_SQL, [item.decisionId, item.scenario, item.tenantId, item.userId, item.sessionId, JSON.stringify(item.requestState), JSON.stringify(item.candidates), JSON.stringify(item.providerOutputs), JSON.stringify(item.policy), item.selectedActionId, item.createdAt, item.updatedAt]);
                decisionCount += 1;
            } catch (error) {
                pendingDecisions.set(item.decisionId, item);
                logger.warn({ err: error.message, decisionId: item.decisionId }, '决策记录持久化失败，已保留待重试');
            }
        }
        for (const item of outcomes) {
            try {
                await executeFn(INSERT_OUTCOME_SQL, outcomeSqlParams(item));
                outcomeCount += 1;
            } catch (error) {
                if (pendingOutcomes.length < MAX_PENDING) pendingOutcomes.push(item);
                logger.warn({ err: error.message, decisionId: item.decisionId }, '决策结果持久化失败，已保留待重试');
            }
        }
        return { decisions: decisionCount, outcomes: outcomeCount };
    })();
    flushInFlight = work;
    try { return await work; }
    finally {
        flushInFlight = null;
        scheduleFlush();
    }
}

async function listVerifiedDecisionSamples({ scenario = '', tenantId = null, limit = 1000 } = {}, deps = {}) {
    const queryFn = deps.query || query;
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 10000));
    const params = [];
    const filters = ['o.is_verified = TRUE'];
    if (safeText(scenario, 80)) {
        filters.push('d.scenario = ?');
        params.push(safeText(scenario, 80));
    }
    const safeTenantId = Number.parseInt(tenantId, 10);
    if (Number.isSafeInteger(safeTenantId) && safeTenantId > 0) {
        filters.push('d.tenant_id = ?');
        params.push(safeTenantId);
    }
    params.push(safeLimit);
    return await queryFn([
        'SELECT d.decision_id, d.scenario, d.request_state, d.candidate_actions, d.provider_outputs, d.policy_outcome, d.selected_action_id, d.created_at,',
        'o.verified_action_id, o.status AS outcome_status, o.source AS verification_source, o.occurred_at AS verified_at',
        'FROM decision_records d JOIN decision_outcomes o ON o.decision_id = d.decision_id LEFT JOIN users u ON u.id = d.user_id',
        'WHERE ' + filters.join(' AND ') + " AND d.user_id IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.status, 'active') <> 'disabled'",
        'ORDER BY o.occurred_at ASC, o.id ASC LIMIT ?'
    ].join(' '), params);
}

const DECISION_OPERATIONAL_SUMMARY_SQL = [
    "SELECT scenario, COUNT(*) AS decisions,",
    "COUNT(*) FILTER (WHERE policy_outcome->>'mode' = 'shadow') AS shadow_decisions,",
    "COUNT(*) FILTER (WHERE policy_outcome->>'applied' = 'true') AS applied_decisions,",
    "AVG(COALESCE((policy_outcome->>'confidence')::double precision, 0)) AS mean_confidence",
    "FROM decision_records WHERE created_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 minute') GROUP BY scenario ORDER BY scenario"
].join(' ');
const DECISION_PROVIDER_SUMMARY_SQL = [
    "SELECT provider.value->>'providerId' AS provider_id, provider.value->>'providerVersion' AS provider_version,",
    "COUNT(*) AS calls, COUNT(*) FILTER (WHERE COALESCE(provider.value->>'error', '') <> '') AS errors,",
    "AVG(COALESCE((provider.value->>'durationMs')::double precision, 0)) AS mean_duration_ms,",
    "percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE((provider.value->>'durationMs')::double precision, 0)) AS p50_duration_ms,",
    "percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE((provider.value->>'durationMs')::double precision, 0)) AS p95_duration_ms",
    "FROM decision_records d CROSS JOIN LATERAL jsonb_array_elements(d.provider_outputs) provider(value)",
    "WHERE d.created_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 minute')",
    "GROUP BY provider.value->>'providerId', provider.value->>'providerVersion' ORDER BY provider_id, provider_version"
].join(' ');
const DECISION_OUTCOME_SUMMARY_SQL = [
    "SELECT d.scenario, o.status, COUNT(*) AS count FROM decision_outcomes o JOIN decision_records d ON d.decision_id = o.decision_id",
    "WHERE o.occurred_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 minute') GROUP BY d.scenario, o.status ORDER BY d.scenario, o.status"
].join(' ');

async function getDecisionOperationalMetrics({ minutes = 1440 } = {}, deps = {}) {
    const queryFn = deps.query || query;
    const safeMinutes = Math.max(5, Math.min(Number.parseInt(minutes, 10) || 1440, 10080));
    try {
        const [scenarios, providers, outcomes] = await Promise.all([
            queryFn(DECISION_OPERATIONAL_SUMMARY_SQL, [safeMinutes]),
            queryFn(DECISION_PROVIDER_SUMMARY_SQL, [safeMinutes]),
            queryFn(DECISION_OUTCOME_SUMMARY_SQL, [safeMinutes])
        ]);
        return { minutes: safeMinutes, scenarios: scenarios || [], providers: providers || [], outcomes: outcomes || [], unavailable: false };
    } catch (error) {
        return { minutes: safeMinutes, scenarios: [], providers: [], outcomes: [], unavailable: true, errorCode: String(error?.code || 'metrics_unavailable').slice(0, 80) };
    }
}

module.exports = {
    flushPendingDecisionObservability,
    getDecisionOperationalMetrics,
    listVerifiedDecisionSamples,
    listUserDecisionFeedback,
    listUserDecisionFeedbackStatuses,
    recordDecision,
    recordDecisionOutcome,
    recordUserDecisionFeedback,
    recordVerifiedDecisionOutcome,
    reviewUserDecisionFeedback,
    serializeOutcome
};
