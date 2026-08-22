const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { execute, query, queryOne } = require('../server/db/client');
const { createAgentResidencyStore } = require('../server/services/agent-residency');

function runWorker(userId, residentKey, owner) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'agent-residency-worker.js'), String(userId), residentKey, owner], {
            cwd: path.join(__dirname, '..'),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(stderr || `worker exited ${code}`));
            try {
                const match = stdout.match(/RESULT:(\{[^\r\n]+\})/);
                if (!match) throw new Error('missing RESULT marker');
                resolve(JSON.parse(match[1]));
            } catch (error) { reject(new Error(`invalid worker output: ${stdout} ${stderr}`)); }
        });
    });
}

test('residency lease acquisition is single-winner across concurrent processes', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const key = `multiprocess-${suffix}`;
    const store = createAgentResidencyStore({ maxEntries: 4, idleTtlMs: 3600000, leaseMs: 30000 });
    await store.touchResident({ user, residentKey: key, state: { test: 'multiprocess' } });
    try {
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runWorker(user.id, key, `worker-${index}`)));
        assert.equal(results.filter(item => item.acquired).length, 1);
        const row = await queryOne('SELECT lease_owner FROM agent_residencies WHERE user_id = ? AND resident_key = ?', [user.id, key]);
        assert.match(String(row?.lease_owner || ''), /^worker-/);
    } finally {
        await execute('DELETE FROM agent_residencies WHERE user_id = ? AND resident_key = ?', [user.id, key]);
    }
});

test('residency concurrent touches converge to the configured per-user LRU bound', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const keys = Array.from({ length: 12 }, (_, index) => `lru-pressure-${suffix}-${index}`);
    const store = createAgentResidencyStore({ maxEntries: 4, idleTtlMs: 3600000 });
    try {
        await Promise.all(keys.map(key => store.touchResident({ user, residentKey: key, state: { key } })));
        const active = await query(`SELECT resident_id FROM agent_residencies WHERE user_id = ? AND resident_key LIKE ? AND status IN ('active', 'idle')`, [user.id, `lru-pressure-${suffix}-%`]);
        assert.ok(active.length <= 4, `expected <=4 active residents, got ${active.length}`);
    } finally {
        await execute('DELETE FROM agent_residencies WHERE user_id = ? AND resident_key LIKE ?', [user.id, `lru-pressure-${suffix}-%`]);
    }
});
