'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const runtime = require('../server/services/data-analysis/bi/runtime');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('真实 Linux 硬限制下 OOM、临时盘满、只读目录、不兼容和卡死进程均保持 API 存活且确认执行单元回收', { timeout: 180000, skip: !process.env.PIVOT_TEST_ANALYSIS_DOCKER_IMAGE }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-bi-runtime-fault-'));
    const tag = `pivot-bi-fault:${crypto.randomUUID()}`;
    const baseTag = `pivot-bi-fault-base:${crypto.randomUUID()}`;
    const original = { DATA_ANALYSIS_MODEL_RUNTIME: process.env.DATA_ANALYSIS_MODEL_RUNTIME, DATA_ANALYSIS_MODEL_WORKER_IMAGE: process.env.DATA_ANALYSIS_MODEL_WORKER_IMAGE };
    const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"alive":true}'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/health`;
    const docker = (args, options = {}) => execute('docker', args, { windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 ** 2, ...options });
    let imageBuilt = false;
    const containers = [];
    try {
        await docker(['image', 'tag', process.env.PIVOT_TEST_ANALYSIS_DOCKER_IMAGE, baseTag]);
        await fs.copyFile(path.resolve(__dirname, '../scripts/test_support/bi_fault_worker.js'), path.join(directory, 'fault.js'));
        await fs.writeFile(path.join(directory, 'Dockerfile'), 'ARG WORKER\nFROM ${WORKER}\nCOPY fault.js /app/bi-fault.js\nENTRYPOINT ["node","/app/bi-fault.js"]\n');
        await docker(['build', '--pull=false', '--network=none', '--build-arg', `WORKER=${baseTag}`, '-t', tag, directory]); imageBuilt = true;
        const image = (await docker(['image', 'inspect', tag, '--format', '{{.Id}}'])).stdout.trim();
        process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'docker'; process.env.DATA_ANALYSIS_MODEL_WORKER_IMAGE = image;
        for (const mode of ['oom', 'diskfull', 'readonly', 'incompatible', 'stall']) {
            const id = `pivot-bi-fault-${crypto.randomUUID()}`, outputRoot = path.join(directory, mode), controller = new AbortController();
            containers.push(id);
            const startedAt = Math.floor(Date.now() / 1000);
            let finished = false, failure = null, checks = 0;
            const running = runtime.runIsolated({ job: { execution_kind: 'model_query', container_id: id }, definition: null, query: { fault: mode }, sources: {}, outputRoot, signal: controller.signal })
                .then(() => { throw new Error('故障执行器不能产生成功结果'); }).catch(error => { failure = error; }).finally(() => { finished = true; });
            const deadline = setTimeout(() => controller.abort(), 60000);
            try {
                if (mode === 'stall') {
                    const until = Date.now() + 10000;
                    while (!finished && Date.now() < until) {
                        if (await fs.access(path.join(outputRoot, 'stall-ready')).then(() => true, () => false)) break;
                        await delay(30);
                    }
                    assert.equal(finished, false);
                    await docker(['pause', id]);
                    controller.abort();
                }
                while (!finished) {
                    const response = await fetch(url); assert.equal(response.status, 200); assert.equal((await response.json()).alive, true); checks++;
                    await delay(50);
                }
                await running;
            } finally { clearTimeout(deadline); if (!finished) { controller.abort(); await running; } }
            const expected = mode === 'oom' ? 'ANALYSIS_MODEL_EXECUTOR_LOST' : mode === 'incompatible' ? 'ANALYSIS_MODEL_EXECUTOR_INCOMPATIBLE' : mode === 'stall' ? 'ANALYSIS_MODEL_QUERY_CANCELLED' : 'ANALYSIS_MODEL_STORAGE_PRESSURE';
            const progress = mode === 'oom' ? await fs.readFile(path.join(outputRoot, 'oom-progress.json'), 'utf8').catch(() => null) : null;
            console.log(`执行隔离故障阶段：${JSON.stringify({ mode, code: failure?.code, message: failure?.message, progress })}`);
            assert.equal(failure?.code, expected, `${mode}: ${failure?.message}`);
            if (mode === 'oom') {
                const events = await docker(['events', '--since', String(startedAt), '--until', String(Math.ceil(Date.now() / 1000)), '--filter', `container=${id}`, '--format', '{{.Action}}']);
                assert.ok(events.stdout.split(/\r?\n/).includes('oom'), events.stdout);
            }
            assert.equal((await docker(['ps', '-a', '--filter', `name=^/${id}$`, '--format', '{{.ID}}'])).stdout.trim(), '');
            assert.equal((await fetch(url)).status, 200);
            console.log(`执行隔离故障证据：${JSON.stringify({ mode, errorCode: failure.code, healthChecks: checks, elapsedMs: Date.now() - startedAt * 1000, containerRemoved: true })}`);
        }
    } finally {
        for (const [name, value] of Object.entries(original)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        for (const id of containers) await docker(['rm', '-f', id]).catch(error => { if (!/No such container|not found|不存在/i.test(String(error.stderr))) throw error; });
        if (imageBuilt) await docker(['image', 'rm', tag]);
        await docker(['image', 'rm', baseTag]);
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
