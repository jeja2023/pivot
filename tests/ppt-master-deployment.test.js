'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sign, keyFor } = require('../scripts/lib/ppt_master_release');
const { argumentsFor } = require('../scripts/ppt_master_release');
const worker = require('../server/services/agent-capability-worker');
const deployment = require('../server/services/presentations/master/deployment');
const { preflightCapabilityWorkers } = require('../scripts/preflight_capability_workers');

test('离线完整镜像ID保持不可变，标签和短ID不能进入执行器', () => {
    const image = 'sha256:' + 'a'.repeat(64), command = ['python', '/runner/runner.py'];
    const spec = worker.normalizeDefinition({ image, command });
    const args = worker.buildWorkerDockerArguments(spec, { containerName: 'pivot-capability-offline-test' });
    assert.equal(args.at(-3), image); assert.ok(args.includes('never')); assert.ok(args.includes('none')); assert.ok(args.includes('--read-only'));
    for (const image of ['ppt-master:latest', 'ppt-master:6.8.0', 'sha256:aaaa', 'aaaa']) assert.throws(() => worker.normalizeDefinition({ image, command }), { code: 'CAPABILITY_WORKER_IMAGE_UNPINNED' });
});

test('离线ID仍须通过发布签名，PPT独立公钥不会替换其他Worker信任', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-master-trust-'));
    const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }), image = 'sha256:' + 'a'.repeat(64);
    const signed = sign({ version: 1, images: [{ image, commands: ['python,/runner/runner.py'] }] }, key.privateKey);
    const manifest = path.join(root, 'manifest.json'), publicKey = path.join(root, 'public.pem');
    fs.writeFileSync(manifest, JSON.stringify(signed)); fs.writeFileSync(publicKey, key.publicKey.export({ type: 'spki', format: 'pem' }));
    try {
        const env = { NODE_ENV: 'production', PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_PPT_MASTER_IMAGE: image,
            PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: 'other-workers.json', PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: '其他Worker的公钥',
            PIVOT_PPT_MASTER_TRUSTED_MANIFEST: manifest, PIVOT_PPT_MASTER_SIGNING_PUBLIC_KEY_FILE: publicKey };
        const result = preflightCapabilityWorkers(env, { inspectImage: () => ({ present: true }) });
        assert.equal(result.ready, true); assert.equal(result.workers.at(-1).trustMode, 'signed_manifest');
        assert.equal(env.PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST, 'other-workers.json');
        signed.images[0].image = 'sha256:' + 'b'.repeat(64); fs.writeFileSync(manifest, JSON.stringify(signed));
        assert.equal(preflightCapabilityWorkers(env, { inspectImage: () => ({ present: true }) }).ready, false);
        assert.throws(() => deployment.workerEnv({ PIVOT_PPT_MASTER_TRUSTED_MANIFEST: manifest }), /同时配置/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('构建发布密钥只创建一次，后续构建继续复用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-master-signing-')), file = path.join(root, 'private.pem');
    try {
        const first = await keyFor(file), previous = fs.readFileSync(file);
        await keyFor(file); assert.deepEqual(fs.readFileSync(file), previous); assert.equal(first.asymmetricKeyType, 'rsa');
        assert.throws(() => argumentsFor(['--output']), /请使用/);
        assert.equal(argumentsFor(['--skip-build', '--output', 'release']).skipBuild, true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('运行镜像打包Docker客户端、引擎锁和部署探针，默认Compose不授予Docker权限', () => {
    const dockerfile = fs.readFileSync(path.resolve('Dockerfile'), 'utf8'), compose = fs.readFileSync(path.resolve('docker-compose.yml'), 'utf8');
    assert.match(dockerfile, /COPY --from=docker-client \/usr\/local\/bin\/docker/);
    assert.match(dockerfile, /COPY --chown=node:node config\/ppt-master-engine.json/);
    assert.match(dockerfile, /scripts\/preflight_ppt_master.js/);
    assert.ok(!compose.includes('/var/run/docker.sock'));
});

test('升级后不把旧目录或其他镜像的制作检查点当作当前引擎继续执行', () => {
    const image = 'sha256:' + 'a'.repeat(64);
    assert.doesNotThrow(() => deployment.assertCheckpoint({ prepared: false }, image));
    assert.doesNotThrow(() => deployment.assertCheckpoint({ prepared: true, runtimeImage: image }, image));
    assert.throws(() => deployment.assertCheckpoint({ prepared: true }, image), { code: 'PPT_MASTER_CHECKPOINT_UNVERIFIED' });
    assert.throws(() => deployment.assertCheckpoint({ prepared: true, runtimeImage: 'sha256:' + 'b'.repeat(64) }, image), { code: 'PPT_MASTER_IMAGE_CHANGED' });
});
