'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { runCapabilityWorker, verifyWorkerSignature } = require('../server/services/agent-capability-worker');
const { issueExecutionGrant } = require('../server/services/agent-execution-grant');
const { canonicalJson } = require('../server/services/canonical-json');

const SECRET = 'capability-worker-grant-test-secret-must-be-at-least-32-bytes';
const WORKER = {
    image: 'registry.example/pivot/terminal-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    command: ['pivot-terminal-runner'],
    limits: { cpu: 1, memoryMb: 128, timeoutMs: 1000, maxOutputBytes: 4096 }
};

function issue(input) {
    return issueExecutionGrant({
        runId: 'worker-run', userId: 9, tenantId: 2, tool: 'terminal.runtime', capability: 'code.execute', input,
        policy: { decision: 'allow' }, workspace: { scopeId: 'run:worker-run', mode: 'rw', target: '/workspace' }, network: { mode: 'deny' }
    }, { secret: SECRET });
}

function fakeSpawnFactory(captured) {
    return (command, args) => {
        captured.command = command;
        captured.args = args;
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => true;
        let input = '';
        child.stdin.on('data', chunk => { input += chunk.toString('utf8'); });
        child.stdin.on('finish', () => {
            captured.input = JSON.parse(input);
            process.nextTick(() => {
                child.stdout.end(JSON.stringify({ exitCode: 0, stdout: 'ok', stderr: '' }));
                child.emit('close', 0, null);
            });
        });
        return child;
    };
}

test('Capability Worker rejects high-risk execution without a control-plane grant before spawn', async () => {
    await assert.rejects(
        () => runCapabilityWorker(WORKER, { action: 'exec' }, {
            env: { PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_AGENT_EXECUTION_GRANT_SECRET: SECRET },
            requireExecutionGrant: true
        }),
        error => error.code === 'AGENT_EXECUTION_GRANT_REQUIRED'
    );
});

test('Capability Worker verifies the grant before spawn and never exposes it to the container', async () => {
    const request = { version: 1, action: 'exec', command: 'node', args: ['-v'], scriptPath: null, timeoutMs: 5000 };
    const grant = issue(request);
    const captured = {};
    const result = await runCapabilityWorker(WORKER, request, {
        env: { PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_AGENT_EXECUTION_GRANT_SECRET: SECRET },
        spawn: fakeSpawnFactory(captured),
        requireExecutionGrant: true,
        executionGrant: grant.token,
        executionGrantExpected: {
            runId: 'worker-run', userId: 9, tool: 'terminal.runtime', capability: 'code.execute', input: request, workspaceScopeId: 'run:worker-run'
        }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(captured.args.includes('-i'), true, 'Docker Worker 必须接收 JSON stdin 协议载荷');
    assert.equal(captured.args.includes('--pull'), true);
    assert.equal(captured.args[captured.args.indexOf('--pull') + 1], 'never', '生产 Worker 只能使用部署时预置的镜像，不能在执行时拉取');
    assert.equal(captured.args.includes('--network'), true);
    assert.equal(captured.args[captured.args.indexOf('--network') + 1], 'none');
    assert.equal(captured.args.includes('--read-only'), true);
    assert.equal(captured.input.executionGrant, undefined);
    assert.equal(captured.input.command, 'node');
    assert.equal(JSON.stringify(captured.args).includes(grant.token), false, '授权不得进入 docker CLI 参数或日志面');
});

test('Capability Worker refuses a grant bound to a different request', async () => {
    const request = { version: 1, action: 'exec', command: 'node', args: ['-v'], scriptPath: null, timeoutMs: 5000 };
    const grant = issue(request);
    await assert.rejects(
        () => runCapabilityWorker(WORKER, { ...request, args: ['--inspect'] }, {
            env: { PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_AGENT_EXECUTION_GRANT_SECRET: SECRET },
            requireExecutionGrant: true,
            executionGrant: grant.token,
            executionGrantExpected: {
                runId: 'worker-run', userId: 9, tool: 'terminal.runtime', capability: 'code.execute', input: { ...request, args: ['--inspect'] }, workspaceScopeId: 'run:worker-run'
            }
        }),
        error => error.code === 'AGENT_EXECUTION_GRANT_BINDING_MISMATCH'
    );
});

test('Capability Worker validates a signed image-and-command trust manifest before launch', () => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const unsigned = { version: 1, images: [{ image: WORKER.image, commands: [WORKER.command.join(',')] }] };
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonicalJson(unsigned)); signer.end();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-worker-manifest-'));
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...unsigned, signatureAlgorithm: 'RSA-SHA256', signature: signer.sign(pair.privateKey).toString('base64') }), 'utf8');
    try {
        const env = {
            PIVOT_CAPABILITY_WORKER_SIGNATURE_REQUIRED: 'true',
            PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: manifestPath,
            PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: pair.publicKey.export({ type: 'pkcs1', format: 'pem' })
        };
        const verified = verifyWorkerSignature(WORKER, { env });
        assert.equal(verified.verified, true);
        assert.equal(verified.mode, 'signed_manifest');
        assert.throws(
            () => verifyWorkerSignature({ ...WORKER, command: ['node', '/runner/other.js'] }, { env }),
            error => error.code === 'CAPABILITY_WORKER_COMMAND_UNTRUSTED'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Capability Worker refuses a trust manifest that attempts to downgrade its signature algorithm', () => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const unsigned = { version: 1, images: [{ image: WORKER.image, commands: [WORKER.command.join(',')] }] };
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonicalJson(unsigned)); signer.end();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-worker-manifest-algorithm-'));
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...unsigned, signatureAlgorithm: 'RSA-SHA1', signature: signer.sign(pair.privateKey).toString('base64') }), 'utf8');
    try {
        assert.throws(
            () => verifyWorkerSignature(WORKER, {
                env: {
                    PIVOT_CAPABILITY_WORKER_SIGNATURE_REQUIRED: 'true',
                    PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: manifestPath,
                    PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: pair.publicKey.export({ type: 'pkcs1', format: 'pem' })
                }
            }),
            error => error.code === 'CAPABILITY_WORKER_SIGNATURE_ALGORITHM_INVALID'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Capability Worker requires a signed release manifest in production even when the flag is omitted', () => {
    assert.throws(
        () => verifyWorkerSignature(WORKER, { env: { NODE_ENV: 'production' } }),
        error => ['CAPABILITY_WORKER_SIGNING_KEY_REQUIRED', 'CAPABILITY_WORKER_TRUST_MANIFEST_REQUIRED'].includes(error.code)
    );
});
