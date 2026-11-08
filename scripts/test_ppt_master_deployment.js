'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./lib/ppt_master_release');
async function main() {
    const [appImage, first, second, postgresImage] = process.argv.slice(2);
    if (!appImage || !first || !second || !postgresImage) throw new Error('请提供验收应用镜像、两个独立签名发布包和本机PostgreSQL测试镜像。');
    const suffix = crypto.randomBytes(6).toString('hex'), name = 'ppt-deploy-' + suffix, network = name, volume = name, pgVolume = name + '-pg', pg = name + '-postgres', api = name + '-api', operator = name + '-operator';
    const evidence = path.resolve('artifacts/ppt-deployment-acceptance', suffix); await fs.mkdir(evidence, { recursive: true });
    const containers = [], volumes = []; let connected = false;
    const docker = args => run('docker', args, { timeout: 120000 });
    const cli = 'docker:29.9.3-cli@sha256:b0d99f37f463c88cae2082083f705210296186c06632d22f6952ed43506ae520';
    try {
        const helper = (await docker(['create', '--pull', 'never', cli])).stdout.trim(); containers.push(helper);
        await docker(['cp', helper + ':/usr/local/libexec/docker/cli-plugins/docker-compose', path.join(evidence, 'docker-compose')]);
        await docker(['network', 'create', '--internal', network]); connected = true;
        for (const item of [volume, pgVolume]) { await docker(['volume', 'create', item]); volumes.push(item); }
        const mount = (await docker(['volume', 'inspect', volume, '--format', '{{.Mountpoint}}'])).stdout.trim();
        if (mount !== '/var/lib/docker/volumes/' + name + '/_data') throw new Error('隔离卷路径核对失败。');
        await docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0:0', '--mount', `type=volume,src=${pgVolume},dst=/postgres`, '--entrypoint', 'node', appImage, '-e', "require('fs').chownSync('/postgres',1000,1000)"]);
        const entry = "const cp=require('node:child_process'),fs=require('node:fs');let r=cp.spawnSync('initdb',['-D','/pg/db','-U','pivot_test','--auth=trust','--no-sync'],{stdio:'inherit'});if(r.status)process.exit(r.status);fs.appendFileSync('/pg/db/pg_hba.conf','\\nhost all pivot_test 0.0.0.0/0 trust\\n');const child=cp.spawn('postgres',['-D','/pg/db','-h','0.0.0.0','-c','unix_socket_directories=/tmp','-c','max_locks_per_transaction=512'],{stdio:'inherit'});process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',c=>process.exit(c||0))";
        await docker(['run', '-d', '--name', pg, '--pull', 'never', '--network', network, '--network-alias', 'postgres', '--user', '1000:1000', '--mount', `type=volume,src=${pgVolume},dst=/pg`, '--entrypoint', 'node', postgresImage, '-e', entry]); containers.push(pg);
        for (let attempt = 0; attempt < 50; attempt++) {
            const ready = await docker(['exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'pivot_test']).then(() => true, () => false);
            if (ready) break; if (attempt === 49) throw new Error('隔离PostgreSQL尚未就绪。'); await new Promise(resolve => setTimeout(resolve, 500));
        }
        containers.push(operator, api);
        const args = ['run', '--name', operator, '--pull', 'never', '--network', network, '--user', '0:0', '--mount', `type=volume,src=${volume},dst=${mount}`,
            '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock', '--mount', `type=bind,src=${path.resolve('.')},dst=/source,readonly`,
            '--mount', `type=bind,src=${path.resolve(first)},dst=/release-first,readonly`, '--mount', `type=bind,src=${path.resolve(second)},dst=/release-second,readonly`,
            '--mount', `type=bind,src=${path.join(evidence, 'docker-compose')},dst=/usr/local/libexec/docker/cli-plugins/docker-compose,readonly`,
            '--entrypoint', 'python3', appImage, '/source/scripts/test_support/ppt_deployment_operator.py', mount + '/deploy', appImage, network, api, '/release-first', '/release-second'];
        let result;
        try { result = await run('docker', args, { timeout: 1200000 }); }
        catch (error) { await fs.writeFile(path.join(evidence, 'operator.log'), String(error.stdout || '') + String(error.stderr || '')); throw error; }
        await fs.writeFile(path.join(evidence, 'operator.log'), result.stdout + result.stderr);
        await docker(['cp', operator + ':' + mount + '/deployment-report.json', path.join(evidence, 'report.json')]);
        process.stdout.write('实际隔离部署、升级、故障回退与中断恢复通过，证据：' + evidence + '\n');
    } finally {
        for (const container of [...containers].reverse()) { await docker(['logs', container]).then(value => fs.writeFile(path.join(evidence, container + '.log'), value.stdout + value.stderr), () => {}); await docker(['rm', '-f', container]).catch(() => {}); }
        for (const item of volumes) await docker(['volume', 'rm', item]).catch(() => {});
        if (connected) await docker(['network', 'rm', network]).catch(() => {});
    }
}
if (require.main === module) main().catch(error => { process.stderr.write('隔离部署验收失败：' + error.message + '\n'); process.exitCode = 1; });
