'use strict';

const crypto = require('crypto');
const { transaction } = require('../db/client');

const DEFAULT_BROWSER_LEASE_MS = 60000;
const MAX_BROWSER_LEASE_MS = 300000;

function leaseError(message, code, status = 409) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function normalizeLeaseInput(input = {}) {
    const sessionId = String(input.sessionId || '').trim().slice(0, 128);
    const userId = Number(input.userId);
    const ownerId = String(input.ownerId || '').trim().slice(0, 128);
    const token = String(input.token || '').trim();
    const requestedMs = Number(input.leaseMs);
    const leaseMs = Number.isFinite(requestedMs) && requestedMs > 0
        ? Math.min(Math.max(requestedMs, 10000), MAX_BROWSER_LEASE_MS)
        : DEFAULT_BROWSER_LEASE_MS;
    if (!sessionId || !Number.isSafeInteger(userId) || userId <= 0 || !ownerId) {
        throw leaseError('浏览器会话租约缺少有效的会话、用户或执行器标识。', 'AGENT_BROWSER_LEASE_INVALID', 400);
    }
    return { sessionId, userId, ownerId, token, leaseMs };
}

function createBrowserSessionLeaseStore({ runTransaction = transaction } = {}) {
    async function lockSessionAndLease(trx, input) {
        const session = await trx.queryOne(`
            SELECT id, status, mutation_pending_recovery, last_action
            FROM agent_browser_sessions WHERE id = ? AND user_id = ? FOR UPDATE
        `, [input.sessionId, input.userId]);
        if (!session) throw leaseError('浏览器会话不存在或无权访问。', 'AGENT_BROWSER_SESSION_NOT_FOUND', 404);
        const lease = await trx.queryOne(`
            SELECT *, lease_expires_at > NOW() AS lease_active
            FROM agent_browser_session_leases WHERE session_id = ? FOR UPDATE
        `, [input.sessionId]);
        return { session, lease };
    }

    async function acquireBrowserSessionLease(value = {}) {
        const input = normalizeLeaseInput(value);
        const recovery = value.recovery === true;
        if (recovery && value.confirmed !== true) {
            throw leaseError('恢复浏览器会话前必须由用户明确确认。', 'AGENT_BROWSER_RECOVERY_CONFIRMATION_REQUIRED');
        }
        return await runTransaction(async trx => {
            const { session, lease } = await lockSessionAndLease(trx, input);
            const requiredStatus = recovery ? 'needs_user_recovery' : 'active';
            if (session.status !== requiredStatus) {
                if (!recovery && session.status === 'needs_user_recovery') return { acquired: false, reason: 'recovery_required' };
                throw leaseError('浏览器会话状态已变化，请重新检查后再操作。', 'AGENT_BROWSER_SESSION_STATE_CONFLICT');
            }
            const sameOwner = lease && lease.owner_id === input.ownerId && String(lease.lease_token) === input.token;
            if (lease?.lease_active && !sameOwner) {
                return { acquired: false, reason: 'busy' };
            }
            if (lease?.lease_active && sameOwner) {
                const renewed = await trx.queryOne(`
                    UPDATE agent_browser_session_leases
                    SET lease_expires_at = NOW() + (? * INTERVAL '1 millisecond'), updated_at = NOW()
                    WHERE session_id = ? AND lease_token = ? RETURNING lease_expires_at
                `, [input.leaseMs, input.sessionId, input.token]);
                return { acquired: true, renewed: true, token: input.token, expiresAt: renewed.lease_expires_at };
            }
            if (!recovery && (session.mutation_pending_recovery === true || ['click', 'fill', 'select', 'mutation_intent'].includes(String(session.last_action || '')))) {
                await trx.execute("UPDATE agent_browser_sessions SET status = 'needs_user_recovery', mutation_pending_recovery = TRUE, last_action = 'crash_recovery_required', revision = revision + 1, updated_at = NOW() WHERE id = ? AND user_id = ?", [input.sessionId, input.userId]);
                return { acquired: false, reason: 'recovery_required' };
            }
            const token = crypto.randomUUID();
            const acquired = await trx.queryOne(`
                INSERT INTO agent_browser_session_leases (session_id, user_id, owner_id, lease_token, lease_expires_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, NOW() + (? * INTERVAL '1 millisecond'), NOW(), NOW())
                ON CONFLICT(session_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, lease_token = EXCLUDED.lease_token,
                    lease_expires_at = EXCLUDED.lease_expires_at, updated_at = NOW()
                RETURNING lease_expires_at
            `, [input.sessionId, input.userId, input.ownerId, token, input.leaseMs]);
            return { acquired: true, renewed: false, token, expiresAt: acquired.lease_expires_at };
        });
    }

    async function renewBrowserSessionLease(value = {}) {
        const input = normalizeLeaseInput(value);
        if (!input.token) return false;
        return await runTransaction(async trx => {
            const { session, lease } = await lockSessionAndLease(trx, input);
            const allowedStatus = session.status === 'active' || (value.recovery === true && session.status === 'needs_user_recovery');
            if (!allowedStatus || !lease?.lease_active
                || lease.owner_id !== input.ownerId || String(lease.lease_token) !== input.token) return false;
            const changed = await trx.execute(`
                UPDATE agent_browser_session_leases
                SET lease_expires_at = NOW() + (? * INTERVAL '1 millisecond'), updated_at = NOW()
                WHERE session_id = ? AND lease_token = ?
            `, [input.leaseMs, input.sessionId, input.token]);
            return changed === 1;
        });
    }

    async function markBrowserMutationWithLease(value = {}) {
        const input = normalizeLeaseInput(value);
        if (!input.token) return false;
        return await runTransaction(async trx => {
            const { session, lease } = await lockSessionAndLease(trx, input);
            if (session.status !== 'active' || !lease?.lease_active || lease.owner_id !== input.ownerId
                || String(lease.lease_token) !== input.token) return false;
            const changed = await trx.execute(`
                UPDATE agent_browser_sessions
                SET mutation_pending_recovery = TRUE, last_action = 'mutation_intent', revision = revision + 1, updated_at = NOW()
                WHERE id = ? AND user_id = ? AND status = 'active'
            `, [input.sessionId, input.userId]);
            return changed === 1;
        });
    }

    async function releaseBrowserSessionLease(value = {}) {
        const input = normalizeLeaseInput(value);
        if (!input.token) return false;
        return await runTransaction(async trx => {
            const { lease } = await lockSessionAndLease(trx, input);
            if (!lease || lease.owner_id !== input.ownerId || String(lease.lease_token) !== input.token) return false;
            return await trx.execute('DELETE FROM agent_browser_session_leases WHERE session_id = ? AND lease_token = ?', [input.sessionId, input.token]) === 1;
        });
    }

    async function withBrowserSessionLease(value = {}, operation) {
        const input = normalizeLeaseInput(value);
        if (!input.token || typeof operation !== 'function') throw leaseError('浏览器会话租约不可用。', 'AGENT_BROWSER_LEASE_LOST');
        return await runTransaction(async trx => {
            const { session, lease } = await lockSessionAndLease(trx, input);
            if (!lease?.lease_active || lease.owner_id !== input.ownerId || String(lease.lease_token) !== input.token) {
                throw leaseError('浏览器会话执行权已失效，请重新检查会话。', 'AGENT_BROWSER_LEASE_LOST');
            }
            return await operation(trx, session);
        });
    }

    async function closeBrowserSessionWithLease(value = {}) {
        const input = normalizeLeaseInput(value);
        return await runTransaction(async trx => {
            const { session, lease } = await lockSessionAndLease(trx, input);
            const sameOwner = lease && lease.owner_id === input.ownerId && String(lease.lease_token) === input.token;
            if (lease?.lease_active && !sameOwner) return { closed: false, reason: 'busy' };
            if (!(lease?.lease_active && sameOwner) && session.mutation_pending_recovery === true) return { closed: false, reason: 'recovery_required' };
            if (input.token && !(lease?.lease_active && sameOwner)) return { closed: false, reason: 'lease_lost' };
            if (lease?.lease_active && sameOwner) {
                await trx.execute("UPDATE agent_browser_sessions SET status = 'needs_user_recovery', mutation_pending_recovery = TRUE, last_action = 'close_pending', revision = revision + 1, updated_at = NOW() WHERE id = ? AND user_id = ?", [input.sessionId, input.userId]);
                return { closed: false, pending: true };
            }
            const row = await trx.queryOne(`
                UPDATE agent_browser_sessions
                SET status = 'closed', last_action = ?, expires_at = NOW(), revision = revision + 1, updated_at = NOW()
                WHERE id = ? AND user_id = ? RETURNING *
            `, [String(value.reason || 'closed').slice(0, 80), input.sessionId, input.userId]);
            if (lease) await trx.execute('DELETE FROM agent_browser_session_leases WHERE session_id = ?', [input.sessionId]);
            return { closed: true, session: row };
        });
    }

    async function completeBrowserSessionClose(value = {}) {
        const input = normalizeLeaseInput(value);
        if (!input.token) throw leaseError('浏览器会话关闭租约不可用。', 'AGENT_BROWSER_LEASE_LOST');
        return await runTransaction(async trx => {
            const { session, lease } = await lockSessionAndLease(trx, input);
            if (session.status !== 'needs_user_recovery' || session.last_action !== 'close_pending'
                || !lease?.lease_active || lease.owner_id !== input.ownerId || String(lease.lease_token) !== input.token) {
                throw leaseError('浏览器会话关闭状态已变化，请人工核对。', 'AGENT_BROWSER_LEASE_LOST');
            }
            const row = await trx.queryOne(`
                UPDATE agent_browser_sessions SET status = 'closed', last_action = ?, expires_at = NOW(), revision = revision + 1, updated_at = NOW()
                WHERE id = ? AND user_id = ? RETURNING *
            `, [String(value.reason || 'closed').slice(0, 80), input.sessionId, input.userId]);
            await trx.execute('DELETE FROM agent_browser_session_leases WHERE session_id = ? AND lease_token = ?', [input.sessionId, input.token]);
            return row;
        });
    }

    async function finishBrowserSessionOwner(value = {}) {
        const input = normalizeLeaseInput(value);
        if (!input.token) return false;
        return await runTransaction(async trx => {
            const { session, lease } = await lockSessionAndLease(trx, input);
            if (!lease || lease.owner_id !== input.ownerId || String(lease.lease_token) !== input.token) return false;
            if (session.status === 'active' && session.mutation_pending_recovery === true) {
                await trx.execute("UPDATE agent_browser_sessions SET status = 'needs_user_recovery', last_action = 'crash_recovery_required', revision = revision + 1, updated_at = NOW() WHERE id = ? AND user_id = ?", [input.sessionId, input.userId]);
            }
            await trx.execute('DELETE FROM agent_browser_session_leases WHERE session_id = ? AND lease_token = ?', [input.sessionId, input.token]);
            return true;
        });
    }

    async function markAbandonedBrowserSession(value = {}) {
        const input = normalizeLeaseInput(value);
        return await runTransaction(async trx => {
            const { session, lease } = await lockSessionAndLease(trx, input);
            if (session.status !== 'active' || session.mutation_pending_recovery !== true || lease?.lease_active) return false;
            const changed = await trx.execute("UPDATE agent_browser_sessions SET status = 'needs_user_recovery', last_action = 'crash_recovery_required', revision = revision + 1, updated_at = NOW() WHERE id = ? AND user_id = ? AND status = 'active'", [input.sessionId, input.userId]);
            return changed === 1;
        });
    }

    return { acquireBrowserSessionLease, markBrowserMutationWithLease, releaseBrowserSessionLease, renewBrowserSessionLease, withBrowserSessionLease, closeBrowserSessionWithLease, completeBrowserSessionClose, finishBrowserSessionOwner, markAbandonedBrowserSession };
}

module.exports = { createBrowserSessionLeaseStore, DEFAULT_BROWSER_LEASE_MS };
