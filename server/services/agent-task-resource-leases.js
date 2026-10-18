'use strict';

/* 为 Task Transaction 的副作用资源提供跨实例独占租约。 */
const crypto = require('crypto');
const { execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { transactionError } = require('./agent-task-transaction');

const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const MAX_LEASE_MS = 4 * 60 * 60 * 1000;

function normalizeResourceKeys(value = []) {
    return [...new Set((Array.isArray(value) ? value : [])
        .map(item => String(item || '').trim().slice(0, 255)).filter(Boolean))].sort();
}

function leaseMs(value, env = process.env) {
    const configured = Number(value ?? env.PIVOT_AGENT_TASK_RESOURCE_LEASE_MS);
    const base = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LEASE_MS;
    return Math.min(Math.max(base, 60_000), MAX_LEASE_MS);
}

function serializeLease(row = {}) {
    return {
        id: String(row.id || ''), transactionId: String(row.transaction_id || ''), effectId: String(row.effect_id || ''), runId: String(row.run_id || ''),
        resourceKey: String(row.resource_key || ''), leaseToken: String(row.lease_token || ''), mode: String(row.mode || 'exclusive'),
        expiresAt: row.lease_expires_at || null, releasedAt: row.released_at || null, createdAt: row.created_at || null, updatedAt: row.updated_at || null
    };
}

function serializeResourceConflict(row = {}) {
    return {
        id: String(row.id || ''), resourceKey: String(row.resource_key || ''), status: String(row.status || 'open'),
        requesterTransactionId: String(row.requester_transaction_id || ''), requesterRunId: String(row.requester_run_id || ''),
        holderTransactionId: String(row.holder_transaction_id || ''), holderEffectId: String(row.holder_effect_id || ''),
        holderRunId: String(row.holder_run_id || ''), observedLeaseExpiresAt: row.observed_lease_expires_at || null,
        createdAt: row.created_at || null, resolvedAt: row.resolved_at || null
    };
}

async function recordTaskResourceConflict(input = {}, executeQuery = execute) {
    const conflict = input && typeof input === 'object' ? input : {};
    if (!conflict.resourceKey || !conflict.requesterTransactionId || !conflict.requesterRunId || !conflict.holderTransactionId || !conflict.holderEffectId || !conflict.holderRunId) return null;
    const rows = await executeQuery(`
        INSERT INTO agent_task_resource_conflicts (
            resource_key, requester_transaction_id, requester_run_id, holder_transaction_id,
            holder_effect_id, holder_run_id, observed_lease_expires_at, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `, [
        String(conflict.resourceKey), String(conflict.requesterTransactionId), String(conflict.requesterRunId),
        String(conflict.holderTransactionId), String(conflict.holderEffectId), String(conflict.holderRunId),
        conflict.observedLeaseExpiresAt || null, conflict.now || getBeijingTimestamp()
    ]);
    return rows;
}

async function lockResourceKeys(trx, keys) {
    for (const key of normalizeResourceKeys(keys)) {
        await trx.queryOne('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`task-resource:${key}`]);
    }
}

async function findUnresolvedResourceOwner(trx, resourceKey, transactionId) {
    return await trx.queryOne(`
        SELECT e.transaction_id, e.id AS effect_id, e.run_id, l.lease_expires_at, e.status AS effect_status
        FROM agent_task_effects e
        JOIN agent_task_transactions t ON t.id = e.transaction_id
        LEFT JOIN agent_task_resource_leases l ON l.effect_id = e.id AND l.resource_key = ?
        WHERE e.transaction_id <> ? AND e.resource_keys @> ?::jsonb
          AND (
              e.status IN ('executing', 'failed', 'compensation_pending')
              OR (e.status = 'committed' AND t.status IN ('awaiting_commit', 'compensating'))
              OR (e.commit_mode = 'preview' AND e.status = 'staged' AND t.status NOT IN ('committed', 'rolled_back', 'cancelled'))
          )
        ORDER BY e.updated_at DESC LIMIT 1
    `, [resourceKey, transactionId, JSON.stringify([resourceKey])]);
}

function leaseConflict(resourceKey, input, owner, now, unresolved = false) {
    const message = unresolved
        ? `资源 ${resourceKey} 关联的副作用尚未安全完成或结果待核实，不能因租约到期而重新占用。`
        : `资源 ${resourceKey} 正由另一项任务事务占用。`;
    const error = transactionError(message, 'AGENT_RESOURCE_LEASE_CONFLICT', 409);
    error.resourceConflict = {
        resourceKey, requesterTransactionId: String(input.transactionId || ''), requesterRunId: String(input.runId || ''),
        holderTransactionId: String(owner.transaction_id || ''), holderEffectId: String(owner.effect_id || ''), holderRunId: String(owner.run_id || ''),
        observedLeaseExpiresAt: owner.lease_expires_at || null, now
    };
    return error;
}

async function acquireTaskResourceLeases(trx, input = {}) {
    const keys = normalizeResourceKeys(input.resourceKeys);
    if (!keys.length) return [];
    const now = input.now || getBeijingTimestamp();
    const expiresAt = input.expiresAt || getBeijingTimestamp(new Date(Date.now() + leaseMs(input.leaseMs, input.env)));
    await lockResourceKeys(trx, keys);
    const acquired = [];
    for (const key of keys) {
        const unresolved = await findUnresolvedResourceOwner(trx, key, input.transactionId);
        if (unresolved) throw leaseConflict(key, input, unresolved, now, true);
        await trx.execute(`
            UPDATE agent_task_resource_leases SET released_at = ?, updated_at = ?
            WHERE resource_key = ? AND released_at IS NULL AND lease_expires_at <= ?
        `, [now, now, key, now]);
        const owner = await trx.queryOne(`
            SELECT transaction_id, effect_id, run_id, lease_expires_at FROM agent_task_resource_leases
            WHERE resource_key = ? AND released_at IS NULL AND lease_expires_at > ?
            ORDER BY created_at ASC LIMIT 1 FOR UPDATE
        `, [key, now]);
        if (owner && String(owner.transaction_id) !== String(input.transactionId)) {
            throw leaseConflict(key, input, owner, now);
        }
        const token = crypto.randomUUID();
        const row = await trx.queryOne(`
            INSERT INTO agent_task_resource_leases (
                transaction_id, effect_id, run_id, tenant_id, user_id, resource_key, lease_token, mode, lease_expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'exclusive', ?, ?, ?)
            ON CONFLICT (transaction_id, effect_id, resource_key) DO UPDATE SET
                lease_token = EXCLUDED.lease_token, lease_expires_at = EXCLUDED.lease_expires_at,
                released_at = NULL, updated_at = EXCLUDED.updated_at
            RETURNING *
        `, [input.transactionId, input.effectId, input.runId, Number(input.tenantId || 0), input.userId, key, token, expiresAt, now, now]);
        await trx.execute(`
            UPDATE agent_task_resource_conflicts
            SET status = 'resolved', resolved_at = ?
            WHERE requester_transaction_id = ? AND resource_key = ? AND status IN ('open', 'released')
        `, [now, String(input.transactionId), key]);
        acquired.push(serializeLease(row));
    }
    return acquired;
}

async function renewTaskResourceLeases(trx, input = {}) {
    const transactionId = String(input.transactionId || '');
    if (!transactionId) return [];
    const rows = await trx.query(`
        SELECT * FROM agent_task_resource_leases
        WHERE transaction_id = ? AND released_at IS NULL
        ORDER BY resource_key ASC
    `, [transactionId]);
    const keys = rows.map(row => row.resource_key);
    if (!keys.length) return [];
    const now = input.now || getBeijingTimestamp();
    const expiresAt = input.expiresAt || getBeijingTimestamp(new Date(Date.now() + leaseMs(input.leaseMs, input.env)));
    await lockResourceKeys(trx, keys);
    for (const key of keys) {
        const unresolved = await findUnresolvedResourceOwner(trx, key, transactionId);
        if (unresolved) throw transactionError(`资源 ${key} 存在未解决的副作用，租约不能续期。`, 'AGENT_RESOURCE_LEASE_LOST', 409);
        const conflict = await trx.queryOne(`
            SELECT transaction_id FROM agent_task_resource_leases
            WHERE resource_key = ? AND transaction_id <> ? AND released_at IS NULL AND lease_expires_at > ?
            ORDER BY created_at ASC LIMIT 1 FOR UPDATE
        `, [key, transactionId, now]);
        if (conflict) throw transactionError(`资源 ${key} 的租约已被其他事务取得。`, 'AGENT_RESOURCE_LEASE_LOST', 409);
    }
    const renewed = await trx.query(`
        UPDATE agent_task_resource_leases SET lease_expires_at = ?, updated_at = ?
        WHERE transaction_id = ? AND released_at IS NULL
        RETURNING *
    `, [expiresAt, now, transactionId]);
    return renewed.map(serializeLease);
}

async function releaseTaskResourceLeases(trx, transactionId, { now = getBeijingTimestamp() } = {}) {
    if (!transactionId) return 0;
    const released = await trx.execute(`
        UPDATE agent_task_resource_leases SET released_at = ?, updated_at = ?
        WHERE transaction_id = ? AND released_at IS NULL
    `, [now, now, String(transactionId)]);
    await trx.execute(`
        UPDATE agent_task_resource_conflicts
        SET status = 'released', resolved_at = ?
        WHERE holder_transaction_id = ? AND status = 'open'
    `, [now, String(transactionId)]);
    return released;
}

module.exports = {
    DEFAULT_LEASE_MS,
    acquireTaskResourceLeases,
    leaseMs,
    normalizeResourceKeys,
    recordTaskResourceConflict,
    releaseTaskResourceLeases,
    renewTaskResourceLeases,
    serializeLease,
    serializeResourceConflict
};
