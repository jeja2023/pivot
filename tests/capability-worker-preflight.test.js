'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canonicalJson } = require('../server/services/canonical-json');
const { preflightCapabilityWorkers } = require('../scripts/preflight_capability_workers');

const image = 'registry.example/pivot/code@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('capability Worker preflight requires trusted, locally preloaded production images', () => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const unsigned = { version: 1, images: [{ image, commands: ['node,/runner/runner.js'] }] };
    const signer = crypto.createSign('RSA-SHA256'); signer.update(canonicalJson(unsigned)); signer.end();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-worker-preflight-'));
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ ...unsigned, signatureAlgorithm: 'RSA-SHA256', signature: signer.sign(pair.privateKey).toString('base64') }));
    try {
        const env = { NODE_ENV: 'production', PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_AGENT_CODE_WORKER_IMAGE: image, PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: manifest, PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: pair.publicKey.export({ type: 'pkcs1', format: 'pem' }) };
        const missing = preflightCapabilityWorkers(env, { inspectImage: () => ({ present: false }) });
        assert.equal(missing.ready, false);
        assert.ok(missing.blockers.includes('code:image_missing'));
        const ready = preflightCapabilityWorkers(env, { inspectImage: () => ({ present: true }) });
        assert.equal(ready.ready, true);
        assert.equal(ready.workers.find(item => item.name === 'code').trustMode, 'signed_manifest');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
