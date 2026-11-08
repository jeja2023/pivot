'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { queryOne, execute } = require('../server/db/client');
const { fixture, checked } = require('../scripts/test_support/bi_modeling');
const objects = require('../server/services/data-analysis/bi/objects');
const objectRepository = require('../server/repositories/analysis-objects');
const jobs = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');

function child(input) {
    const process = fork(path.resolve(__dirname, '../scripts/test_support/bi_fault_child.js'), [JSON.stringify(input)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    process.stdout.on('data', () => {}); process.stderr.on('data', chunk => { if (output.length < 4000) output += chunk; });
    const exited = new Promise(resolve => process.once('exit', resolve));
    const message = () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { process.removeListener('message', receive); reject(new Error('故障子进程阶段等待超时')); }, 20000);
        const receive = value => { clearTimeout(timer); if (value.failure) reject(new Error(`故障子进程失败：${value.failure} ${output}`)); else resolve(value); };
        process.once('message', receive);
    });
    return { process, message, stop: async () => { if (process.exitCode === null) process.kill('SIGKILL'); await exited; } };
}

test('真实进程终止覆盖半写、暂存、登记、持久提升与就绪后响应丢失，重试不产生虚假对象', { timeout: 90000 }, async () => fixture(async ({ user }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-bi-fault-'));
    try {
        for (const phase of ['partial_write', 'temp_written', 'object_staged', 'file_promoted', 'object_ready']) {
            const file = path.join(directory, `${phase}.bin`), bytes = Buffer.from(`故障场景原始数据：${phase}\r\n100.25`);
            await fs.writeFile(file, bytes);
            const digest = crypto.createHash('sha256').update(bytes).digest('hex');
            const worker = child({ mode: 'object', userId: user.id, file, phase });
            try { assert.equal((await worker.message()).phase, phase); }
            finally { await worker.stop(); }
            const row = await queryOne('SELECT * FROM analysis_data_objects WHERE user_id=? AND digest=?', [user.id, digest]);
            if (['partial_write', 'temp_written'].includes(phase)) assert.equal(row, null);
            else {
                assert.equal(row.state, phase === 'object_ready' ? 'ready' : 'staging');
                const physical = await objects.store.statStorageFile(row.storage_key);
                assert.equal(physical.exists, phase !== 'object_staged');
                assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_source_manifest_members WHERE object_id=?', [row.id])).n), 0);
            }
            const recovered = await objects.importFile({ file, userId: user.id });
            assert.equal(recovered.state, 'ready');
            assert.deepEqual(await fs.readFile(await objects.verify(recovered)), bytes);
            if (row) assert.equal(recovered.id, row.id);
        }
        const temporary = path.join(objects.store.casRoot(), objects.store.TEMP_DIR_NAME);
        const parts = (await fs.readdir(temporary)).filter(name => /^\d+-\d+-\d+\.part$/.test(name));
        assert.ok(parts.length >= 2);
        for (const name of parts) await fs.utimes(path.join(temporary, name), new Date(0), new Date(0));
        assert.ok((await objects.store.sweepTemporaryFiles()).removed >= 2);
        assert.equal((await fs.readdir(temporary)).filter(name => /^\d+-\d+-\d+\.part$/.test(name)).length, 0);
    } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    }
}));

test('发布提交后进程失联，同一请求重放只有一个版本、数据绑定和发布审计', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    const report = await checked(user, model);
    const request = { user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } };
    const worker = child({ mode: 'publish', request });
    try { assert.equal((await worker.message()).phase, 'committed'); }
    finally { await worker.stop(); }
    const replay = await jobs.publishModel(request);
    assert.equal(replay.version, 1);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_data_model_versions WHERE model_id=?', [model.id])).n), 1);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_model_data_bindings WHERE model_id=?', [model.id])).n), 1);
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE model_id=? AND action='model_published'", [model.id])).n), 1);
}));

test('暂停进程超过租约后由新代次接管，旧进程恢复不能续租、提交或新增成功审计', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    const created = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    const worker = child({ mode: 'lease', jobId: created.job.id });
    try {
        const before = await worker.message(); assert.equal(before.phase, 'claimed');
        await execute("UPDATE analysis_query_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=?", [created.job.id]);
        await execute("UPDATE analysis_runtime_slots SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE job_id=?", [created.job.id]);
        await runner.processModelJobs();
        await execute('UPDATE analysis_query_jobs SET next_run_at=NOW() WHERE id=?', [created.job.id]);
        await runner.processModelJobs();
        const current = await queryOne('SELECT * FROM analysis_query_jobs WHERE id=?', [created.job.id]);
        assert.equal(current.status, 'succeeded'); assert.equal(Number(current.execution_epoch), Number(before.epoch) + 1);
        const successBefore = Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE run_id=? AND action='model_checked'", [created.job.id])).n);
        const resumed = worker.message(); worker.process.send({ resume: true });
        assert.deepEqual(await resumed, { phase: 'old_resumed', renewed: false, completed: false });
        assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE run_id=? AND action='model_checked'", [created.job.id])).n), successBefore);
        assert.equal(successBefore, 1);
        assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots WHERE job_id=?', [created.job.id])).n), 0);
    } finally { await worker.stop(); }
}));

