'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { query, queryOne, execute, transaction } = require('../server/db/client');
const budget = require('../server/repositories/analysis-runtime-budget');
const { withAnalysisSlot } = require('../server/services/data-analysis/shared');

async function fixture(run) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const users = [];
    try {
        for (let index = 0; index < 7; index++) users.push(await queryOne("INSERT INTO users(username,password_hash,status) VALUES (?,'hash','active') RETURNING id", [`budget_${crypto.randomUUID()}`]));
        await run(users);
    } finally {
        for (const user of users) {
            await execute('UPDATE analysis_runtime_slots SET job_id=NULL,lease_expires_at=NULL WHERE job_id IN (SELECT id FROM analysis_query_jobs WHERE user_id=?)', [user.id]);
            await execute('DELETE FROM analysis_query_jobs WHERE user_id=?', [user.id]);
            await execute('DELETE FROM analysis_data_model_checks WHERE user_id=?', [user.id]);
            await execute('DELETE FROM analysis_audit_events WHERE user_id=?', [user.id]);
            await execute('DELETE FROM analysis_data_models WHERE user_id=?', [user.id]);
            await execute('DELETE FROM users WHERE id=?', [user.id]);
        }
    }
}

const claim = (options = {}) => transaction(trx => budget.claim(trx, { owner: 'test-supervisor', kinds: ['legacy_operation'], ...options }));

async function queueCheck(user) {
    const model = await queryOne("INSERT INTO analysis_data_models(id,user_id,name) VALUES (?,?,'调度测试') RETURNING *", [`budget_model_${crypto.randomUUID()}`, user.id]);
    return require('../server/repositories/analysis-model-jobs').admit({ userId: user.id, modelId: model.id, kind: 'model_check', expectedVersion: 1, definition: {}, semanticHash: '0'.repeat(64), rulesHash: '1'.repeat(64), requestKey: crypto.randomUUID(), requestHash: '2'.repeat(64), authorize: async () => ({ model, vector: [] }) });
}

test('接纳等待权限复核时不占用全局调度锁，其他账号仍可提交并领取任务', { timeout: 30000 }, async () => fixture(async users => {
    const model = await queryOne("INSERT INTO analysis_data_models(id,user_id,name) VALUES (?,?,'慢速授权调度测试') RETURNING *", [`budget_model_${crypto.randomUUID()}`, users[0].id]);
    let entered, resume;
    const authorizing = new Promise(resolve => { entered = resolve; });
    const released = new Promise(resolve => { resume = resolve; });
    const pending = require('../server/repositories/analysis-model-jobs').admit({ userId: users[0].id, modelId: model.id, kind: 'model_check', expectedVersion: 1,
        definition: {}, semanticHash: '0'.repeat(64), rulesHash: '1'.repeat(64), requestKey: crypto.randomUUID(), requestHash: '2'.repeat(64),
        authorize: async () => { entered(); await released; return { model, vector: [] }; } });
    let timer, other;
    try {
        await authorizing;
        other = (async () => {
            const queued = await budget.createLegacy(users[1].id);
            const running = await claim();
            assert.equal(running.id, queued.id);
            await budget.settleLegacy(running, true);
        })();
        await Promise.race([other, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('权限复核阻塞了其他账号的任务接纳或领取。')), 2000); })]);
    } finally {
        clearTimeout(timer); resume();
        await Promise.allSettled([pending, other]);
    }
    assert.equal((await pending).status, 'queued');
}));

test('跨连接共享两个槽位，单用户只运行一个，释放必须匹配代次并同步续租', async () => fixture(async users => {
    const first = await budget.createLegacy(users[0].id);
    const second = await budget.createLegacy(users[1].id);
    const ownQueued = await budget.createLegacy(users[0].id);
    const third = await budget.createLegacy(users[2].id);
    const claimed = await Promise.all([claim(), claim(), claim()]);
    assert.deepEqual(claimed.filter(Boolean).map(row => row.id).sort(), [first.id, second.id].sort());
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots WHERE job_id IS NOT NULL')).n), 2);
    const active = claimed.find(row => row?.id === first.id);
    await execute("UPDATE analysis_runtime_slots SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE job_id=?", [active.id]);
    assert.equal(await budget.renew(active), true);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots s JOIN analysis_query_jobs q ON q.id=s.job_id WHERE q.id=? AND s.lease_expires_at=q.lease_expires_at AND s.lease_expires_at>NOW()', [active.id])).n), 1);
    await transaction(trx => budget.release(trx, { ...active, execution_epoch: Number(active.execution_epoch) - 1 }));
    assert.equal(await claim(), null);
    await budget.settleLegacy(active, true);
    const next = await claim();
    assert.equal(next.id, third.id, '未获得过执行机会的用户先运行');
    assert.equal((await queryOne('SELECT status FROM analysis_query_jobs WHERE id=?', [ownQueued.id])).status, 'queued');
}));

