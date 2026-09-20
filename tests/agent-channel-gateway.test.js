const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { canonicalJson } = require('../server/services/canonical-json');
const {
    configForBinding,
    digestExternalValue,
    normalizeInboundMessage,
    verifyGatewaySignature
} = require('../server/services/agent-channel-gateway');
const { normalizeBindingInput } = require('../server/services/agent-channels');
const { attachmentMessageReferences, normalizeInboundAttachmentPayload } = require('../server/services/agent-channel-inbound-attachments');

test('channel gateway verifies canonical signed payloads and keeps external identities opaque', () => {
    const secret = 'gateway-test-secret-012345678901234567890';
    const timestamp = String(Date.now());
    const signed = { conversationId: 'group-42', senderId: 'user-99', text: '你好', eventId: 'evt-1' };
    const reordered = { text: '你好', eventId: 'evt-1', senderId: 'user-99', conversationId: 'group-42' };
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(signed)}`).digest('hex');
    assert.equal(verifyGatewaySignature(secret, timestamp, reordered, signature), true);
    assert.equal(verifyGatewaySignature(secret, timestamp, { ...reordered, text: '篡改' }, signature), false);
    assert.notEqual(digestExternalValue(secret, 'binding-a', 'user-99'), digestExternalValue(secret, 'binding-b', 'user-99'));
});

test('channel gateway accepts only explicit normalized identity, conversation, text, and pairing fields', () => {
    const config = configForBinding({
        credential_ref: 'CHANNEL_GATEWAY',
        config: {
            gateway: {
                enabled: true,
                identityPath: 'sender.id',
                conversationPath: 'chat.id',
                messagePath: 'message.body',
                eventIdPath: 'event.id',
                pairingCodePath: 'pair.code'
            }
        }
    });
    assert.equal(config.enabled, true);
    const normalized = normalizeInboundMessage({
        sender: { id: 'external-user-1' },
        chat: { id: 'external-chat-1' },
        message: { body: '请汇总今天的风险' },
        event: { id: 'event-1' },
        pair: { code: 'pair_once' }
    }, config);
    assert.deepEqual(normalized, {
        identity: 'external-user-1',
        conversation: 'external-chat-1',
        text: '请汇总今天的风险',
        attachments: [],
        eventId: 'event-1',
        pairingCode: 'pair_once'
    });
    assert.throws(
        () => normalizeInboundMessage({ sender: { id: 'external-user-1' }, chat: { id: 'external-chat-1' } }, config),
        error => error.code === 'AGENT_CHANNEL_GATEWAY_MESSAGE_REQUIRED'
    );
});

test('channel gateway accepts only bounded inline attachments and creates local-only message references', () => {
    const attachments = normalizeInboundAttachmentPayload([{
        name: '风险清单.csv', contentType: 'text/csv', contentBase64: Buffer.from('risk,level\nA,high\n').toString('base64')
    }]);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].name, '风险清单.csv');
    assert.throws(
        () => normalizeInboundAttachmentPayload([{ name: 'remote.pdf', contentType: 'application/pdf', url: 'https://untrusted.example/remote.pdf' }]),
        error => error.code === 'CHANNEL_INBOUND_ATTACHMENT_EXTERNAL_URL_REJECTED'
    );
    const content = attachmentMessageReferences([{ name: '风险清单.csv', contentType: 'text/csv', url: '/uploads/1/s1/test.csv?token=opaque' }]);
    assert.equal(content, '[附件: 风险清单.csv](/uploads/1/s1/test.csv?token=opaque)');
});

test('channel gateway refuses configuration without a dedicated data-encryption key', () => {
    const previous = process.env.DATA_ENCRYPTION_KEY;
    delete process.env.DATA_ENCRYPTION_KEY;
    try {
        assert.throws(
            () => normalizeBindingInput({
                channelType: 'webhook', channelKey: 'paired-agent', credentialRef: 'GATEWAY_SIGNING_KEY',
                config: { url: 'https://gateway.example.test/outbound', gateway: { enabled: true } }
            }),
            error => error.status === 503 && /DATA_ENCRYPTION_KEY/.test(error.message)
        );
    } finally {
        if (previous === undefined) delete process.env.DATA_ENCRYPTION_KEY;
        else process.env.DATA_ENCRYPTION_KEY = previous;
    }
});

test('channel gateway migration, runtime handoff, and public hook retain the durable security boundary', () => {
    const migration = fs.readFileSync(path.resolve(__dirname, '../server/db/migrations/agent-channel-gateway.js'), 'utf8');
    const targetMigration = fs.readFileSync(path.resolve(__dirname, '../server/db/migrations/agent-channel-gateway-target.js'), 'utf8');
    const runtime = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-runtime/index.js'), 'utf8');
    const state = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-runtime/run-state.js'), 'utf8');
    const triggers = fs.readFileSync(path.resolve(__dirname, '../server/routes/triggers.js'), 'utf8');
    const routes = fs.readFileSync(path.resolve(__dirname, '../server/routes/agent-control-plane.js'), 'utf8');
    const gateway = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-channel-gateway.js'), 'utf8');
    const adapters = fs.readFileSync(path.resolve(__dirname, '../server/services/agent-channel-adapters.js'), 'utf8');

    for (const table of ['agent_channel_pairings', 'agent_channel_sessions', 'agent_channel_inbound_events']) {
        assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    assert.match(migration, /UNIQUE\(binding_id, idempotency_key\)/);
    assert.match(targetMigration, /outbound_target_encrypted/);
    assert.match(gateway, /encryptOutboundTarget/);
    assert.match(gateway, /outboundTargetEncrypted/);
    assert.doesNotMatch(gateway, /outboundTarget:\s*target/);
    assert.match(adapters, /gatewayOutboundTarget/);
    assert.match(adapters, /outboundInteractionForProvider/);
    assert.match(runtime, /configureAgentChannelGateway\(\{ createAgentRun \}\)/);
    assert.match(state, /deliverChannelGatewayRunResult\(runId, targetStatus\)/);
    assert.match(triggers, /\/channel\/:bindingId\/message/);
    assert.match(routes, /\/agents\/channels\/:id\/pairings/);
    assert.match(routes, /\/agents\/channels\/:id\/sessions/);
});
