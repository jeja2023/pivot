'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { normalizeActionId, sanitizeDecisionContext } = require('./decision-provider');

const DEFAULT_SET_PATH = path.resolve(__dirname, '../../docs/decision-evaluation-set.v2.json');
const SET_SQL = 'SELECT version, source_digest, source_metadata, imported_at FROM decision_evaluation_sets WHERE version = ?';
const CASE_SQL = 'SELECT * FROM decision_evaluation_cases WHERE set_version = ? AND case_id = ?';
const INSERT_SET_SQL = 'INSERT INTO decision_evaluation_sets (version, source_digest, source_metadata, imported_by, imported_at) VALUES (?, ?, ?::jsonb, ?, ?)';
const INSERT_CASE_SQL = [
    'INSERT INTO decision_evaluation_cases (set_version, case_id, case_digest, scenario, language, input_context, candidate_actions, review_status, expected_action_id, reviewed_by, reviewed_at, review_note, updated_at)',
    "VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, 'pending_human_review', '', NULL, NULL, '', ?)"
].join(' ');
const REVIEW_CASE_SQL = [
    "UPDATE decision_evaluation_cases SET review_status = 'verified', expected_action_id = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?",
    'WHERE set_version = ? AND case_id = ? RETURNING *'
].join(' ');
const INSERT_REVIEW_SQL = 'INSERT INTO decision_evaluation_reviews (id, set_version, case_id, expected_action_id, reviewer_id, review_note, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
const LIST_CASES_SQL = [
    'SELECT c.set_version, c.case_id, c.scenario, c.language, c.input_context, c.candidate_actions, c.review_status,',
    'c.expected_action_id, c.reviewed_by, c.reviewed_at, c.review_note, c.updated_at,',
    "COALESCE(NULLIF(u.deleted_username, ''), u.username) AS reviewed_by_username",
    'FROM decision_evaluation_cases c LEFT JOIN users u ON u.id = c.reviewed_by',
    'WHERE c.set_version = ? ORDER BY c.case_id ASC LIMIT ?'
].join(' ');
const REVIEW_STATUS_SQL = [
    'SELECT set_version, COUNT(*) AS total,',
    "COUNT(*) FILTER (WHERE review_status = 'verified') AS verified,",
    "COUNT(*) FILTER (WHERE review_status <> 'verified') AS pending,",
    'MAX(updated_at) AS updated_at FROM decision_evaluation_cases WHERE set_version = ? GROUP BY set_version'
].join(' ');

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function loadFrozenDecisionEvaluationSet(options = {}) {
    const source = options.source || JSON.parse(fs.readFileSync(options.path || DEFAULT_SET_PATH, 'utf8'));
    if (source?.schemaVersion !== 1 || source?.kind !== 'pivot_decision_evaluation_set' || !Array.isArray(source?.cases)) {
        throw new Error('invalid_decision_evaluation_set');
    }
    const version = String(source.version || '').trim().slice(0, 128);
    if (!version) throw new Error('invalid_decision_evaluation_set_version');
    return source;
}

function buildEvaluationCase(value = {}) {
    const id = String(value?.id || '').trim().slice(0, 128);
    const rawTaskState = value?.taskState && typeof value.taskState === 'object' ? value.taskState : {};
    const routingText = String(value?.providerInput?.routingText || '').trim().slice(0, 512);
    const context = sanitizeDecisionContext({
        decisionId: id,
        scenario: value?.scenario,
        language: value?.language,
        taskState: {
            ...rawTaskState,
            toolIntent: { requestedCapabilities: rawTaskState.requestedCapabilities || rawTaskState.toolIntent?.requestedCapabilities || [] }
        },
        candidates: value?.candidates
    });
    const allowed = new Set(context.candidates.filter(candidate => candidate.allowed).map(candidate => candidate.id));
    if (!id || context.scenario === 'unknown' || allowed.size < 2 || !routingText) throw new Error('invalid_decision_evaluation_case:' + id);
    const inputContext = { ...context, requestState: { ...context.requestState, routingText } };
    const digest = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({ id, inputContext })).digest('hex');
    return { id, scenario: context.scenario, language: context.language, inputContext, candidates: context.candidates, digest };
}