test('文件丢失、符号链接和空间限额均不能成为就绪来源', { timeout: 60000 }, async () => fixture(async ({ user }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-bi-filesystem-'));
    try {
        const file = path.join(directory, 'source.bin'); await fs.writeFile(file, Buffer.alloc(1024, 'q'));
        await assert.rejects(objects.importFile({ file, userId: user.id, maxBytes: 512 }), error => error.code === 'ANALYSIS_OBJECT_TOO_LARGE');
        const row = await objects.importFile({ file, userId: user.id });
        const location = objects.store.resolveStoragePath(row.storage_key);
        await fs.unlink(location);
        await assert.rejects(objects.verify(row), error => error.code === 'ANALYSIS_OBJECT_CORRUPTED');
        assert.equal((await objectRepository.get(row.id)).state, 'quarantined');
        const parent = path.dirname(location), outside = path.join(directory, 'outside'); await fs.mkdir(outside);
        await fs.rmdir(parent); await fs.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
        try {
            await fs.writeFile(path.join(outside, row.digest), Buffer.alloc(1024, 'q'));
            await assert.rejects(objects.verify({ ...row, state: 'ready' }), error => error.code === 'ANALYSIS_OBJECT_CORRUPTED');
            await assert.rejects(objects.store.promoteTempToStorage(await objects.store.writeBufferToTemp(Buffer.from('越界拒绝')), row.storage_key), error => error.code === 'ANALYSIS_OBJECT_STORAGE_INVALID');
        } finally { await fs.unlink(parent); }
    } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    }
}));

test('旧版本领取 SQL 无法更新正式任务，新执行器凭代次与租约领取；数据库连接中断回滚成功提交', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    const created = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    // 与 v0.7.108 的领取更新保持一致，验证数据库本身拒绝旧执行器而非只依赖新代码过滤。
    await assert.rejects(execute("UPDATE analysis_query_jobs SET status='running',progress=5,attempts=attempts+1,locked_at=NOW(),started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=?", [created.job.id]), error => error.code === 'P0001');
    assert.equal((await queryOne('SELECT status FROM analysis_query_jobs WHERE id=?', [created.job.id])).status, 'queued');
    assert.equal(await require('../server/repositories/analysis-query-jobs').claim(30000), null);
    const repository = require('../server/repositories/analysis-model-jobs');
    const claimed = await repository.claim({ owner: 'connection_fault' });
    assert.equal(claimed.id, created.job.id);
    await assert.rejects(repository.complete(claimed, { report: { passed: true, complete: true }, authorize: async trx => {
        const backend = await trx.queryOne('SELECT pg_backend_pid() AS id');
        await execute('SELECT pg_terminate_backend(?)', [backend.id]);
        await trx.queryOne('SELECT 1');
    } }));
    assert.equal((await queryOne('SELECT status FROM analysis_query_jobs WHERE id=?', [claimed.id])).status, 'running');
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE run_id=? AND action='model_checked'", [claimed.id])).n), 0);
    await repository.fail(claimed, { code: 'ANALYSIS_MODEL_EXECUTOR_LOST', message: '数据库连接中断演练。', retryable: true });
    assert.equal((await queryOne('SELECT status FROM analysis_query_jobs WHERE id=?', [claimed.id])).status, 'retry_wait');
    await execute('UPDATE analysis_query_jobs SET next_run_at=NOW() WHERE id=?', [claimed.id]);
    await runner.processModelJobs();
    assert.equal((await jobs.getModelCheck(user, model.id, created.check.id)).status, 'passed');
}));

test('发布和查询同时提交时运行固定原发布快照，完成与取消按事务顺序只登记一个终态', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    const first = await checked(user, model);
    await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: first.id, requestKey: crypto.randomUUID() } });
    model = await require('../server/services/data-analysis/bi/models').saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version,
        definition: { ...model.definition, metrics: model.definition.metrics.map(metric => metric.id === 'amount' ? { ...metric, type: 'max' } : metric) } } });
    const second = await checked(user, model);
    const [version, run] = await Promise.all([
        jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: second.id, requestKey: crypto.randomUUID() } }),
        jobs.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: [], metrics: ['amount'], requestKey: crypto.randomUUID() } })
    ]);
    assert.equal(version.version, 2);
    await runner.processModelJobs();
    assert.equal((await jobs.getModelJob(user, run.id)).result.total.values.amount.value, '250.00');
    const latest = await jobs.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 2, dimensions: [], metrics: ['amount'], requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    assert.equal((await jobs.getModelJob(user, latest.id)).result.total.values.amount.value, '100.25');
    const repository = require('../server/repositories/analysis-model-jobs');
    let seed = 0x21c01;
    for (let index = 0; index < 12; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const created = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
        const claim = await repository.claim({ owner: `cancel_race_${seed}` });
        assert.equal(claim.id, created.job.id);
        await repository.attachManifest(claim, second.manifestId);
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
        const [completed] = await Promise.all([
            pause(seed % 5).then(() => repository.complete(claim, { report: { passed: true, complete: true, fullScan: true }, authorize: jobs.authorize(user, model.id, model.definition, { all: true }) })),
            pause((seed >>> 8) % 5).then(() => repository.cancel(user.id, claim.id))
        ]);
        if (!completed) await repository.fail(claim, { code: 'ANALYSIS_MODEL_QUERY_CANCELLED', message: '取消与完成并发演练。' });
        await repository.releaseSlot(claim);
        const final = await queryOne('SELECT status,cancel_requested_at FROM analysis_query_jobs WHERE id=?', [claim.id]);
        assert.equal(final.status, completed ? 'succeeded' : 'cancelled', `seed=${seed}`);
        assert.equal(Boolean(final.cancel_requested_at), !completed);
        assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE run_id=? AND action='model_checked'", [claim.id])).n), completed ? 1 : 0);
    }
}));
