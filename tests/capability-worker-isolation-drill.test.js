'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canonicalJson } = require('../server/services/canonical-json');
const { buildWorkerDockerArguments, normalizeDefinition } = require('../server/services/agent-capability-worker');
const { buildIsolationDrillArguments, runIsolationDrill, validateStaging } = require('../scripts/capability_worker_isolation_drill');

const image = 'registry.example/pivot/code@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function signedEnvironment() {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const unsigned = { version: 1, images: [{ image, commands: ['node,/runner/runner.js'] }] };
    const signer = crypto.createSign('RSA-SHA256'); signer.update(canonicalJson(unsigned)); signer.end();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-isolation-drill-'));
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ ...unsigned, signatureAlgorithm: 'RSA-SHA256', signature: signer.sign(pair.privateKey).toString('base64') }));
    return {
        root,
        env: {
            NODE_ENV: 'test', PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_CAPABILITY_WORKER_SIGNATURE_REQUIRED: 'true',
            PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: manifest, PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: pair.publicKey.export({ type: 'pkcs1', format: 'pem' }),
            PIVOT_AGENT_CODE_WORKER_IMAGE: image, PIVOT_AGENT_CODE_WORKER_COMMAND: 'node,/runner/runner.js'
        }
    };
}

test('isolation drill reuses the production worker hardening flags and rejects production invocation', () => {
    const definition = { image, command: ['node', '/runner/runner.js'], limits: { cpu: 1, memoryMb: 512 } };
    const args = buildIsolationDrillArguments(definition, 'pivot-isolation-test');
    const productionArgs = buildWorkerDockerArguments(normalizeDefinition(definition), { containerName: 'pivot-isolation-test', limits: { ...normalizeDefinition(definition).limits, pids: 64 } });
    assert.deepEqual(args, productionArgs);
    for (const expected of ['--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--user', '65532:65532']) assert.ok(args.includes(expected));
    assert.throws(() => validateStaging({ NODE_ENV: 'production' }, ['node', 'drill', '--confirm-staging']), error => error.code === 'CAPABILITY_WORKER_ISOLATION_DRILL_PRODUCTION_FORBIDDEN');
});

test('isolation drill requires a preloaded signed image and all four in-container probes', () => {
    const { root, env } = signedEnvironment();
    try {
        let calls = 0;
        const result = runIsolationDrill(env, {
            args: ['node', 'drill', '--confirm-staging'],
            spawnSync: (_command, args) => {
                calls += 1;
                if (args[0] === 'image') return { status: 0, stdout: '{}', stderr: '' };
                return { status: 0, stdout: JSON.stringify({ ok: true, result: { uidNonRoot: true, rootReadOnly: true, capabilitiesDropped: true, networkBlocked: true } }), stderr: '' };
            }
        });
        assert.equal(calls, 2);
        assert.equal(result.ready, true);
        assert.equal(result.trustMode, 'signed_manifest');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('isolation drill rejects a successful container process when any required probe is false', () => {
    const { root, env } = signedEnvironment();
    try {
        assert.throws(() => runIsolationDrill(env, {
            args: ['node', 'drill', '--confirm-staging'],
            spawnSync: (_command, args) => args[0] === 'image'
                ? { status: 0, stdout: '{}', stderr: '' }
                : { status: 0, stdout: JSON.stringify({ ok: true, result: { uidNonRoot: true, rootReadOnly: true, capabilitiesDropped: false, networkBlocked: true } }), stderr: '' }
        }), error => error.code === 'CAPABILITY_WORKER_ISOLATION_DRILL_PROBE_FAILED');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
