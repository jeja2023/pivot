'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { fixture, checked } = require('../scripts/test_support/bi_modeling');
const { queryOne, query, execute, transaction } = require('../server/db/client');
const repository = require('../server/repositories/analysis-release-controls');
const controls = require('../server/services/data-analysis/bi/release-controls');
const jobs = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');
const semantic = require('../server/services/data-analysis/semantic-models');

async function administrator() { return queryOne("SELECT * FROM users WHERE username='admin'"); }
async function resetReleaseControls() {
    await execute("UPDATE analysis_operation_state SET create_enabled=TRUE,publish_enabled=TRUE,admission_enabled=TRUE,dispatch_enabled=TRUE WHERE id='main'");
}
async function withControls(run) {
    try { return await fixture(run); }
    finally { await resetReleaseControls(); }
}
async function action(admin, name, extra = {}) {
    return controls.act(admin, { action: name, expectedRevision: (await repository.state()).revision, reason: '本机隔离升级控制核查。', ...extra });
}

test('当前系统管理员才能修改持久开关，修订冲突和原因缺失拒绝；旧客户端真实 HTTP 不能绕过新建或发布关闭', { timeout: 120000 }, async () => withControls(async ({ user, model, fact }) => {
    const admin = await administrator(), report = await checked(user, model), initial = await repository.state();
    await assert.rejects(controls.act(user, { action: 'pause', expectedRevision: initial.revision, reason: '普通账号。' }), error => error.status === 403);
    await assert.rejects(controls.act(admin, { action: 'pause', expectedRevision: initial.revision, reason: '' }), error => error.code === 'ANALYSIS_RELEASE_CONTROL_INVALID');
    const closed = await action(admin, 'close_writes'); assert.equal(closed.controls.createEnabled, false); assert.equal(closed.controls.publishEnabled, false);
    await assert.rejects(controls.act(admin, { action: 'pause', expectedRevision: initial.revision, reason: '旧修订。' }), error => error.code === 'ANALYSIS_RELEASE_CONTROL_CONFLICT');
    const server = http.createServer(require('../server/app').app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // 本夹具不启动后台维护；完整应用载入后先执行实际独立日志复核，再核对发布开关。
    await require('../server/services/data-analysis/bi/security-journal').flush({ force: true, full: true });
    const token = require('../server/auth').generateAccessToken(await queryOne('SELECT * FROM users WHERE id=?', [user.id]), { sessionIp: '127.0.0.1' });
    const send = async (route, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/data-analysis${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    };
    try {
        const create = await send('/models', { modelKind: 'production', name: '旧客户端新建', factDatasetId: fact.id, businessOwner: '业务', maintenanceContact: '维护' });
        assert.equal(create.status, 503, JSON.stringify(create)); assert.match(create.body.error, /新建/);
        const publish = await send(`/models/${model.id}/publish`, { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() });
        assert.equal(publish.status, 503, JSON.stringify(publish)); assert.match(publish.body.error, /发布/);
        assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_data_model_versions WHERE model_id=?', [model.id])).n), 0);
        const saved = await require('../server/services/data-analysis/bi/models').saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: model.definition } });
        assert.equal(saved.version, model.version + 1);
        assert.equal((await semantic.getDataModel(user, model.id)).model.id, model.id);
        await assert.rejects(execute("INSERT INTO analysis_data_models(id,user_id,name,model_kind) VALUES (?,?,'直接旧写入','production')", [`blocked_${crypto.randomUUID()}`, user.id]), error => error.code === 'P0001');
        const audit = await queryOne("SELECT user_id,details_json FROM analysis_audit_events WHERE action='model_release_close_writes' ORDER BY created_at DESC LIMIT 1");
        assert.equal(Number(audit.user_id), Number(admin.id)); assert.match(audit.details_json.beforeHash, /^[a-f0-9]{64}$/); assert.match(audit.details_json.afterHash, /^[a-f0-9]{64}$/);
    } finally {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        await require('../server/services/db-write-queue').flushAllWrites();
        await execute('DELETE FROM audit_logs WHERE user_id=?', [user.id]);
    }
}));

