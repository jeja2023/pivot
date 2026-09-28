'use strict';

const crypto = require('crypto');
const { sanitizeDecisionContext, normalizeActionId } = require('./decision-provider');
const { splitDecisionDatasetByTime } = require('./decision-learning');

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function toTaskState(requestState = {}) {
    const source = requestState && typeof requestState === 'object' ? requestState : {};
    return {
        hash: String(source.taskHash || ''),
        status: String(source.status || 'active'),
        evidenceNeeds: Array.isArray(source.evidenceNeeds) ? source.evidenceNeeds : [],
        constraints: Array.from({ length: Math.max(0, Math.min(Number(source.constraintCount) || 0, 32)) }, () => 'present'),
        entities: Array.from({ length: Math.max(0, Math.min(Number(source.entityCount) || 0, 32)) }, () => 'present'),
        toolIntent: { requestedCapabilities: Array.isArray(source.requestedCapabilities) ? source.requestedCapabilities : [] }
    };
}

function toLayaDatasetRecord(row = {}) {
    const verifiedActionId = normalizeActionId(row.verified_action_id);
    const context = sanitizeDecisionContext({
        decisionId: String(row.decision_id || ''),
        scenario: row.scenario,
        taskState: toTaskState(parseJson(row.request_state, {})),
        candidates: parseJson(row.candidate_actions, [])
    });
    const allowed = new Set(context.candidates.filter(candidate => candidate.allowed).map(candidate => candidate.id));
    if (!context.decisionId || !verifiedActionId || !allowed.has(verifiedActionId)) return null;
    return {
        id: context.decisionId,
        occurredAt: row.verified_at || row.created_at || null,
        input: context,
        target: { selectedActionId: verifiedActionId }
    };
}

function buildLayaDecisionDataset(rows = [], options = {}) {
    const records = (Array.isArray(rows) ? rows : []).map(toLayaDatasetRecord).filter(Boolean)
        .sort((left, right) => String(left.occurredAt || '').localeCompare(String(right.occurredAt || '')) || left.id.localeCompare(right.id));
    const split = splitDecisionDatasetByTime({ samples: records }, options.split);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(records.map(record => ({ id: record.id, target: record.target, occurredAt: record.occurredAt })))).digest('hex');
    const serialize = values => values.map(({ id, input, target }) => JSON.stringify({ id, input, target })).join('\n') + (values.length ? '\n' : '');
    return {
        dataVersion: 'laya-decision-data-' + fingerprint.slice(0, 16),
        createdAt: new Date().toISOString(),
        records: records.length,
        splitPolicy: split.splitPolicy,
        manifest: {
            schemaVersion: 1,
            dataVersion: 'laya-decision-data-' + fingerprint.slice(0, 16),
            recordCount: records.length,
            splits: { train: split.train.length, calibration: split.calibration.length, test: split.test.length },
            leakage: split.leakage,
            rawUserTextIncluded: false,
            source: 'verified_decision_outcomes'
        },
        files: { train: serialize(split.train), calibration: serialize(split.calibration), test: serialize(split.test) }
    };
}

module.exports = { buildLayaDecisionDataset };