test('全局排队十六、单用户三项，数据库内检查配额且过期任务不再领取', async () => fixture(async users => {
    const own = [];
    for (let index = 0; index < 3; index++) own.push(await budget.createLegacy(users[0].id));
    await assert.rejects(budget.createLegacy(users[0].id), error => error.status === 429);
    for (let index = 0; index < 13; index++) await budget.createLegacy(users[1 + Math.floor(index / 3)].id);
    await assert.rejects(budget.createLegacy(users[6].id), error => error.status === 429);
    await execute("UPDATE analysis_query_jobs SET queue_deadline_at=NOW()-INTERVAL '1 second' WHERE id=?", [own[0].id]);
    await transaction(trx => budget.expireQueued(trx));
    assert.equal((await queryOne('SELECT status FROM analysis_query_jobs WHERE id=?', [own[0].id])).status, 'failed');
    await budget.createLegacy(users[6].id);
}));

test('并发模型接纳仍原子限制十六项，队满后幂等重试复用原任务且冲突不被限流覆盖', async () => fixture(async users => {
    const jobs = require('../server/repositories/analysis-model-jobs');
    const inputs = [];
    for (const user of users) {
        const model = await queryOne("INSERT INTO analysis_data_models(id,user_id,name) VALUES (?,?,'并发接纳测试') RETURNING *", [`budget_model_${crypto.randomUUID()}`, user.id]);
        for (let index = 0; index < 3; index++) inputs.push({ userId: user.id, modelId: model.id, kind: 'model_check', expectedVersion: 1,
            definition: {}, semanticHash: '0'.repeat(64), rulesHash: '1'.repeat(64), requestKey: crypto.randomUUID(), requestHash: '2'.repeat(64),
            authorize: async () => ({ model, vector: [] }) });
    }
    const attempts = await Promise.allSettled(inputs.map(input => jobs.admit(input)));
    const accepted = attempts.filter(attempt => attempt.status === 'fulfilled');
    assert.equal(accepted.length, 16);
    for (const rejected of attempts.filter(attempt => attempt.status === 'rejected')) {
        assert.equal(rejected.reason.status, 429);
        assert.equal(rejected.reason.code, 'ANALYSIS_MODEL_QUEUE_FULL');
    }
    const first = attempts.findIndex(attempt => attempt.status === 'fulfilled');
    assert.equal((await jobs.admit(inputs[first])).id, attempts[first].value.id);
    await assert.rejects(jobs.admit({ ...inputs[first], requestHash: '3'.repeat(64) }), { code: 'ANALYSIS_MODEL_REQUEST_CONFLICT', status: 409 });
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_query_jobs WHERE status='queued'")).n), 16);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_data_model_checks WHERE user_id=ANY(?::bigint[])', [users.map(user => user.id)])).n), 16);
}));

test('嵌套重型分析只登记一次，异常清理释放槽位且不会登记成功', async () => fixture(async users => {
    await withAnalysisSlot(async () => {
        await withAnalysisSlot(async () => {
            const rows = await query("SELECT id FROM analysis_query_jobs WHERE user_id=? AND status='running'", [users[0].id]);
            assert.equal(rows.length, 1);
            assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots WHERE job_id=?', [rows[0].id])).n), 1);
        }, { userId: users[0].id });
    }, { userId: users[0].id });
    await assert.rejects(withAnalysisSlot(async () => { throw new Error('故障注入'); }, { userId: users[0].id }), /故障注入/);
    const states = await query('SELECT status FROM analysis_query_jobs WHERE user_id=? ORDER BY created_at', [users[0].id]);
    assert.deepEqual(states.map(row => row.status), ['succeeded', 'failed']);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots WHERE job_id IS NOT NULL')).n), 0);
    await assert.rejects(withAnalysisSlot(async () => {}, {}), error => error.code === 'ANALYSIS_ACTOR_REQUIRED');
}));

test('批处理等待老化后获得机会，执行过期和取消均不能续租', async () => fixture(async users => {
    const first = await queueCheck(users[0]);
    await execute("UPDATE analysis_query_jobs SET created_at=NOW()-INTERVAL '40 seconds' WHERE id=?", [first.id]);
    const second = await budget.createLegacy(users[1].id);
    const current = await claim({ kinds: ['model_check', 'legacy_operation'] });
    assert.equal(current.id, first.id);
    await execute("UPDATE analysis_query_jobs SET execution_deadline_at=NOW()-INTERVAL '1 second' WHERE id=?", [first.id]);
    assert.equal(await budget.renew(current), false);
    assert.equal(await claim({ jobId: second.id, slots: 1 }), null, '到期不能提前回收仍可能运行的单元');
    await require('../server/repositories/analysis-model-jobs').fail(current, { code: 'ANALYSIS_MODEL_LEASE_EXPIRED', message: '测试监督器已确认退出。' });
    const next = await claim(); assert.equal(next.id, second.id);
    await execute('UPDATE analysis_query_jobs SET cancel_requested_at=NOW() WHERE id=?', [next.id]);
    assert.equal(await budget.renew(next), false);
    await budget.settleLegacy(next, true);
    assert.equal((await queryOne('SELECT status FROM analysis_query_jobs WHERE id=?', [next.id])).status, 'cancelled');
}));