test('统一分析接纳和领取受服务端及数据库保护，停止接纳仍可排空，暂停不阻止续租或完成', { timeout: 120000 }, async () => withControls(async ({ user, model, fact }) => {
    const admin = await administrator(), created = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    await action(admin, 'pause');
    await assert.rejects(jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } }), error => error.code === 'ANALYSIS_RELEASE_ADMISSION_PAUSED');
    await assert.rejects(require('../server/repositories/analysis-runtime-budget').createLegacy(user.id), error => error.code === 'ANALYSIS_RELEASE_ADMISSION_PAUSED');
    await assert.rejects(require('../server/services/data-analysis/async-query-jobs').createAsyncQueryJob({ user, datasetId: fact.id, sql: 'SELECT * FROM data' }), error => error.code === 'ANALYSIS_RELEASE_ADMISSION_PAUSED');
    assert.equal(await require('../server/repositories/analysis-model-jobs').claim({ owner: 'paused-new-worker' }), null);
    await assert.rejects(execute("UPDATE analysis_query_jobs SET status='running',attempts=attempts+1,locked_at=NOW() WHERE id=?", [created.job.id]), error => error.code === 'P0001');
    await action(admin, 'stop_admission');
    const claimed = await require('../server/repositories/analysis-model-jobs').claim({ owner: 'drain-compatible-worker' }); assert.equal(claimed.id, created.job.id);
    await action(admin, 'pause'); assert.equal(await require('../server/repositories/analysis-model-jobs').renew(claimed), true);
    await runner.executeJob(claimed);
    assert.equal((await jobs.getModelCheck(user, model.id, created.check.id)).status, 'passed');
    const status = await controls.overview(admin); assert.equal(status.workload.idle, true);
    const resumed = await action(admin, 'resume'); assert.equal(resumed.resumed, true); assert.equal(resumed.readiness.schema.schemaVersion, '202611070013');
    assert.equal((await repository.state()).admissionEnabled, true);
}));

test('维护排空等待有限且取消保留系统来源，完整预检失败保持暂停；兼容回退前同时关闭写入口和领取', { timeout: 120000 }, async () => withControls(async ({ user, model }) => {
    const admin = await administrator(), created = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    const waiting = await action(admin, 'drain'); assert.equal(waiting.drained, false); assert.equal(waiting.controls.admissionEnabled, false); assert.equal(waiting.controls.dispatchEnabled, true);
    await assert.rejects(action(admin, 'resume'), error => error.code === 'ANALYSIS_RELEASE_WORKLOAD_BUSY');
    const rollback = await action(admin, 'prepare_rollback', { cancel: true, waitSeconds: 1 });
    assert.equal(rollback.readyForBinaryChange, true); assert.equal(rollback.controls.createEnabled, false); assert.equal(rollback.controls.publishEnabled, false);
    const cancelled = await queryOne('SELECT status,cancel_cause FROM analysis_query_jobs WHERE id=?', [created.job.id]); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.cancel_cause, 'system');
    await execute('ALTER TABLE analysis_query_jobs DISABLE TRIGGER analysis_release_job_write');
    try { await assert.rejects(action(admin, 'resume', { reopenWrites: true }), error => error.code === 'ANALYSIS_MODEL_SCHEMA_INCOMPATIBLE'); }
    finally { await execute('ALTER TABLE analysis_query_jobs ENABLE TRIGGER analysis_release_job_write'); }
    assert.equal((await repository.state()).admissionEnabled, false); assert.equal((await repository.state()).createEnabled, false);
    assert.equal((await action(admin, 'resume', { reopenWrites: true })).controls.createEnabled, true);
}));

