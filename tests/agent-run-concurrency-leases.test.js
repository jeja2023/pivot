const test = require('node:test');
const assert = require('node:assert/strict');

const { createRunConcurrencyLeaseStore } = require('../server/services/agent-run-concurrency-leases');

function createInMemoryLeaseTransaction() {
    const rows = new Map();
    const trx = {
        async queryOne(sql, params = []) {
            if (/pg_advisory_xact_lock/i.test(sql)) return { locked: true };
            if (/SELECT run_id, user_id, lease_owner/i.test(sql)) return rows.get(String(params[0])) || null;
            if (/SELECT COUNT\(\*\) AS count/i.test(sql)) {
                const [userId, current] = params;
                const count = [...rows.values()].filter(row => String(row.user_id) === String(userId) && row.lease_expires_at > current).length;
                return { count };
            }
            return null;
        },
        async execute(sql, params = []) {
            if (/DELETE FROM agent_run_concurrency_leases WHERE user_id = \? AND lease_expires_at <= \?/i.test(sql)) {
                const [userId, current] = params;
                for (const [key, row] of rows) {
                    if (String(row.user_id) === String(userId) && row.lease_expires_at <= current) rows.delete(key);
                }
                return 1;
            }
            if (/INSERT INTO agent_run_concurrency_leases/i.test(sql)) {
                const [runId, userId, leaseOwner, expiresAt] = params;
                rows.set(String(runId), { run_id: runId, user_id: userId, lease_owner: leaseOwner, lease_expires_at: expiresAt });
                return 1;
            }
            if (/SET lease_owner = \?, lease_expires_at = \?/i.test(sql)) {
                const [leaseOwner, expiresAt, , runId] = params;
                const row = rows.get(String(runId));
                if (!row) return 0;
                row.lease_owner = leaseOwner;
                row.lease_expires_at = expiresAt;
                return 1;
            }
            if (/SET lease_expires_at = \?, updated_at = \?/i.test(sql)) {
                const [expiresAt, , runId, userId, leaseOwner, current] = params;
                const row = rows.get(String(runId));
                if (!row || String(row.user_id) !== String(userId) || row.lease_owner !== leaseOwner || row.lease_expires_at <= current) return 0;
                row.lease_expires_at = expiresAt;
                return 1;
            }
            if (/DELETE FROM agent_run_concurrency_leases WHERE run_id = \? AND lease_owner = \?/i.test(sql)) {
                const [runId, leaseOwner, userId] = params;
                const row = rows.get(String(runId));
                if (!row || row.lease_owner !== leaseOwner || (userId && String(row.user_id) !== String(userId))) return 0;
                rows.delete(String(runId));
                return 1;
            }
            throw new Error(`未预期的租约 SQL：${sql}`);
        }
    };
    return { rows, transaction: async callback => await callback(trx) };
}

test('数据库并发租约在同一用户的原子配额内申请、续租和释放', async () => {
    const memory = createInMemoryLeaseTransaction();
    const store = createRunConcurrencyLeaseStore({
        transaction: memory.transaction,
        getTimestamp: date => date ? date.toISOString() : '2026-09-19T00:00:00.000Z',
        now: () => Date.parse('2026-09-19T00:00:00.000Z')
    });

    assert.equal((await store.acquireRunConcurrencyLease({ runId: 'r1', userId: 7, leaseOwner: 'a', limit: 1 })).acquired, true);
    assert.deepEqual(await store.acquireRunConcurrencyLease({ runId: 'r2', userId: 7, leaseOwner: 'b', limit: 1 }), {
        acquired: false,
        reason: 'per_user_concurrency_exceeded'
    });
    assert.equal((await store.acquireRunConcurrencyLease({ runId: 'r3', userId: 8, leaseOwner: 'b', limit: 1 })).acquired, true);
    assert.equal((await store.renewRunConcurrencyLease({ runId: 'r1', userId: 7, leaseOwner: 'a' })).renewed, true);
    assert.equal((await store.renewRunConcurrencyLease({ runId: 'r1', userId: 7, leaseOwner: 'other' })).renewed, false);
    assert.equal(await store.releaseRunConcurrencyLease({ runId: 'r1', userId: 7, leaseOwner: 'a' }), true);
    assert.equal((await store.acquireRunConcurrencyLease({ runId: 'r2', userId: 7, leaseOwner: 'b', limit: 1 })).acquired, true);
});