function sourceDigest(source) {
    const body = { schemaVersion: source.schemaVersion, kind: source.kind, version: source.version, cases: source.cases };
    return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

async function importFrozenDecisionEvaluationSet({ userId = null, source = null } = {}, deps = {}) {
    const evaluationSet = loadFrozenDecisionEvaluationSet({ source });
    const cases = evaluationSet.cases.map(buildEvaluationCase);
    const digest = sourceDigest(evaluationSet);
    const now = getBeijingTimestamp();
    const transactionFn = deps.transaction || transaction;
    const result = await transactionFn(async trx => {
        const existing = await trx.queryOne(SET_SQL, [evaluationSet.version]);
        if (existing && String(existing.source_digest || '') !== digest) throw new Error('decision_evaluation_set_digest_mismatch');
        if (!existing) {
            await trx.execute(INSERT_SET_SQL, [
                evaluationSet.version, digest,
                JSON.stringify({ schemaVersion: evaluationSet.schemaVersion, kind: evaluationSet.kind, caseCount: cases.length }),
                Number.isSafeInteger(Number(userId)) ? Number(userId) : null, now
            ]);
        }
        let inserted = 0;
        for (const item of cases) {
            const current = await trx.queryOne(CASE_SQL, [evaluationSet.version, item.id]);
            if (current && String(current.case_digest || '') !== item.digest) throw new Error('decision_evaluation_case_digest_mismatch:' + item.id);
            if (!current) {
                await trx.execute(INSERT_CASE_SQL, [
                    evaluationSet.version, item.id, item.digest, item.scenario, item.language,
                    JSON.stringify(item.inputContext), JSON.stringify(item.candidates), now
                ]);
                inserted += 1;
            }
        }
        return { version: evaluationSet.version, sourceDigest: digest, caseCount: cases.length, inserted, alreadyImported: Boolean(existing) };
    });
    return result;
}

async function listDecisionEvaluationCases({ version = '', limit = 100 } = {}, deps = {}) {
    const setVersion = String(version || '').trim().slice(0, 128);
    if (!setVersion) return [];
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
    const rows = await (deps.query || query)(LIST_CASES_SQL, [setVersion, safeLimit]);
    return rows.map(row => ({
        version: row.set_version,
        caseId: row.case_id,
        scenario: row.scenario,
        language: row.language,
        inputContext: parseJson(row.input_context, {}),
        candidates: parseJson(row.candidate_actions, []),
        reviewStatus: row.review_status,
        expectedActionId: row.expected_action_id || '',
        reviewedBy: row.reviewed_by ? Number(row.reviewed_by) : null,
        reviewedByUsername: row.reviewed_by_username || '',
        reviewedAt: row.reviewed_at || null,
        reviewNote: row.review_note || '',
        updatedAt: row.updated_at || null
    }));
}

async function getDecisionEvaluationReviewStatus(version, deps = {}) {
    const setVersion = String(version || '').trim().slice(0, 128);
    if (!setVersion) return null;
    const rows = await (deps.query || query)(REVIEW_STATUS_SQL, [setVersion]);
    const row = rows?.[0];
    if (!row) return null;
    return { version: row.set_version, total: Number(row.total || 0), verified: Number(row.verified || 0), pending: Number(row.pending || 0), updatedAt: row.updated_at || null };
}

async function getDecisionEvaluationSetGovernance(version, deps = {}) {
    const setVersion = String(version || '').trim().slice(0, 128);
    if (!setVersion) return null;
    const [status, evaluationSet] = await Promise.all([
        getDecisionEvaluationReviewStatus(setVersion, deps),
        (deps.queryOne || queryOne)(SET_SQL, [setVersion])
    ]);
    if (!status || !evaluationSet) return null;
    return {
        ...status,
        sourceDigest: String(evaluationSet.source_digest || ''),
        importedAt: evaluationSet.imported_at || null
    };
}

async function loadReviewedDecisionEvaluationCases(version, deps = {}) {
    const setVersion = String(version || '').trim().slice(0, 128);
    const status = await getDecisionEvaluationReviewStatus(setVersion, deps);
    if (!status || Number(status.total || 0) === 0 || Number(status.pending || 0) > 0 || Number(status.verified || 0) !== Number(status.total || 0)) {
        throw new Error('decision_evaluation_set_not_fully_reviewed');
    }
    const rows = await listDecisionEvaluationCases({ version: setVersion, limit: 500 }, deps);
    if (rows.length !== Number(status.total)) throw new Error('decision_evaluation_set_case_count_mismatch');
    return rows.map(row => {
        const context = row.inputContext || {};
        const requestState = context.requestState || {};
        return {
            id: row.caseId,
            reviewStatus: 'verified',
            expectedActionId: row.expectedActionId,
            reviewedBy: row.reviewedByUsername || String(row.reviewedBy || ''),
            reviewedAt: row.reviewedAt,
            scenario: row.scenario,
            language: row.language,
            taskState: {
                hash: requestState.taskHash || '',
                status: requestState.status || 'active',
                evidenceNeeds: requestState.evidenceNeeds || [],
                constraints: Array.from({ length: Math.max(0, Number(requestState.constraintCount) || 0) }, () => 'present'),
                entities: Array.from({ length: Math.max(0, Number(requestState.entityCount) || 0) }, () => 'present'),
                toolIntent: { requestedCapabilities: requestState.requestedCapabilities || [] }
            },
            candidates: row.candidates,
            providerInput: { routingText: String(requestState.routingText || '') }
        };
    });
}

async function reviewDecisionEvaluationCase({ version = '', caseId = '', expectedActionId = '', reviewNote = '', reviewerId = null } = {}, deps = {}) {
    const setVersion = String(version || '').trim().slice(0, 128);
    const safeCaseId = String(caseId || '').trim().slice(0, 128);
    const actionId = normalizeActionId(expectedActionId);
    const safeReviewerId = Number.parseInt(reviewerId, 10);
    if (!setVersion || !safeCaseId || !actionId || !Number.isSafeInteger(safeReviewerId) || safeReviewerId <= 0) throw new Error('invalid_decision_evaluation_review');
    const transactionFn = deps.transaction || transaction;
    return await transactionFn(async trx => {
        const current = await trx.queryOne(CASE_SQL + ' FOR UPDATE', [setVersion, safeCaseId]);
        if (!current) return null;
        const candidates = parseJson(current.candidate_actions, []);
        const allowed = new Set(candidates.filter(candidate => candidate?.allowed !== false).map(candidate => normalizeActionId(candidate?.id)));
        if (!allowed.has(actionId)) throw new Error('decision_evaluation_action_not_allowed');
        const now = getBeijingTimestamp();
        const note = String(reviewNote || '').trim().slice(0, 2000);
        const updated = await trx.queryOne(REVIEW_CASE_SQL, [actionId, safeReviewerId, now, note, now, setVersion, safeCaseId]);
        await trx.execute(INSERT_REVIEW_SQL, ['evaluation_review_' + crypto.randomUUID(), setVersion, safeCaseId, actionId, safeReviewerId, note, now]);
        return updated ? { version: setVersion, caseId: safeCaseId, expectedActionId: actionId, reviewedBy: safeReviewerId, reviewedAt: now, reviewNote: note } : null;
    });
}

module.exports = {
    getDecisionEvaluationReviewStatus,
    getDecisionEvaluationSetGovernance,
    importFrozenDecisionEvaluationSet,
    listDecisionEvaluationCases,
    loadFrozenDecisionEvaluationSet,
    loadReviewedDecisionEvaluationCases,
    reviewDecisionEvaluationCase,
    sourceDigest
};
