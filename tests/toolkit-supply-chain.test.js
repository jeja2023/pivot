'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { validateToolkitManifest, validateToolkitTools, verifyToolkitSignature } = require('../server/services/toolkit-supply-chain');

function signableManifest() {
    return {
        schemaVersion: '1.0', slug: 'acme.orders', version: '1.2.3', displayName: '订单工具包', publisher: 'Acme',
        protocol: { type: 'mcp', versions: ['2025-11-25', '2026-07-28'] }, tools: ['orders.search'],
        requiredCapabilities: ['network.request'], requiredScopes: ['orders.read'], dataClassification: 'internal',
        privacyUrl: 'https://acme.example/privacy', keyId: 'acme-key'
    };
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
}

test('工具包 Manifest 校验约束版本、能力、协议和隐私信息', () => {
    const checked = validateToolkitManifest(signableManifest());
    assert.equal(checked.valid, true);
    const invalid = validateToolkitManifest({ ...signableManifest(), requiredCapabilities: ['unknown.permission'], privacyUrl: 'http://unsafe.example/privacy' });
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors.join(' '), /未登记能力/);
    assert.match(invalid.errors.join(' '), /HTTPS/);
});

test('工具包签名覆盖标准化 Manifest，目录工具不一致时验证失败', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const manifest = signableManifest();
    const payload = { ...manifest };
    delete payload.keyId;
    manifest.signature = crypto.sign('RSA-SHA256', Buffer.from(JSON.stringify(stable(payload))), privateKey).toString('base64');
    const signature = verifyToolkitSignature(manifest, { key_id: 'acme-key', status: 'active', public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }) });
    assert.equal(signature.verified, true);
    const tools = validateToolkitTools({ tools: ['orders.search'] }, [{
        name: 'orders.search', title: '订单查询', description: '查询订单', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }
    }], 7);
    assert.equal(tools.passed, true);
    const mismatch = validateToolkitTools({ tools: ['orders.delete'] }, [{ name: 'orders.search', title: '订单查询', description: '查询订单', inputSchema: { type: 'object' } }], 7);
    assert.equal(mismatch.passed, false);
    assert.match(mismatch.errors.join(' '), /未在目录中发现/);
});
