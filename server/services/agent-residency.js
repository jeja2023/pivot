const crypto = require('crypto');
const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { hashValue } = require('./agent-step-context');
const { redactTraceValue } = require('./agent-traces');

const RESIDENT_STATUSES = new Set(['active', 'idle', 'evicted', 'stopped']);
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LEASE_MS = 60 * 1000;
const MAX_STATE_CHARS = 120000;

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(Math.floor(number), max);
}

function normalizeResidentKey(value) {
    const key = String(value || '').trim();
    if (!key) return '';
    return key.slice(0, 255);
}

function normalizeResidentState(value) {
    const safe = redactTraceValue(value && typeof value === 'object' ? value : {});
    let serialized = '{}';
    try { serialized = JSON.stringify(safe); } catch (_) { serialized = '{}'; }
    if (serialized.length <= MAX_STATE_CHARS) return { state: safe, serialized };
    const compact = {
        truncated: true,
        originalLength: serialized.length,
        preview: serialized.slice(0, MAX_STATE_CHARS - 160)
    };
    return { state: compact, serialized: JSON.stringify(compact) };
}

function normalizeResidencyRow(row) {
    if (!row) return null;
    let state = row.state;
    if (typeof state === 'string') {
        try { state = JSON.parse(state); } catch (_) { state = {}; }
    }
    return {
        ...row,
        resident_id: String(row.resident_id || ''),
        user_id: Number(row.user_id || 0),
        resident_key: String(row.resident_key || ''),
        run_id: row.run_id || null,
        status: RESIDENT_STATUSES.has(String(row.status || '')) ? String(row.status) : 'idle',
        state: state && typeof state === 'object' ? state : {},
        context_hash: String(row.context_hash || ''),
        hit_count: Number(row.hit_count || 0),
        lease_owner: String(row.lease_owner || ''),
        lease_expires_at: row.lease_expires_at || null,
        expires_at: row.expires_at || null
    };
}

function futureTimestamp(milliseconds) {
    return new Date(Date.now() + Math.max(Number(milliseconds) || 0, 0)).toISOString();
}

function residentIdFor(userId, residentKey) {
    return `resident_${Number(userId)}_${crypto.createHash('sha256').update(residentKey).digest('hex').slice(0, 32)}`;
}

