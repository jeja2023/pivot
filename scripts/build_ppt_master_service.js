'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./lib/ppt_master_release');
async function main(args = process.argv.slice(2)) {
    const settings = {};
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--skip-build') { settings.skipBuild = true; continue; }
        const key = { '--checkout': 'checkout', '--output': 'output', '--image': 'image', '--python': 'python' }[args[index]];
        if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('请使用--checkout、--output、--image、--python或--skip-build。');
        settings[key] = args[++index];
    }
    if (!settings.output || !settings.skipBuild && !settings.checkout) throw new Error('请指定新的--output目录，构建时同时指定--checkout固定上游仓库。');
    const output = path.resolve(settings.output), image = settings.image || 'ppt-master:' + require('../config/ppt-master-engine.json').skillVersion;
    if (!/^[a-z0-9][a-z0-9./:_-]{1,240}(?:@sha256:[a-f0-9]{64})?$/.test(image)) throw new Error('请使用有效的本机镜像名称。');
    const python = settings.python || (process.platform === 'win32' ? 'python' : 'python3');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.mkdir(output);
    if (!settings.skipBuild) {
        const manifest = await fs.readFile('artifacts/ppt-master-runtime/manifest.json', 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        if (!manifest) await run(python, ['scripts/prepare_ppt_master.py', '--checkout', path.resolve(settings.checkout)]);
        await run(python, ['scripts/build_ppt_master.py', '--checkout', path.resolve(settings.checkout), '--tag', image]);
    }
    const metadata = JSON.parse((await run('docker', ['image', 'inspect', image])).stdout)[0];
    if (metadata.Os !== 'linux' || metadata.Architecture !== 'amd64') throw new Error('当前离线交付基线为Linux/amd64，请使用匹配架构的镜像。');
    const name = 'ppt-service-build-' + crypto.randomBytes(10).toString('hex'), token = crypto.randomBytes(32).toString('hex');
    try {
        await run('docker', ['run', '-d', '--pull', 'never', '--name', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65532:65532',
            '--tmpfs', '/tmp:size=512m,mode=1777', '--tmpfs', '/data:size=512m,mode=0700,uid=65532,gid=65532', '--env', 'PPT_MASTER_TOKEN=' + token, image]);
        let ready = false;
        for (let attempt = 0; attempt < 180; attempt++) {
            const result = await run('docker', ['exec', name, 'python', '-c', "import urllib.request,json;assert json.load(urllib.request.urlopen('http://127.0.0.1:8502/healthz',timeout=2))['ready']"]).then(() => true, () => false);
            if (result) { ready = true; break; }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!ready) throw new Error('独立PPT服务启动检查未通过，请检查镜像日志。');
    } finally { await run('docker', ['rm', '-f', '-v', name]).catch(() => {}); }
    const api = (await run('docker', ['version', '--format', '{{.Server.APIVersion}}'])).stdout.trim().split('.').map(Number);
    await run('docker', ['image', 'save', ...(api[0] > 1 || api[1] >= 48 ? ['--platform', 'linux/amd64'] : []), '-o', path.join(output, 'ppt-master.tar'), image], { timeout: 600000 });
    await fs.copyFile('docker-compose.ppt-master.yml', path.join(output, 'docker-compose.ppt-master.yml'));
    await fs.copyFile('docs/deployment/PPTMaster独立服务部署与更新.md', path.join(output, '部署说明.md'));
    const compose = await fs.readFile(path.join(output, 'docker-compose.ppt-master.yml'), 'utf8');
    await fs.writeFile(path.join(output, 'docker-compose.ppt-master.yml'), compose.replace('${PPT_MASTER_IMAGE:-ppt-master:6.8.0}', '${PPT_MASTER_IMAGE:-' + image + '}'));
    const example = 'PPT_MASTER_IMAGE=' + image + '\nPPT_MASTER_TOKEN=首次配置一个至少32位的访问密钥\n';
    await fs.writeFile(path.join(output, '.env.example'), example);
    await fs.writeFile(path.join(output, 'image.json'), JSON.stringify({ image, id: metadata.Id, os: metadata.Os, architecture: metadata.Architecture, serviceProtocol: 1 }, null, 2) + '\n');
    process.stdout.write('独立PPT服务镜像和部署文件已生成：' + output + '\n');
}
if (require.main === module) main().catch(error => { process.stderr.write('独立PPT服务构建失败：' + error.message + '\n'); process.exitCode = 1; });
module.exports = { main };
