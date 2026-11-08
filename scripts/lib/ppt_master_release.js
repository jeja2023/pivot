'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { canonicalJson } = require('../../server/services/canonical-json');
const { digestFile } = require('../../server/services/offline-backup-bundle');
const { normalizeDefinition, buildWorkerDockerArguments } = require('../../server/services/agent-capability-worker');
const ROOT = path.resolve(__dirname, '../..');
const defaultImage = () => 'ppt-master:' + require('../../config/ppt-master-engine.json').skillVersion;
const command = ['python', '/runner/runner.py'];
async function run(file, args, options = {}) {
    const { input = '', ...settings } = options;
    return new Promise((resolve, reject) => {
        const child = execFile(file, args, { cwd: ROOT, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000, ...settings }, (error, stdout, stderr) => {
            if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
            else resolve({ stdout, stderr });
        });
        child.stdin.on('error', () => {}); child.stdin.end(input);
    });
}
function sign(body, key) { return { ...body, signatureAlgorithm: 'RSA-SHA256', signature: crypto.sign('RSA-SHA256', Buffer.from(canonicalJson(body)), key).toString('base64') }; }
async function keyFor(file) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
        await fs.writeFile(file, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('发布私钥必须是仅当前用户可读的普通文件。');
    const key = crypto.createPrivateKey(await fs.readFile(file));
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('发布私钥必须是至少2048位RSA密钥。');
    return key;
}
async function build(checkout, python = process.platform === 'win32' ? 'python' : 'python3') {
    if (!checkout) throw new Error('构建引擎请通过--checkout指定固定上游仓库；已有验收镜像可使用--skip-build。');
    const lock = require('../../config/ppt-master-engine.json');
    const manifestFile = path.join(ROOT, 'artifacts/ppt-master-runtime/manifest.json');
    const manifest = await fs.readFile(manifestFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!manifest) await run(python, ['scripts/prepare_ppt_master.py', '--checkout', path.resolve(checkout)]);
    else if (manifest.revision !== lock.revision || manifest.contentDigest !== lock.contentDigest) throw new Error('已准备的运行包与当前锁定版本不同，请按部署说明准备新的固定版本，不能覆盖旧包。');
    return python;
}
async function release(options) {
    const imageName = options.image || defaultImage(), output = path.resolve(options.output);
    const signingKey = path.resolve(options.signingKey || path.join(os.homedir(), '.pivot-release-keys', 'ppt-master.pem'));
    if (signingKey === output || signingKey.startsWith(output + path.sep)) throw new Error('发布私钥不能放入交付目录。');
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
    try { await fs.mkdir(output, { recursive: false, mode: 0o755 }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('输出目录已存在，请使用新的发布目录。'); throw error; }
    if (!options.skipBuild) {
        const python = await build(options.checkout, options.python);
        await run(python, ['scripts/build_ppt_master.py', '--checkout', path.resolve(options.checkout), '--tag', imageName]);
    }
    const inspected = JSON.parse((await run('docker', ['image', 'inspect', imageName])).stdout)[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(inspected.Id) || inspected.Os !== 'linux' || inspected.Architecture !== 'amd64') throw new Error('当前交付基线需要Linux/amd64镜像，且必须具有完整镜像ID。');
    const spec = normalizeDefinition({ image: inspected.Id, command, limits: { memoryMb: 1536, cpu: 1, timeoutMs: 120000 } });
    const health = JSON.parse((await run('docker', buildWorkerDockerArguments(spec, { containerName: 'pivot-ppt-release-' + crypto.randomUUID().replace(/-/g, '') }), { input: JSON.stringify({ action: 'health' }) })).stdout || '{}');
    return { output, signingKey, inspected, health };
}
async function completeRelease(options, state) {
    const { output, signingKey, inspected, health } = state, lock = require('../../config/ppt-master-engine.json');
    if (!health.ok || health.revision !== lock.revision || health.result?.status !== 'ready' || health.result.contentDigest !== lock.contentDigest || health.result.offlineNativeProtocol !== 1) throw new Error('实际镜像未通过当前版本完整性和原稿协议检查。');
    const key = await keyFor(signingKey), publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
    const api = (await run('docker', ['version', '--format', '{{.Server.APIVersion}}'])).stdout.trim().split('.').map(Number);
    const platformArgs = api[0] > 1 || api[0] === 1 && api[1] >= 48 ? ['--platform', 'linux/amd64'] : [];
    await run('docker', ['image', 'save', ...platformArgs, '--output', path.join(output, 'ppt-master.tar'), inspected.Id], { timeout: 600000 });
    const identity = JSON.parse((await run(options.python || (process.platform === 'win32' ? 'python' : 'python3'), ['scripts/lib/ppt_image_identity.py', path.join(output, 'ppt-master.tar')])).stdout);
    if (!/^sha256:[a-f0-9]{64}$/.test(identity.configId) || identity.os !== inspected.Os || identity.architecture !== inspected.Architecture) throw new Error('镜像导出包与实际镜像平台不一致。');
    const worker = sign({ version: 1, images: [...new Set([inspected.Id, identity.configId])].map(image => ({ image, commands: [command.join(',')] })) }, key);
    await fs.writeFile(path.join(output, 'worker-trust.json'), JSON.stringify(worker, null, 2) + '\n', { flag: 'wx' });
    await fs.writeFile(path.join(output, 'publisher-public.pem'), publicKey, { flag: 'wx' });
    const files = [];
    for (const name of ['ppt-master.tar', 'worker-trust.json']) files.push({ name, bytes: (await fs.stat(path.join(output, name))).size, sha256: await digestFile(path.join(output, name)) });
    const manifest = sign({ schemaVersion: 1, releaseId: crypto.randomUUID().replace(/-/g, ''), createdAt: new Date().toISOString(), deploymentProtocol: 1,
        pivotVersion: require('../../package.json').version, image: { id: inspected.Id, configId: identity.configId, sourceTag: options.image || defaultImage(), os: inspected.Os, architecture: inspected.Architecture },
        engine: { revision: lock.revision, contentDigest: lock.contentDigest, protocolVersion: lock.protocolVersion, skillVersion: lock.skillVersion }, files }, key);
    await fs.writeFile(path.join(output, 'release.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    await fs.copyFile(path.join(ROOT, 'docs/deployment/PPT引擎一键离线更新.md'), path.join(output, '安装说明.md'));
    return { output, imageId: inspected.Id, publisherFingerprint: crypto.createHash('sha256').update(crypto.createPublicKey(key).export({ format: 'der', type: 'spki' })).digest('hex') };
}
module.exports = { run, sign, keyFor, release, completeRelease };
