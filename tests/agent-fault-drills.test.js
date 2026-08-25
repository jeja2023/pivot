const assert = require('node:assert/strict');
const test = require('node:test');
const { backoff, chunkText, normalizeAttachments } = require('../server/services/agent-channel-adapters');
const { normalizeTriggerSpec } = require('../server/services/agent-goals');
const { createWorkspaceJail } = require('../server/services/agent-sandbox');
const { verifySignature } = require('../server/services/agent-channel-interactions');
const crypto = require('node:crypto');

test('channel retry backoff remains bounded and attachments are capped', () => {
    assert.ok(backoff(1) >= 1000);
    assert.ok(backoff(100) <= 3600000 + 500);
    assert.equal(normalizeAttachments([{ name: 'too-large', url: 'https://example.test', bytes: 11 * 1024 * 1024 }]).length, 0);
    assert.ok(chunkText('x'.repeat(10000), 3500).length >= 3);
});

test('goal trigger fault guards reject unsafe file/database inputs', () => {
    assert.throws(() => normalizeTriggerSpec({ type: 'file', directory: '' }), /监听目录/);
    assert.throws(() => normalizeTriggerSpec({ type: 'database', query: "UPDATE t SET x=1 WHERE updated_at > '{{watermark}}'" }), /只读/);
});

test('sandbox jail rejects path traversal', () => {
    const jail = createWorkspaceJail(require('os').tmpdir(), `fault-${Date.now()}`);
    assert.throws(() => jail.resolve('../outside'), /越权/);
});

test('channel approval interaction signatures are constant-time verifiable', () => {
    const payload = { requestId: 'approval-1', decision: 'approve' };
    const timestamp = String(Date.now());
    const secret = 'channel-secret';
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${JSON.stringify(payload)}`).digest('hex');
    assert.equal(verifySignature(secret, timestamp, payload, signature), true);
    assert.equal(verifySignature(secret, timestamp, payload, `${signature}x`), false);
});
