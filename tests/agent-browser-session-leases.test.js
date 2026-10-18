'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { execute, queryOne } = require('../server/db/client');
const { createBrowserSessionLeaseStore } = require('../server/services/agent-browser-session-leases');
const execFileAsync = promisify(execFile);

async function fixture(label) {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const sessionId = `browser_lease_${label}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await execute(`INSERT INTO agent_browser_sessions (id, user_id, tenant_id, status, network_policy, expires_at, created_at, updated_at)
        VALUES (?, ?, 1, 'active', '{}', NOW() + INTERVAL '1 hour', NOW(), NOW())`, [sessionId, user.id]);
    return { sessionId, userId: user.id };
}

test('browser-session lease has one owner under concurrent acquisition and enforces user scope', async () => {
    const session = await fixture('concurrent');
    const store = createBrowserSessionLeaseStore();
    try {
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) => store.acquireBrowserSessionLease({ ...session, ownerId: `worker-${index}` })));
        assert.equal(results.filter(item => item.acquired).length, 1);
        assert.equal(results.filter(item => item.reason === 'busy').length, 7);
        await assert.rejects(() => store.acquireBrowserSessionLease({ ...session, userId: Number(session.userId) + 100000, ownerId: 'other' }), error => error.code === 'AGENT_BROWSER_SESSION_NOT_FOUND');
    } finally {
        await execute('DELETE FROM agent_browser_sessions WHERE id = ?', [session.sessionId]);
    }
});

test('independent processes cannot simultaneously own the same browser session', async () => {
    const session = await fixture('multiprocess');
    try {
        const script = path.join(__dirname, 'helpers', 'agent-browser-lease-worker.js');
        const results = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
            const { stdout } = await execFileAsync(process.execPath, [script, session.sessionId, String(session.userId), `worker-${index}`], {
                cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, timeout: 20000
            });
            const match = stdout.match(/RESULT:(\{[^\r\n]+\})/);
            assert.ok(match, '工作进程没有返回租约结果。');
            return JSON.parse(match[1]);
        }));
        assert.equal(results.filter(item => item.acquired).length, 1);
        assert.equal(results.filter(item => item.reason === 'busy').length, 5);
    } finally {
        await execute('DELETE FROM agent_browser_sessions WHERE id = ?', [session.sessionId]);
    }
});

test('expired lease fences stale owners and preserves the mutation recovery barrier', async () => {
    const session = await fixture('fence');
    const store = createBrowserSessionLeaseStore();
    try {
        const ownerA = { ...session, ownerId: 'worker-a' };
        const ownerB = { ...session, ownerId: 'worker-b' };
        const first = await store.acquireBrowserSessionLease(ownerA);
        assert.equal(first.acquired, true);
        assert.equal((await store.acquireBrowserSessionLease(ownerA)).reason, 'busy');
        assert.deepEqual(await store.closeBrowserSessionWithLease(ownerB), { closed: false, reason: 'busy' });
        assert.equal(await store.renewBrowserSessionLease({ ...ownerA, token: first.token }), true);
        await execute("UPDATE agent_browser_session_leases SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE session_id = ?", [session.sessionId]);
        const second = await store.acquireBrowserSessionLease(ownerB);
        assert.equal(second.acquired, true);
        assert.notEqual(second.token, first.token);
        assert.equal(await store.renewBrowserSessionLease({ ...ownerA, token: first.token }), false);
        assert.equal(await store.markBrowserMutationWithLease({ ...ownerA, token: first.token }), false);
        assert.equal(await store.releaseBrowserSessionLease({ ...ownerA, token: first.token }), false);
        assert.equal(await store.finishBrowserSessionOwner({ ...ownerA, token: first.token }), false);
        await assert.rejects(() => store.withBrowserSessionLease({ ...ownerA, token: first.token }, async () => true), error => error.code === 'AGENT_BROWSER_LEASE_LOST');
        assert.equal(await store.markBrowserMutationWithLease({ ...ownerB, token: second.token }), true);
        await execute("UPDATE agent_browser_session_leases SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE session_id = ?", [session.sessionId]);
        assert.deepEqual(await store.closeBrowserSessionWithLease({ ...ownerB, token: second.token }), { closed: false, reason: 'recovery_required' });
        assert.deepEqual(await store.acquireBrowserSessionLease(ownerA), { acquired: false, reason: 'recovery_required' });
        const state = await queryOne('SELECT status, mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [session.sessionId]);
        assert.equal(state.status, 'needs_user_recovery');
        assert.equal(state.mutation_pending_recovery, true);
        assert.deepEqual(await store.closeBrowserSessionWithLease(ownerA), { closed: false, reason: 'recovery_required' });
        await assert.rejects(() => store.acquireBrowserSessionLease({ ...ownerA, recovery: true }), error => error.code === 'AGENT_BROWSER_RECOVERY_CONFIRMATION_REQUIRED');
        const recovery = await store.acquireBrowserSessionLease({ ...ownerA, recovery: true, confirmed: true });
        assert.equal(recovery.acquired, true);
        assert.notEqual(recovery.token, second.token);
        assert.equal((await queryOne('SELECT mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [session.sessionId])).mutation_pending_recovery, true);
    } finally {
        await execute('DELETE FROM agent_browser_sessions WHERE id = ?', [session.sessionId]);
    }
});

test('context closure preserves a mutation barrier and makes recovery visible', async () => {
    const session = await fixture('closed-context');
    const store = createBrowserSessionLeaseStore();
    try {
        const owner = { ...session, ownerId: 'worker-a' };
        const lease = await store.acquireBrowserSessionLease(owner);
        assert.equal(await store.markBrowserMutationWithLease({ ...owner, token: lease.token }), true);
        assert.equal(await store.finishBrowserSessionOwner({ ...owner, token: lease.token }), true);
        const state = await queryOne('SELECT status, mutation_pending_recovery FROM agent_browser_sessions WHERE id = ?', [session.sessionId]);
        assert.equal(state.status, 'needs_user_recovery');
        assert.equal(state.mutation_pending_recovery, true);
        assert.equal(await queryOne('SELECT session_id FROM agent_browser_session_leases WHERE session_id = ?', [session.sessionId]), null);
        assert.deepEqual(await store.acquireBrowserSessionLease({ ...session, ownerId: 'worker-b' }), { acquired: false, reason: 'recovery_required' });
    } finally {
        await execute('DELETE FROM agent_browser_sessions WHERE id = ?', [session.sessionId]);
    }
});
