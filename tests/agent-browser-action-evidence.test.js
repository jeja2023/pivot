'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { compareBrowserVisualObservations, listBrowserActionEvidenceForRun, recordBrowserActionEvidence } = require('../server/services/agent-browser-action-evidence');

test('browser action evidence is run/user scoped and stores only observe-before/after fingerprints', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const runId = `browser-evidence-run-${suffix}`;
    const sessionId = `browser-evidence-session-${suffix}`;
    await execute(`INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, 'browser evidence', 'browser evidence', 'running', '{}', NOW(), NOW())`, [runId, user.id]);
    await execute(`INSERT INTO agent_browser_sessions (id, run_id, user_id, tenant_id, status, network_policy, expires_at, created_at, updated_at) VALUES (?, ?, ?, 0, 'active', '{}', NOW() + INTERVAL '1 hour', NOW(), NOW())`, [sessionId, runId, user.id]);
    try {
        const item = await recordBrowserActionEvidence({
            sessionId, runId, user, action: 'click', tabId: 'tab_1',
            beforeState: { url: 'https://example.test/before', title: 'Before', bodyTextDigest: 'a'.repeat(64), bodyTextChars: 12, controls: 3 },
            afterState: { url: 'https://example.test/after', title: 'After', bodyTextDigest: 'b'.repeat(64), bodyTextChars: 16, controls: 4 },
            outcome: { method: 'dom', target: { selector: 'button#save' }, visualDiff: { beforeDigest: 'c'.repeat(64), afterDigest: 'd'.repeat(64), changedPixelRatio: 0.125 } }
        });
        assert.ok(item?.id);
        const evidence = await listBrowserActionEvidenceForRun(runId, user);
        assert.equal(evidence.length, 1);
        assert.equal(evidence[0].before.url, 'https://example.test/before');
        assert.equal(evidence[0].after.bodyTextDigest, 'b'.repeat(64));
        assert.equal(evidence[0].outcome.visualDiff.changedPixelRatio, 0.125);
        assert.equal(JSON.stringify(evidence[0]).includes('Cookie'), false);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});

test('视觉差异只比较内存中的缩略像素，不保留截图正文', () => {
    const before = { pixels: Buffer.from([0, 0, 0, 0, 0, 0]), digest: 'a'.repeat(64) };
    const after = { pixels: Buffer.from([255, 255, 255, 0, 0, 0]), digest: 'b'.repeat(64) };
    assert.deepEqual(compareBrowserVisualObservations(before, after), { beforeDigest: 'a'.repeat(64), afterDigest: 'b'.repeat(64), changedPixelRatio: 0.5 });
});
