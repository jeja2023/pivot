'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./lib/ppt_master_release');
const { digestFile } = require('../server/services/offline-backup-bundle');
const lock = require('../config/ppt-master-engine.json');

function assertServiceCapabilities(health) {
    const required = ['deliveryChecklist', 'currentExport', 'pageRepair', 'progressSnapshots', 'managedProject', 'boundedSourceBundle',
        'selectedTemplateRecovery', 'atomicInputSnapshots', 'checklistDisplayEquivalence', 'checklistGroupedValues', 'optionalSourcePackage', 'expandedChecklist'];
    const missing = required.filter(key => health[key] !== 1);
    if (health.startupHealthTimeoutSeconds !== 300) missing.push('startupHealthTimeoutSeconds');
    if (health.serviceProtocol !== 1 || !/^sha256:[a-f0-9]{64}$/.test(health.runtimeId || '') || missing.length) {
        throw new Error('镜像的协议、运行身份或执行能力未通过校验，请使用当前源码重新构建。' + (missing.length ? '缺少 ' + missing.join('、') : ''));
    }
}
async function main(args = process.argv.slice(2)) {
    const settings = {};
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--skip-build') { settings.skipBuild = true; continue; }
        const key = { '--checkout': 'checkout', '--output': 'output', '--image': 'image', '--python': 'python' }[args[index]];
        if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('请使用--checkout、--output、--image、--python或--skip-build。');
        settings[key] = args[++index];
    }
    if (!settings.output || !settings.skipBuild && !settings.checkout) throw new Error('请指定新的--output目录，构建时同时指定--checkout固定上游仓库。');
    const output = path.resolve(settings.output), image = settings.image || 'ppt-master:' + lock.skillVersion;
    if (!/^[a-z0-9][a-z0-9./:_-]{1,240}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image) || image.startsWith('sha256:')) throw new Error('独立服务交付请使用带标签的镜像名称，保证离线导入后名称保持一致。');
    const python = settings.python || (process.platform === 'win32' ? 'python' : 'python3');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.mkdir(output);
    if (!settings.skipBuild) {
        const manifest = await fs.readFile('artifacts/ppt-master-runtime/manifest.json', 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        if (!manifest) await run(python, ['scripts/prepare_ppt_master.py', '--checkout', path.resolve(settings.checkout)]);
        await run(python, ['scripts/build_ppt_master.py', '--checkout', path.resolve(settings.checkout), '--tag', image], { timeout: 2 * 60 * 60 * 1000 });
    }
    const metadata = JSON.parse((await run('docker', ['image', 'inspect', image])).stdout)[0];
    if (metadata.Os !== 'linux' || metadata.Architecture !== 'amd64') throw new Error('当前离线交付基线为Linux/amd64，请使用匹配架构的镜像。');
    const name = 'ppt-service-build-' + crypto.randomBytes(10).toString('hex'), token = crypto.randomBytes(32).toString('hex');
    let health;
    try {
        await run('docker', ['run', '-d', '--pull', 'never', '--name', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65532:65532',
            '--tmpfs', '/tmp:size=512m,mode=1777', '--tmpfs', '/data:size=512m,mode=0700,uid=65532,gid=65532', '--env', 'PPT_MASTER_TOKEN=' + token, image]);
        let ready = false;
        const readyBy = Date.now() + 330000;
        while (Date.now() < readyBy) {
            const result = await run('docker', ['exec', name, 'python', '-c', "import urllib.request,json;assert json.load(urllib.request.urlopen('http://127.0.0.1:8502/healthz',timeout=2))['ready']"]).then(() => true, () => false);
            if (result) { ready = true; break; }
            const status = await run('docker', ['inspect', '--format', '{{.State.Status}}', name]).catch(() => null);
            if (status?.stdout.trim() === 'exited' || status?.stdout.trim() === 'dead') break;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!ready) {
            const report = await run('docker', ['logs', '--tail', '20', name]).catch(() => null);
            const timedOut = /启动自检超时/.test((report?.stderr || '') + (report?.stdout || ''));
            throw new Error(timedOut ? '独立PPT服务启动自检超时，请检查磁盘读取速度及容器资源。' : '独立PPT服务启动检查未通过，请检查镜像日志。');
        }
        const readInfo = "import os,urllib.request;req=urllib.request.Request('http://127.0.0.1:8502/v1/info',headers={'Authorization':'Bearer '+os.environ['PPT_MASTER_TOKEN']});print(urllib.request.urlopen(req,timeout=2).read().decode())";
        health = JSON.parse((await run('docker', ['exec', name, 'python', '-c', readInfo])).stdout);
        if (health.revision !== lock.revision || health.version !== lock.skillVersion || health.contentDigest !== lock.contentDigest) {
            throw new Error('镜像的上游运行包与当前源码锁定信息不一致。');
        }
        assertServiceCapabilities(health);
    } finally { await run('docker', ['rm', '-f', '-v', name]).catch(() => {}); }
    const api = (await run('docker', ['version', '--format', '{{.Server.APIVersion}}'])).stdout.trim().split('.').map(Number);
    const archive = path.join(output, 'ppt-master.tar');
    await run('docker', ['image', 'save', ...(api[0] > 1 || api[1] >= 48 ? ['--platform', 'linux/amd64'] : []), '-o', archive, image], { timeout: 600000 });
    const archiveSha256 = await digestFile(archive);
    await fs.writeFile(path.join(output, 'ppt-master.tar.sha256'), archiveSha256 + '  ppt-master.tar\n');
    await fs.copyFile('docs/deployment/PPTMaster独立服务部署与更新.md', path.join(output, '部署说明.md'));
    const compose = await fs.readFile('docker-compose.ppt-master.yml', 'utf8');
    await fs.writeFile(path.join(output, 'docker-compose.ppt-master.yml'), compose.replace(/\$\{PPT_MASTER_IMAGE:-[^}]+\}/, '${PPT_MASTER_IMAGE:-' + image + '}'));
    const example = 'PPT_MASTER_IMAGE=' + image + '\nPPT_MASTER_TOKEN=首次配置一个至少32位的访问密钥\n';
    await fs.writeFile(path.join(output, '.env.example'), example);
    await fs.writeFile(path.join(output, 'service-info.json'), JSON.stringify(health, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'image.json'), JSON.stringify({
        image, id: metadata.Id, os: metadata.Os, architecture: metadata.Architecture, serviceProtocol: health.serviceProtocol,
        runtimeId: health.runtimeId, revision: health.revision, skillVersion: health.version, archiveSha256
    }, null, 2) + '\n');
    process.stdout.write('独立PPT服务镜像和部署文件已生成：' + output + '\n');
}
if (require.main === module) main().catch(error => { process.stderr.write('独立PPT服务构建失败：' + error.message + '\n'); process.exitCode = 1; });
module.exports = { main, assertServiceCapabilities };
