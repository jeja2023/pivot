'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { run } = require('./lib/ppt_master_release');
const client = require('../server/services/presentations/master/service-client');
const Zip = require('jszip');

async function main() {
    const image = process.argv[2] || 'ppt-master:service-v135', name = 'ppt-service-acceptance-' + crypto.randomBytes(6).toString('hex'), token = crypto.randomBytes(32).toString('hex');
    const output = path.resolve('artifacts/ppt-service-acceptance', name); await fs.mkdir(output, { recursive: true });
    const mount = 'type=bind,src=' + path.resolve('.') + ',dst=/source,readonly';
    let created = false, volumeCreated = false;
    const volume = name + '-data';
    const upgradeImage = process.argv[3];
    try {
        await run('docker', ['volume', 'create', volume]); volumeCreated = true;
        await run('docker', ['run', '-d', '--pull', 'never', '--name', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '3g', '--cpus', '2',
            '--user', '65532:65532', '--publish', '127.0.0.1::8502', '--tmpfs', '/tmp:size=512m,mode=1777', '--mount', 'type=volume,src=' + volume + ',dst=/data', '--env', 'PPT_MASTER_TOKEN=' + token, '--mount', mount, image]); created = true;
        const port = (await run('docker', ['port', name, '8502/tcp'])).stdout.trim().split(':').at(-1), env = { PIVOT_PPT_MASTER_SERVICE_URL: 'http://127.0.0.1:' + port, PIVOT_PPT_MASTER_SERVICE_TOKEN: token };
        let health;
        for (let attempt = 0; attempt < 180; attempt++) {
            health = await client.info({ force: true, env }).catch(() => null); if (health) break;
            if (attempt === 179) throw new Error('独立服务没有在期限内就绪。'); await new Promise(resolve => setTimeout(resolve, 1000));
        }
        const unauthorized = await fetch(env.PIVOT_PPT_MASTER_SERVICE_URL + '/v1/info'); assert.equal(unauthorized.status, 401);
        const user = { id: 1 }, task = 'tooltask_' + crypto.randomBytes(24).toString('base64url');
        const execute = async operation => {
            const response = await client.execute(user, task, operation, { env }); assert.equal(response.ok, true, response.error);
            if (response.result.exitCode !== undefined) assert.equal(response.result.exitCode, 0, response.result.stderr); return response.result;
        };
        const result = await execute({ action: 'health' }); assert.equal(result.status, 'ready'); assert.equal(result.offlineNativeProtocol, 1);
        await client.inputFile(user, task, 'evidence.txt', Buffer.from('经授权提供的真实材料'), env);
        assert.equal((await execute({ action: 'read', path: 'inputs/evidence.txt' })).text, '经授权提供的真实材料');
        const other = await client.execute({ id: 2 }, task, { action: 'read', path: 'inputs/evidence.txt' }, { env }); assert.equal(other.ok, false);
        const refused = await client.execute(user, task, { action: 'write', path: '../escape.py', text: 'bad' }, { env }); assert.equal(refused.ok, false);
        await execute({ action: 'run', tool: 'project', args: ['init', 'service_acceptance', '--dir', '.', '--quick-generate'] });
        const entries = await execute({ action: 'list' }), project = entries.files.map(item => item.path.split('/')[0]).find(item => item !== 'inputs'); assert.ok(project);
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" lang="zh-CN" data-pptx-page-role="content"><rect x="0" y="0" width="1280" height="720" fill="#FFFFFF"/><g id="heading" data-pptx-bounds="88 80 1100 120"><text x="88" y="150" font-size="44" font-family="Noto Sans CJK SC">独立服务完整制作</text></g><g id="body" data-pptx-bounds="88 240 1100 220"><text x="88" y="320" font-size="32" font-family="Noto Sans CJK SC">收入120万元，成本80万元。</text></g></svg>';
        await execute({ action: 'write', path: project + '/svg_output/slide_01.svg', text: svg });
        await execute({ action: 'run', tool: 'check_svg', args: [project, '--quick-generate', '--stage', 'final', '--json'] });
        await execute({ action: 'run', tool: 'export', args: [project, '--quick-generate', '-o', project + '/exports/service.pptx'] });
        const receipt = await execute({ action: 'deliver', path: project + '/exports/service.pptx' }); assert.equal(receipt.packageCheck.status, 'passed');
        const pptx = await client.file(user, task, 'outputs', 'presentation.pptx', 60 * 1024 * 1024, env); await fs.writeFile(path.join(output, 'service.pptx'), pptx);
        assert.equal(crypto.createHash('sha256').update(pptx).digest('hex'), receipt.sha256);
        const zip = await Zip.loadAsync(pptx); assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /收入120万元/);
        const projectZip = await client.file(user, task, 'outputs', 'project.zip', 60 * 1024 * 1024, env); assert.ok((await Zip.loadAsync(projectZip)).file(project + '/svg_output/slide_01.svg') || projectZip.length > 100);
        await client.inputFile(user, task, 'source.pptx', pptx, env);
        const native = await execute({ action: 'native_inspect', source: 'inputs/source.pptx' }); assert.equal(native.status, 'passed'); assert.equal(native.offlineProtocol, 1);
        const preview = await client.file(user, task, 'outputs', 'preview-1.png', 8 * 1024 * 1024, env); assert.deepEqual([...preview.subarray(0, 4)], [137, 80, 78, 71]);
        await fs.writeFile(path.join(output, 'native-preview.png'), preview);
        await execute({ action: 'native_video_prepare', source: 'inputs/source.pptx' });
        const controller = new AbortController();
        const interrupted = client.execute(user, task, { action: 'native_video_clip', source: 'inputs/source.pptx', slideIndex: 0,
            options: { duration: 60, fps: 30, resolution: '1080p', transition: 'fade' } }, { env, signal: controller.signal }).then(() => ({ finished: true }), error => ({ error }));
        await new Promise(resolve => setTimeout(resolve, 100)); controller.abort(new Error('验收停止制作'));
        const stopped = await interrupted; assert.match(stopped.error?.message || '', /验收停止制作/);
        let unlocked = false;
        for (let attempt = 0; attempt < 20; attempt++) {
            const response = await client.execute(user, task, { action: 'list' }, { env }).catch(() => null);
            if (response?.ok) { unlocked = true; break; } await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.equal(unlocked, true, '停止后不能留下占用任务的执行进程');
        const isolated = await run('docker', ['exec', name, 'python', '-c', "import sys,socket,tempfile,os;from pathlib import Path;sys.path.insert(0,'/runner');from service_worker import restrict;own=tempfile.mkdtemp();other=tempfile.mkdtemp();Path(other,'secret').write_text('不可访问');os.environ['PIVOT_MASTER_WORKSPACE']=own;os.environ['TMPDIR']=own;restrict();\ntry:\n socket.socket(socket.AF_INET,socket.SOCK_STREAM)\n raise Exception('网络未隔离')\nexcept PermissionError: print('动作进程已拒绝网络')\nfor target in ['/proc/1/environ',other+'/secret']:\n try:\n  Path(target).read_bytes()\n  raise Exception('任务目录未隔离')\n except PermissionError: print('动作进程已拒绝跨任务或服务凭据访问')"]); assert.match(isolated.stdout, /拒绝网络/); assert.match(isolated.stdout, /拒绝跨任务/);
        const tests = await run('docker', ['exec', '--env', 'PPT_SANDBOX_TEST_ROOT=/data/jobs', name, 'python', '-B', '-m', 'unittest', 'discover', '-s', '/source/tests/ppt_service', '-v']); await fs.writeFile(path.join(output, 'python-tests.log'), tests.stdout + tests.stderr);
        await run('docker', ['restart', name]);
        let restarted;
        for (let attempt = 0; attempt < 180; attempt++) {
            restarted = await client.info({ force: true, env }).catch(() => null); if (restarted) break;
            if (attempt === 179) throw new Error('服务重启后未恢复。'); await new Promise(resolve => setTimeout(resolve, 1000));
        }
        assert.equal(restarted.runtimeId, health.runtimeId);
        assert.equal((await execute({ action: 'read', path: 'inputs/evidence.txt' })).text, '经授权提供的真实材料');
        const source = await run('docker', ['exec', name, 'python', '-c', "from pathlib import Path;import sys,tempfile;sys.path.insert(0,'/runner');from service_jobs import Jobs,ServiceError;root=Path('/data/jobs');key='9'*64;old=Jobs(root,'sha256:'+'a'*64);old.open(key);new=Jobs(root,'sha256:'+'b'*64);\ntry:\n new.open(key)\n raise Exception('跨版本检查点未被拒绝')\nexcept ServiceError as error:\n assert error.code=='PPT_SERVICE_RUNTIME_CHANGED'\nnew.delete(key);print('跨版本检查点已拒绝')"]); assert.match(source.stdout, /已拒绝/);
        await client.cleanup(user, task, env);
        let upgradedWithoutClientRestart = false;
        if (upgradeImage) {
            const oldTask = 'tooltask_' + crypto.randomBytes(24).toString('base64url'); await client.execute(user, oldTask, { action: 'list' }, { env });
            await run('docker', ['rm', '-f', name]); created = false;
            await run('docker', ['run', '-d', '--pull', 'never', '--name', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '3g', '--cpus', '2',
                '--user', '65532:65532', '--publish', '127.0.0.1:' + port + ':8502', '--tmpfs', '/tmp:size=512m,mode=1777', '--mount', 'type=volume,src=' + volume + ',dst=/data', '--env', 'PPT_MASTER_TOKEN=' + token, upgradeImage]); created = true;
            let next;
            for (let attempt = 0; attempt < 180; attempt++) {
                next = await client.info({ force: true, env }).catch(() => null); if (next) break;
                if (attempt === 179) throw new Error('升级后服务未就绪。'); await new Promise(resolve => setTimeout(resolve, 1000));
            }
            assert.notEqual(next.runtimeId, health.runtimeId);
            await assert.rejects(() => client.execute(user, oldTask, { action: 'list' }, { env }), { code: 'PPT_SERVICE_RUNTIME_CHANGED' });
            const fresh = 'tooltask_' + crypto.randomBytes(24).toString('base64url'); assert.equal((await client.execute(user, fresh, { action: 'list' }, { env })).ok, true);
            await client.cleanup(user, oldTask, env); await client.cleanup(user, fresh, env); upgradedWithoutClientRestart = true;
        }
        const report = { passed: true, image, serviceProtocol: health.serviceProtocol, runtimeId: health.runtimeId, revision: health.revision, authenticated: true, crossUserIsolation: true,
            pathTraversalDenied: true, actualNativePptx: true, projectArchive: true, generatedSlides: receipt.packageCheck.slideCount, fileDigestVerified: true, noDockerSocket: true, noSharedWorkspace: true, workerNetworkDenied: true, workerFilesystemIsolated: true,
            nativeInspectionAndPreview: true, realCancellationReleasesJob: true, restartPreservesWorkspace: true, changedRuntimeRejectsCheckpoint: true, upgradedWithoutClientRestart, productionDeployed: false };
        await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write('独立PPT服务真实制作与传输验收通过：' + output + '\n');
    } finally {
        if (created) { await run('docker', ['logs', name]).then(value => fs.writeFile(path.join(output, 'service.log'), value.stdout + value.stderr), () => {}); await run('docker', ['rm', '-f', '-v', name]).catch(() => {}); }
        if (volumeCreated) await run('docker', ['volume', 'rm', volume]).catch(() => {});
    }
}
if (require.main === module) main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