test('关闭提交与已开始的写事务串行化，提交之后旧 SQL 无法新增正式模型；旧协议领取也不能推进正式任务', { timeout: 120000 }, async () => withControls(async ({ user, model }) => {
    const admin = await administrator();
    let release, started;
    const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
    const writing = transaction(async trx => {
        await repository.assertAllowed(trx, 'create'); started(); await held;
        await trx.execute("INSERT INTO analysis_data_models(id,user_id,name,model_kind) VALUES (?,?,'已开始的旧写事务','production')", [`before_${crypto.randomUUID()}`, user.id]);
    });
    await entered; let applied = false;
    const closing = action(admin, 'close_writes').then(value => { applied = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(applied, false); release(); await writing; await closing;
    await assert.rejects(execute("INSERT INTO analysis_data_models(id,user_id,name,model_kind) VALUES (?,?,'关闭后的旧写事务','production')", [`after_${crypto.randomUUID()}`, user.id]), error => error.code === 'P0001');
    const job = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    await assert.rejects(execute("UPDATE analysis_query_jobs SET status='running',progress=5,attempts=attempts+1,locked_at=NOW(),started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=?", [job.job.id]), error => error.code === 'P0001');
    assert.equal((await queryOne('SELECT status FROM analysis_query_jobs WHERE id=?', [job.job.id])).status, 'queued');
    assert.equal((await query('SELECT id FROM analysis_runtime_slots WHERE job_id=?', [job.job.id])).length, 0);
}));

test('独立安全副本失联仍可先提交维护收紧，明确返回待确认；修复后同一事件确认再恢复', { timeout: 120000 }, async () => withControls(async () => {
    const fs = require('node:fs/promises'), path = require('node:path'), key = process.env.DATA_ANALYSIS_SECURITY_KEY_FILE;
    assert.match(process.env.PG_TEST_SCHEMA, /^pivot_test_/); assert.ok(path.isAbsolute(key));
    const admin = await administrator(), before = await repository.state();
    await fs.rename(key, key + '.release-test-unavailable');
    try {
        await assert.rejects(controls.act(admin, { action: 'pause', expectedRevision: before.revision, reason: '副本失联期间先停止新的执行。' }), error => error.applied === true && error.securityConfirmationPending === true);
        assert.equal((await repository.state()).admissionEnabled, false); assert.equal((await repository.state()).dispatchEnabled, false);
    } finally { await fs.rename(key + '.release-test-unavailable', key); }
    await require('../server/services/data-analysis/bi/security-journal').flush({ force: true, full: true });
    assert.equal((await action(admin, 'resume')).resumed, true);
}));

test('管理员在等待控制栅栏期间被停用，提交前重新核对主体并拒绝变更', { timeout: 60000 }, async () => withControls(async () => {
    const operator = await administrator();
    let releaseGate, entered;
    const held = new Promise(resolve => { releaseGate = resolve; }), ready = new Promise(resolve => { entered = resolve; });
    const reader = transaction(async trx => { await repository.readLock(trx); entered(); await held; });
    let outcome, changeOutcome;
    try {
        await ready;
        const changing = action(operator, 'close_writes').then(value => (changeOutcome = { value }), error => (changeOutcome = { error }));
        const deadline = Date.now() + 5000;
        while (!(await queryOne("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid::bigint=(hashtext('pivot:analysis:release')::bigint & 4294967295)) AS waiting")).waiting) {
            if (changeOutcome?.error) throw changeOutcome.error;
            assert.ok(Date.now() < deadline, '控制操作未进入真实发布栅栏等待。'); await new Promise(resolve => setTimeout(resolve, 10));
        }
        await execute("UPDATE users SET status='disabled' WHERE id=?", [operator.id]);
        releaseGate(); await reader; outcome = await changing;
        assert.equal(outcome.error?.status, 403); assert.equal((await repository.state()).createEnabled, true);
    } finally {
        releaseGate(); await reader;
        await execute("UPDATE users SET status='active' WHERE id=?", [operator.id]);
    }
}));