function createAgentResidencyStore(options = {}) {
    const maxEntries = positiveInt(options.maxEntries ?? process.env.AGENT_RESIDENCY_MAX_ENTRIES, DEFAULT_MAX_ENTRIES, 1000);
    const idleTtlMs = positiveInt(options.idleTtlMs ?? process.env.AGENT_RESIDENCY_IDLE_TTL_MS, DEFAULT_IDLE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    const leaseMs = positiveInt(options.leaseMs ?? process.env.AGENT_RESIDENCY_LEASE_MS, DEFAULT_LEASE_MS, 24 * 60 * 60 * 1000);
    const now = options.now || (() => getBeijingTimestamp());

    async function evictOverflow(trx, userId, currentResidentId, timestamp) {
        const countRow = await trx.queryOne(`
            SELECT COUNT(*)::integer AS count
            FROM agent_residencies
            WHERE user_id = ? AND status IN ('active', 'idle')
        `, [userId]);
        const overflow = Math.max(Number(countRow?.count || 0) - maxEntries, 0);
        if (!overflow) return 0;
        const victims = await trx.query(`
            SELECT resident_id
            FROM agent_residencies
            WHERE user_id = ?
              AND resident_id != ?
              AND status IN ('active', 'idle')
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            ORDER BY last_accessed_at ASC, resident_id ASC
            LIMIT ?
            FOR UPDATE SKIP LOCKED
        `, [userId, currentResidentId, timestamp, overflow]);
        let changed = 0;
        for (const victim of victims) {
            changed += await trx.execute(`
                UPDATE agent_residencies
                SET status = 'evicted', lease_owner = '', lease_expires_at = NULL, updated_at = ?
                WHERE resident_id = ? AND user_id = ?
            `, [timestamp, victim.resident_id, userId]);
        }
        return changed;
    }

    async function touchResident({ user, userId = user?.id, residentKey, runId = null, state = {}, status = 'idle', idleTtlMs: requestedTtlMs } = {}) {
        const normalizedUserId = Number(userId || 0);
        const key = normalizeResidentKey(residentKey);
        if (!normalizedUserId || !key) return null;
        const safeStatus = RESIDENT_STATUSES.has(String(status)) && status !== 'evicted' && status !== 'stopped'
            ? String(status)
            : 'idle';
        const normalized = normalizeResidentState(state);
        const timestamp = now();
        const expiresAt = futureTimestamp(requestedTtlMs ?? idleTtlMs);
        const residentId = residentIdFor(normalizedUserId, key);
        const row = await transaction(async trx => {
            const updated = await trx.queryOne(`
                INSERT INTO agent_residencies (
                    resident_id, user_id, resident_key, run_id, status, state, context_hash,
                    last_accessed_at, expires_at, hit_count, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT (user_id, resident_key) DO UPDATE SET
                    run_id = COALESCE(EXCLUDED.run_id, agent_residencies.run_id),
                    status = EXCLUDED.status,
                    state = EXCLUDED.state,
                    context_hash = EXCLUDED.context_hash,
                    last_accessed_at = EXCLUDED.last_accessed_at,
                    expires_at = EXCLUDED.expires_at,
                    hit_count = agent_residencies.hit_count + 1,
                    updated_at = EXCLUDED.updated_at
                RETURNING *
            `, [residentId, normalizedUserId, key, runId || null, safeStatus, normalized.serialized, hashValue(normalized.state), timestamp, expiresAt, timestamp, timestamp]);
            await evictOverflow(trx, normalizedUserId, residentId, timestamp);
            return updated;
        });
        return normalizeResidencyRow(row);
    }

    async function getResident({ user, userId = user?.id, residentKey, touch = true } = {}) {
        const normalizedUserId = Number(userId || 0);
        const key = normalizeResidentKey(residentKey);
        if (!normalizedUserId || !key) return null;
        if (touch) {
            const row = await queryOne(`
                UPDATE agent_residencies
                SET last_accessed_at = ?, hit_count = hit_count + 1, updated_at = ?
                WHERE user_id = ? AND resident_key = ? AND status IN ('active', 'idle')
                  AND (expires_at IS NULL OR expires_at > ?)
                RETURNING *
            `, [now(), now(), normalizedUserId, key, now()]);
            return normalizeResidencyRow(row);
        }
        return normalizeResidencyRow(await queryOne(
            `SELECT * FROM agent_residencies WHERE user_id = ? AND resident_key = ?`,
            [normalizedUserId, key]
        ));
    }

    async function listResidents({ user, userId = user?.id, status = '', limit = 100 } = {}) {
        const normalizedUserId = Number(userId || 0);
        if (!normalizedUserId) return [];
        const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
        const params = [normalizedUserId];
        const clauses = ['user_id = ?'];
        if (RESIDENT_STATUSES.has(String(status || ''))) {
            clauses.push('status = ?');
            params.push(String(status));
        }
        params.push(safeLimit);
        const rows = await query(`
            SELECT * FROM agent_residencies
            WHERE ${clauses.join(' AND ')}
            ORDER BY last_accessed_at DESC, resident_id ASC
            LIMIT ?
        `, params);
        return rows.map(normalizeResidencyRow);
    }

    async function listAllResidents({ status = '', limit = 200 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
        const params = [];
        const clauses = [];
        if (RESIDENT_STATUSES.has(String(status || ''))) {
            clauses.push('r.status = ?');
            params.push(String(status));
        }
        params.push(safeLimit);
        const rows = await query(`
            SELECT r.*, u.username, u.nickname, u.unit
            FROM agent_residencies r
            LEFT JOIN users u ON u.id = r.user_id
            ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
            ORDER BY r.last_accessed_at DESC, r.resident_id ASC
            LIMIT ?
        `, params);
        return rows.map(normalizeResidencyRow);
    }

    async function evictResident({ user, userId = user?.id, residentKey, residentId = '' } = {}) {
        const normalizedUserId = Number(userId || 0);
        const key = normalizeResidentKey(residentKey);
        if (!normalizedUserId || (!key && !residentId)) return null;
        const row = await queryOne(`
            UPDATE agent_residencies
            SET status = 'evicted', lease_owner = '', lease_expires_at = NULL, updated_at = ?
            WHERE user_id = ? AND ${residentId ? 'resident_id = ?' : 'resident_key = ?'}
            RETURNING *
        `, [now(), normalizedUserId, residentId || key]);
        return normalizeResidencyRow(row);
    }

    async function evictResidentForAdmin({ residentId = '' } = {}) {
        const id = String(residentId || '').trim();
        if (!id) return null;
        const row = await queryOne(`
            UPDATE agent_residencies
            SET status = 'evicted', lease_owner = '', lease_expires_at = NULL, updated_at = ?
            WHERE resident_id = ?
            RETURNING *
        `, [now(), id]);
        return normalizeResidencyRow(row);
    }

    async function acquireResidentLease({ user, userId = user?.id, residentKey, leaseOwner, leaseMs: requestedLeaseMs } = {}) {
        const normalizedUserId = Number(userId || 0);
        const key = normalizeResidentKey(residentKey);
        const owner = String(leaseOwner || '').trim().slice(0, 128);
        if (!normalizedUserId || !key || !owner) return null;
        const timestamp = now();
        const expiry = futureTimestamp(requestedLeaseMs ?? leaseMs);
        const row = await transaction(async trx => {
            const current = await trx.queryOne(`
                SELECT * FROM agent_residencies
                WHERE user_id = ? AND resident_key = ?
                  AND status IN ('active', 'idle')
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                  AND (expires_at IS NULL OR expires_at > ?)
                FOR UPDATE
            `, [normalizedUserId, key, timestamp, timestamp]);
            if (!current) return null;
            return await trx.queryOne(`
                UPDATE agent_residencies
                SET status = 'active', lease_owner = ?, lease_expires_at = ?,
                    last_accessed_at = ?, updated_at = ?
                WHERE resident_id = ?
                RETURNING *
            `, [owner, expiry, timestamp, timestamp, current.resident_id]);
        });
        return normalizeResidencyRow(row);
    }

    async function releaseResidentLease({ user, userId = user?.id, residentKey, residentId = '', leaseOwner = '' } = {}) {
        const normalizedUserId = Number(userId || 0);
        const owner = String(leaseOwner || '').trim();
        if (!normalizedUserId || (!residentKey && !residentId)) return null;
        const clauses = [residentId ? 'resident_id = ?' : 'resident_key = ?'];
        const params = [now(), normalizedUserId, residentId || normalizeResidentKey(residentKey)];
        if (owner) {
            clauses.push('lease_owner = ?');
            params.push(owner);
        }
        const row = await queryOne(`
            UPDATE agent_residencies
            SET status = 'idle', lease_owner = '', lease_expires_at = NULL, updated_at = ?
            WHERE user_id = ? AND ${clauses.join(' AND ')}
            RETURNING *
        `, params);
        return normalizeResidencyRow(row);
    }

    async function sweepResidents({ userId = null } = {}) {
        const timestamp = now();
        const params = [timestamp, timestamp, timestamp];
        const clauses = [
            `status IN ('active', 'idle')`,
            'expires_at IS NOT NULL AND expires_at <= ?',
            '(lease_expires_at IS NULL OR lease_expires_at <= ?)'
        ];
        if (userId) {
            clauses.push('user_id = ?');
            params.push(Number(userId));
        }
        return await queryOne(`
            WITH expired AS (
                UPDATE agent_residencies
                SET status = 'evicted', lease_owner = '', lease_expires_at = NULL, updated_at = ?
                WHERE ${clauses.join(' AND ')}
                RETURNING resident_id
            ) SELECT COUNT(*)::integer AS count FROM expired
        `, params).then(row => Number(row?.count || 0));
    }

    return {
        acquireResidentLease,
        evictResident,
        evictResidentForAdmin,
        getResident,
        listAllResidents,
        listResidents,
        releaseResidentLease,
        sweepResidents,
        touchResident,
        config: { maxEntries, idleTtlMs, leaseMs }
    };
}

module.exports = {
    DEFAULT_IDLE_TTL_MS,
    DEFAULT_LEASE_MS,
    DEFAULT_MAX_ENTRIES,
    RESIDENT_STATUSES,
    createAgentResidencyStore,
    normalizeResidentKey,
    normalizeResidentState,
    normalizeResidencyRow,
    residentIdFor
};
