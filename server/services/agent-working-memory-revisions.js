'use strict';

const crypto = require('crypto');
const { transaction, query } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { normalizeTaskWorkingState } = require('./agent-working-state');
const { parseCasRef } = require('./agent-artifact-cas');

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function stateHash(state) {
    // updatedAt 是写入时间，不是任务事实；纳入摘要会令相同状态每次重试都生成新版本。
    const source = state && typeof state === 'object' && !Array.isArray(state) ? { ...state } : state;
    if (source && typeof source === 'object' && !Array.isArray(source)) delete source.updatedAt;
    return crypto.createHash('sha256').update(stableJson(source || {})).digest('hex');
}

function activeIds(items = []) {
    return new Set((Array.isArray(items) ? items : [])
        .filter(item => item && String(item.status || 'active') !== 'completed')
        .map(item => String(item.id || item.text || '').trim()).filter(Boolean));
}

function calculateWorkingMemoryRetention(previous = null, current = {}) {
    const prior = previous && typeof previous === 'object' ? previous : {};
    const currentState = current && typeof current === 'object' ? current : {};
    const previousConstraints = activeIds(prior.constraints);
    const currentConstraints = activeIds(currentState.constraints);
    const previousPending = activeIds(prior.pendingWork);
    const currentPending = activeIds(currentState.pendingWork);
    const missingConstraints = [...previousConstraints].filter(id => !currentConstraints.has(id));
    const missingPendingWork = [...previousPending].filter(id => !currentPending.has(id));
    const expected = previousConstraints.size + previousPending.size;
    const retained = expected - missingConstraints.length - missingPendingWork.length;
    return {
        expectedItems: expected,
        retainedItems: Math.max(retained, 0),
        retentionRate: expected ? Math.max(retained, 0) / expected : 1,
        missingConstraintIds: missingConstraints.slice(0, 32),
        missingPendingWorkIds: missingPendingWork.slice(0, 32),
        blockingLoss: missingConstraints.length > 0 || missingPendingWork.length > 0
    };
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function stateArtifactReferences(state = {}) {
    return [...new Set((Array.isArray(state?.evidence) ? state.evidence : [])
        .map(item => parseCasRef(item?.rawOutputRef || item?.raw_output_ref || ''))
        .filter(Boolean))];
}

function serializeRevision(row = {}) {
    return {
        id: String(row.id || ''), runId: String(row.run_id || ''), userId: Number(row.user_id || 0), revision: Number(row.revision || 0),
        reason: String(row.reason || ''), state: parseJson(row.state, {}), stateHash: String(row.state_hash || ''),
        parentStateHash: String(row.parent_state_hash || ''), retention: parseJson(row.retention, {}), createdAt: row.created_at || null
    };
}

async function persistWorkingMemoryRevision({ run = {}, user = {}, state = {}, reason = 'observation', taskContract = null, now = null } = {}, deps = {}) {
    const runId = String(run.id || '').trim();
    const userId = Number(user.id || run.user_id || 0);
    if (!runId || !userId) return null;
    const runTransaction = deps.transaction || transaction;
    const timestamp = now || getBeijingTimestamp();
    const normalized = normalizeTaskWorkingState(state, taskContract || {}, run.goal || '');
    const hash = stateHash(normalized);
    return await runTransaction(async trx => {
        const owned = await trx.queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? FOR UPDATE', [runId, userId]);
        if (!owned) return null;
        const previous = await trx.queryOne(`
            SELECT revision, state, state_hash FROM agent_working_memory_revisions
            WHERE run_id = ? AND user_id = ? ORDER BY revision DESC LIMIT 1 FOR UPDATE
        `, [runId, userId]);
        // 普通重试不制造噪声；而 context_compacted 是一个需要解释压缩保真度的
        // 生命周期边界，即使摘要正文未变也必须留下独立审计修订。
        if (previous?.state_hash === hash && String(reason || '') !== 'context_compacted') {
            return { ...serializeRevision(previous), deduped: true };
        }
        const priorState = parseJson(previous?.state, null);
        const retention = calculateWorkingMemoryRetention(priorState, normalized);
        const revision = Number(previous?.revision || 0) + 1;
        const row = await trx.queryOne(`
            INSERT INTO agent_working_memory_revisions (
                run_id, user_id, revision, reason, state, state_hash, parent_state_hash, retention, created_at
            ) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?)
            RETURNING *
        `, [runId, userId, revision, String(reason || 'observation').slice(0, 48), JSON.stringify(normalized), hash, previous?.state_hash || '', JSON.stringify(retention), timestamp]);
        for (const objectId of stateArtifactReferences(normalized)) {
            const retained = await trx.queryOne(`
                UPDATE agent_artifact_objects
                SET ref_count = ref_count + 1
                WHERE id = ? AND owner_user_id = ?
                RETURNING id
            `, [objectId, userId]);
            if (!retained) throw new Error('Working Memory 原文引用不存在或无权保留。');
        }
        return serializeRevision(row);
    });
}

async function listWorkingMemoryRevisionsForUser(runId, user, { limit = 100 } = {}) {
    const userId = Number(user?.id || 0);
    if (!runId || !userId) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = await query(`
        SELECT * FROM agent_working_memory_revisions
        WHERE run_id = ? AND user_id = ? ORDER BY revision DESC LIMIT ?
    `, [String(runId), userId, safeLimit]);
    return rows.map(serializeRevision);
}

module.exports = {

    listWorkingMemoryRevisionsForUser,
    persistWorkingMemoryRevision,

    stateArtifactReferences,
    stateHash
};
