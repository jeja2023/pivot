'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { fixture, checked } = require('../scripts/test_support/bi_modeling');
const { queryOne, execute } = require('../server/db/client');
const runtime = require('../server/services/data-analysis/bi/runtime');
const readiness = require('../server/services/data-analysis/bi/readiness');
const jobs = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');
const { tempRoot } = require('../server/services/data-analysis/shared');
const enabled = process.env.PIVOT_TEST_ANALYSIS_CONTAINER_ACCEPTANCE === 'true';
if (enabled) {
    assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0); assert.ok(process.getgid() > 0);
    assert.match(process.env.PIVOT_TEST_ANALYSIS_DOCKER_IMAGE || '', /^sha256:[a-f0-9]{64}$/);
    process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'docker';
    process.env.DATA_ANALYSIS_MODEL_WORKER_IMAGE = process.env.PIVOT_TEST_ANALYSIS_DOCKER_IMAGE;
}

test('Linux 协调容器通过真实私有对象与同一宿主机路径验证执行器身份、只读挂载和五秒终止', { skip: !enabled, timeout: 120000 }, async () => {
    const result = await readiness.ensureReady({ force: true });
    assert.equal(result.productionPlatformSupported, true); assert.equal(result.productionIsolation, true);
    assert.equal(result.cancellation.cancelled, true); assert.ok(result.cancellation.durationMs <= 5000);
    const root = path.join(tempRoot, `coordinator-private-${crypto.randomUUID()}`);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const bytes = crypto.randomBytes(80), file = path.join(root, 'private.bin');
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    try {
        const response = await runtime.runIsolated({ job: { execution_kind: 'probe', container_id: `pivot-bi-private-${crypto.randomUUID()}` }, definition: null, query: {}, sources: {}, inputResult: file, outputRoot: path.join(root, 'output') });
        assert.equal(response.probe.inputSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
        assert.equal(response.probe.uid, process.getuid()); assert.equal(response.probe.gid, process.getgid());
        for (const key of ['inputReadable', 'inputReadOnly', 'rootReadOnly', 'noCoordinatorSocket', 'capabilitiesDropped', 'noNewPrivileges', 'networkIsolated', 'noCredentials']) assert.equal(response.probe[key], true, key);
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.equal((await fs.stat(path.join(root, 'output'))).mode & 0o777, 0o700);
        assert.deepEqual(await fs.readFile(file), bytes);
        const hiddenRoot = await fs.mkdtemp('/tmp/pivot-coordinator-only-'), hidden = path.join(hiddenRoot, 'private.bin');
        try {
            await fs.writeFile(hidden, bytes, { flag: 'wx', mode: 0o600 });
            await assert.rejects(runtime.runIsolated({ job: { execution_kind: 'probe', container_id: `pivot-bi-unshared-${crypto.randomUUID()}` }, definition: null, query: {}, sources: {}, inputResult: hidden, outputRoot: path.join(root, 'missing') }));
        } finally { assert.equal(path.dirname(hiddenRoot), '/tmp'); await fs.rm(hiddenRoot, { recursive: true, force: true }); }
        const currentPath = process.env.PATH;
        process.env.PATH = '/pivot-client-intentionally-unavailable';
        try { await assert.rejects(readiness.ensureReady({ force: true })); }
        finally { process.env.PATH = currentPath; }
        assert.equal((await readiness.ensureReady({ force: true })).ready, true);
    } finally { assert.equal(path.dirname(root), path.resolve(tempRoot)); await fs.rm(root, { recursive: true, force: true }); }
});

test('Linux API 容器经正式受限执行器完成检查、发布、刷新、统一消费和真实登录导出下载', { skip: !enabled, timeout: 240000 }, async () => fixture(async ({ user, model }) => {
    const report = await checked(user, model);
    await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
    const run = await jobs.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: ['region'], metrics: ['amount', 'orders', 'average'], requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    const result = await jobs.getModelJob(user, run.id);
    assert.equal(result.status, 'succeeded', result.lastError); assert.equal(result.result.total.values.amount.value, '250.00'); assert.equal(result.result.total.values.average.value, '125.00');
    const record = await require('../server/repositories/analysis-model-jobs').get(user.id, run.id);
    const object = await require('../server/repositories/analysis-objects').get(record.result_object_id);
    const physical = await require('../server/services/data-analysis/bi/objects').verify(object);
    assert.equal((await fs.stat(physical)).mode & 0o777, 0o600);
    const governance = require('../server/services/data-analysis/governance');
    const view = await require('../server/services/data-analysis/bi/consumers').saveModelView({ user, modelId: model.id, body: { sourceRunId: run.id, name: '容器制品固定视图', viewType: 'chart' } });
    const dashboard = await governance.saveDashboard({ user, body: { name: '容器制品看板' } });
    await governance.saveDashboardItem({ user, dashboardId: dashboard.id, body: { sourceType: 'model', savedViewId: view.id, title: '地区金额', position: { y: 0 } } });
    const rerun = await governance.runSavedView(user, view.id); await runner.processModelJobs();
    assert.equal((await jobs.getModelJob(user, rerun.job.id)).result.total.values.amount.value, '250.00');
    const before = await require('../server/repositories/analysis-model-publications').binding(model.id, 1);
    const refresh = await jobs.createModelRefresh({ user, modelId: model.id, body: { publishedVersion: 1, bindingRevision: Number(before.revision), requestKey: crypto.randomUUID() } });
    await runner.processModelJobs(); assert.equal((await jobs.getModelCheck(user, model.id, refresh.check.id)).status, 'passed');
    await execute('UPDATE users SET password_hash=? WHERE id=?', [await require('../server/services/password-hasher').hashPasswordOffThread('ContainerFixture123!', 12), user.id]);
    await require('../server/services/data-analysis/bi/security-journal').flush({ force: true });
    const server = http.createServer(require('../server/app').app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user.username, password: 'ContainerFixture123!' }) });
        assert.equal(login.status, 200, await login.text());
        const cookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
        const token = require('../server/auth').generateAccessToken(await queryOne('SELECT * FROM users WHERE id=?', [user.id]), { sessionIp: '127.0.0.1' });
        for (const [route, expected] of [[`/api/apps/data-analysis/async-queries/${run.id}/results`, '250.00'], [`/api/apps/data-analysis/views/${view.id}`, '容器制品固定视图'], [`/api/apps/data-analysis/dashboards/${dashboard.id}`, '容器制品看板']]) {
            const response = await fetch(`${base}${route}`, { headers: { cookie } }); const text = await response.text();
            assert.equal(response.status, 200, text); assert.ok(text.includes(expected));
        }
        for (const format of ['csv', 'xlsx']) {
            const exported = await require('../server/services/data-analysis/bi/results').createModelExport({ user, jobId: run.id, body: { format, requestKey: crypto.randomUUID() } });
            await runner.processModelJobs(); const completed = await jobs.getModelJob(user, exported.id); assert.equal(completed.status, 'succeeded', completed.lastError);
            const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
            const ticketResponse = await fetch(`${base}/api/apps/data-analysis/async-queries/${exported.id}/download-token`, { method: 'POST', headers, body: '{}' });
            assert.equal(ticketResponse.status, 200, await ticketResponse.clone().text()); const ticket = await ticketResponse.json();
            const download = await fetch(`${base}/api/apps/data-analysis/async-queries/${exported.id}/export-content`, { headers: { ...headers, 'x-analysis-download-token': ticket.token } });
            assert.equal(download.status, 200, await download.clone().text()); const bytes = Buffer.from(await download.arrayBuffer());
            const text = format === 'csv' ? bytes.toString('utf8') : JSON.stringify(require('@e965/xlsx').read(bytes, { type: 'buffer' }).Sheets);
            assert.ok(text.includes('250.00')); assert.ok(text.includes('125.00'));
        }
    } finally {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        await require('../server/services/db-write-queue').flushAllWrites();
        await execute('DELETE FROM audit_logs WHERE user_id=?', [user.id]);
    }
    assert.deepEqual((await runtime.currentModelExecutors()).running, []);
}));