test('旧 SQL、模型批处理和交互共用预算，批处理最多一个且等待过期会完成检查及审计', async () => fixture(async users => {
    const first = await queueCheck(users[0]);
    const second = await queueCheck(users[1]);
    await execute("UPDATE analysis_query_jobs SET created_at=NOW()-INTERVAL '35 seconds' WHERE id IN (?,?)", [first.id, second.id]);
    const batch = await claim({ kinds: ['model_check'] });
    assert.ok([first.id, second.id].includes(batch.id));
    assert.equal(await claim({ kinds: ['model_check'] }), null);
    const dataset = await queryOne("INSERT INTO analysis_datasets(id,user_id,name) VALUES (?,?,'旧查询') RETURNING id", [`budget_data_${crypto.randomUUID()}`, users[2].id]);
    const legacy = await require('../server/repositories/analysis-query-jobs').create({ id: `budget_sql_${crypto.randomUUID()}`, userId: users[2].id, datasetId: dataset.id, sql: 'SELECT 1', limit: 1, sourceVersion: 1 });
    assert.equal((await require('../server/repositories/analysis-query-jobs').claim(30000)).id, legacy.id);
    assert.equal(await claim({ kinds: ['model_check'] }), null);
    const waiting = batch.id === first.id ? second : first;
    await execute("UPDATE analysis_query_jobs SET queue_deadline_at=NOW()-INTERVAL '1 second' WHERE id=?", [waiting.id]);
    await transaction(trx => budget.expireQueued(trx));
    const check = await queryOne('SELECT * FROM analysis_data_model_checks WHERE id=?', [waiting.check_id]);
    assert.equal(check.status, 'incomplete'); assert.equal(check.complete, false); assert.ok(check.completed_at);
    assert.equal(check.report_json.blockers[0].code, 'ANALYSIS_MODEL_QUEUE_EXPIRED');
    assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM analysis_audit_events WHERE run_id=? AND action='job_failed'", [waiting.id])).n), 1);
}));

test('取消正在计算的旧 DuckDB 操作后五秒内中断，确认退出前保留持久槽位', { timeout: 60000 }, async () => fixture(async users => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const running = withAnalysisSlot(async () => {
        const { instance, connection } = await require('../server/services/data-analysis/shared').createDuckConnection();
        try {
            const row = await queryOne("SELECT id FROM analysis_query_jobs WHERE user_id=? AND status='running'", [users[0].id]);
            started(row.id);
            await connection.runAndReadAll('SELECT SUM(CAST(i AS HUGEINT)*j) FROM range(100000000000) a(i),range(3) b(j)');
        } finally { connection.closeSync(); instance.closeSync(); }
    }, { userId: users[0].id });
    const rejected = assert.rejects(running);
    const id = await ready;
    const began = Date.now();
    await execute("UPDATE analysis_query_jobs SET cancel_requested_at=NOW(),status='cancelling' WHERE id=?", [id]);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots WHERE job_id=?', [id])).n), 1);
    await rejected;
    const cancellationMs = Date.now() - began;
    assert.ok(cancellationMs < 5000);
    console.log(`旧分析实际取消耗时：${cancellationMs}ms；隔离账号和独立日志的创建清理不计入此断言。`);
    assert.equal((await queryOne('SELECT status FROM analysis_query_jobs WHERE id=?', [id])).status, 'cancelled');
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_runtime_slots WHERE job_id=?', [id])).n), 0);
}));

test('槽位代次与任务记录不一致时拒绝续租、来源状态和可见结果提交', async () => fixture(async users => {
    await queueCheck(users[0]);
    const jobs = require('../server/repositories/analysis-model-jobs');
    const job = await claim({ kinds: ['model_check'] });
    assert.ok(await transaction(trx => jobs.owned(trx, job)));
    await execute('UPDATE analysis_runtime_slots SET execution_epoch=execution_epoch+1 WHERE job_id=?', [job.id]);
    assert.equal(await budget.renew(job), false);
    assert.equal(await transaction(trx => jobs.owned(trx, job)), null);
    assert.equal(await jobs.complete(job, { report: { passed: true, complete: true }, authorize: async () => { throw new Error('不应进入提交授权'); } }), false);
    assert.equal((await queryOne('SELECT status FROM analysis_query_jobs WHERE id=?', [job.id])).status, 'running');
}));
