const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { createAgentResidencyStore } = require('../server/services/agent-residency');

test('Agent residency persists redacted state and evicts the oldest unleased resident per user', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const prefix = `residency-${suffix}`;
    let tick = 0;
    const now = () => new Date(Date.now() + (++tick * 1000)).toISOString();
    const store = createAgentResidencyStore({ maxEntries: 2, idleTtlMs: 3600000, now });
    try {
        const first = await store.touchResident({
            user,
            residentKey: `${prefix}-a`,
            state: { goal: '保留', apiKey: 'must-redact' }
        });
        await store.touchResident({ user, residentKey: `${prefix}-b`, state: { index: 2 } });
        await store.touchResident({ user, residentKey: `${prefix}-c`, state: { index: 3 } });
        const residents = await store.listResidents({ user, limit: 20 });
        assert.equal(residents.filter(item => ['active', 'idle'].includes(item.status)).length, 2);
        assert.equal(residents.find(item => item.resident_key === `${prefix}-a`)?.status, 'evicted');
        assert.equal(first.state.apiKey, '[已脱敏]');
        const leased = await store.acquireResidentLease({ user, residentKey: `${prefix}-b`, leaseOwner: 'test-worker' });
        assert.equal(leased.status, 'active');
        await store.touchResident({ user, residentKey: `${prefix}-d`, state: { index: 4 } });
        const afterLease = await store.listResidents({ user, limit: 20 });
        assert.notEqual(afterLease.find(item => item.resident_key === `${prefix}-b`)?.status, 'evicted');
        await store.releaseResidentLease({ user, residentKey: `${prefix}-b`, leaseOwner: 'test-worker' });
        assert.ok((await store.evictResident({ user, residentKey: `${prefix}-b` }) || {}).status === 'evicted');
    } finally {
        await execute('DELETE FROM agent_residencies WHERE user_id = ? AND resident_key LIKE ?', [user.id, `${prefix}%`]);
    }
});
