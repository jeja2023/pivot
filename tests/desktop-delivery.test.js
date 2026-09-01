const assert = require('node:assert/strict');
const test = require('node:test');

const { createDeliveryExecutor } = require('../desktop/delivery/executor');

test('桌面受控交付对下载与确认均绑定设备 nonce 签名', async () => {
    const calls = [];
    const deviceId = 'desktop-delivery-test-1';
    const expectedDigest = 'a'.repeat(64);
    const api = {
        async challenge(purpose, id) {
            assert.equal(id, deviceId);
            return { nonce: `${purpose}-nonce` };
        },
        async registerDevice(payload) {
            calls.push(['register', payload]);
            return { device_id: deviceId };
        },
        async attest() { return {}; },
        async claim(payload) {
            calls.push(['claim', payload]);
            return {
                status: 'claimed',
                claimToken: 'claim-secret',
                downloadToken: 'download-secret',
                intent: { id: 7, idempotency_key: 'intent-key', target_dir_grant: 'grant-1', target_filename: '通知.docx' },
                rendition: { id: 8, format: 'docx', contentDigest: expectedDigest, byteSize: 3 },
                grant: { id: 'grant-1', pathHint: 'exports/docs', maxBytes: 1024 },
                targetFilename: '通知.docx',
                allowOverwrite: false
            };
        },
        async downloadRendition(renditionId, token, id, proof) {
            calls.push(['download', { renditionId, token, id, proof }]);
            assert.equal(proof.signature, `sig:download:${proof.nonce}:${deviceId}:8:download-secret`);
            return { body: Buffer.from('abc') };
        },
        async confirm(intentId, payload) {
            calls.push(['confirm', { intentId, payload }]);
            assert.equal(payload.deviceId, deviceId);
            assert.equal(payload.signature, `sig:ack:${payload.nonce}:${deviceId}:7:claim-secret`);
            return { id: intentId, state: 'delivered' };
        },
        async fail() { throw new Error('不应进入失败回执'); }
    };
    const identity = {
        getDeviceId: () => deviceId,
        getPublicKeyPem: () => 'test-public-key',
        signPayload: payload => `sig:${payload}`,
        getIdentityStatus: () => ({ available: true, deviceId, keyType: 'ed25519', keyFingerprint: 'x' })
    };
    const executor = createDeliveryExecutor({
        api,
        identity,
        manifest: {
            getWritten: () => null,
            recordWritten() {},
            sumBytesWrittenSince: () => 0,
            listWritten: () => [],
            pruneOlderThan() {}
        },
        grants: {
            getLocalGrant: () => ({ directory: 'E:/exports/docs', pathHint: 'exports/docs', allowedFormats: ['docx'] }),
            listLocalGrants: () => [],
            pruneExpiredGrants() {}
        },
        writeFile: async input => {
            assert.equal(input.expectedDigest, expectedDigest);
            assert.equal(Buffer.from(input.source).toString(), 'abc');
            return { targetPath: 'E:/exports/docs/通知.docx', filename: '通知.docx', digest: expectedDigest, bytes: 3, overwritten: false };
        },
        now: () => 1000000,
        attestIntervalMs: 3600000
    });

    const result = await executor.runOnce();
    assert.equal(result.status, 'delivered');
    assert.ok(calls.some(([name]) => name === 'claim'));
    assert.ok(calls.some(([name]) => name === 'download'));
    assert.ok(calls.some(([name]) => name === 'confirm'));
});
