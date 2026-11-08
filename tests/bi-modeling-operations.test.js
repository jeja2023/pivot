'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { fixture, checked } = require('../scripts/test_support/bi_modeling');
const { queryOne, execute } = require('../server/db/client');
const repository = require('../server/repositories/analysis-operations');
const jobRepository = require('../server/repositories/analysis-model-jobs');
const operations = require('../server/services/data-analysis/bi/operations');
const probe = require('../server/services/data-analysis/bi/operation-probe');
const jobs = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');
const models = require('../server/services/data-analysis/bi/models');
const delivery = require('../server/services/data-analysis/bi/delivery');
const runtime = require('../server/services/data-analysis/bi/runtime');
process.env.PIVOT_ALERT_WEBHOOK_URL = '';
test.before(async () => { await require('../server/services/app-settings').setAppSetting('observability_webhook_url', ''); });

async function publish(user, model) {
    const report = await checked(user, model);
    await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
}
async function eventually(check) {
    const until = Date.now() + 5000;
    do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < until);
    assert.fail('等待真实异步状态超过五秒。');
}
async function operator() { return queryOne("SELECT id,username,role,status,unit FROM users WHERE username='admin' AND status='active'"); }
async function probeFixture(run) {
    await fixture(async context => {
        await execute("UPDATE users SET username=?,password_hash=? WHERE id=?", [`bi_probe_positive_${crypto.randomUUID()}`, `!bi-probe:${crypto.randomUUID()}`, context.user.id]);
        const negative = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,?,'合成反向专用') RETURNING id,username,role,status,unit", [`bi_probe_negative_${crypto.randomUUID()}`, `!bi-probe:${crypto.randomUUID()}`]);
        try {
            await publish(context.user, context.model);
            await run({ ...context, negative, admin: await operator(), config: { enabled: true, positiveUserId: context.user.id, negativeUserId: negative.id, modelId: context.model.id, publishedVersion: 1, query: { dimensions: [], metrics: ['amount', 'orders'] }, expectedValues: { amount: '250.00', orders: '2' } } });
        } finally {
            await execute("UPDATE analysis_operation_state SET probe_config_json='{}',pending_run_id=NULL,probe_outcome='unconfigured',probe_error='',probe_started_at=NULL,probe_finished_at=NULL,access_fenced=FALSE,fence_reason='' WHERE id='main'");
            await execute('UPDATE analysis_runtime_slots SET job_id=NULL WHERE job_id IN (SELECT id FROM analysis_query_jobs WHERE user_id=?)', [negative.id]);
            await execute('DELETE FROM analysis_query_jobs WHERE user_id=?', [negative.id]);
            await execute('DELETE FROM analysis_audit_events WHERE user_id=?', [negative.id]);
            await execute('DELETE FROM users WHERE id=?', [negative.id]);
        }
    });
}

test('真实控制 HTTP 按成功、授权、输入、用户配额与内部误拒绝分别计数，零样本不虚报可用性', async () => fixture(async ({ user, model }) => {
    const before = operations.aggregate(await repository.samples(), 'control').counts;
    const app = express(); app.use('/apps/data-analysis', operations.controlMiddleware);
    app.get('/apps/data-analysis/models', delivery.handler(async (_req, res) => res.json(await require('../server/services/data-analysis/semantic-models').listDataModels(user))));
    for (const [path, status, code] of [['denied', 403, 'ANALYSIS_MODEL_NOT_FOUND'], ['invalid', 400, 'ANALYSIS_MODEL_QUERY_INVALID'], ['quota', 429, 'ANALYSIS_MODEL_QUEUE_FULL'], ['wrong-quota', 429, 'INTERNAL_CAPACITY_REJECT'], ['failure', 500, 'INTERNAL_FAILURE']]) {
        app.get(`/apps/data-analysis/models/${path}`, delivery.handler(async () => { throw Object.assign(new Error('测试受控响应'), { status, code }); }));
    }
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
    const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        for (const suffix of ['', '/denied', '/invalid', '/quota', '/wrong-quota', '/failure']) await (await fetch(`http://127.0.0.1:${server.address().port}/apps/data-analysis/models${suffix}`)).json();
        const expectedCounts = { success: 1, auth_denied: 1, invalid: 1, quota_exceeded: 1, platform_failure: 2 };
        await eventually(async () => { const current = operations.aggregate(await repository.samples(), 'control').counts; return Object.entries(expectedCounts).every(([name, count]) => current[name] >= before[name] + count); });
        const after = operations.aggregate(await repository.samples(), 'control');
        for (const [name, count] of Object.entries(expectedCounts)) assert.equal(after.counts[name] - before[name], count, name);
        assert.equal(after.exhausted, true); assert.equal(operations.aggregate([], 'control').availability, null);
        assert.equal(JSON.stringify(await repository.samples()).includes(user.username), false);
        assert.equal(JSON.stringify(await repository.samples()).includes(model.id), false);
        await assert.rejects(operations.overview(user), error => error.status === 403);
        const view = await operations.overview(await operator()); assert.equal(view.complete30DayWindow, false); assert.ok(view.observedSeconds < 86400);
        await assert.rejects(operations.fullPreflight(user), error => error.status === 403);
        assert.equal((await operations.fullPreflight(await operator())).ready, true);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}));

test('脏数据检查属于平台成功并另计质量失败，终态和取消重复调用不会重复消耗误差预算', async () => fixture(async ({ user, model }) => {
    const before = operations.aggregate(await repository.samples(), 'task');
    model = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, nodes: [{ ...model.definition.nodes[0], grainKeys: ['c_1'] }] } } });
    const created = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    assert.equal((await jobs.getModelCheck(user, model.id, created.check.id)).status, 'failed');
    assert.equal((await jobs.getModelJob(user, created.job.id)).status, 'succeeded');
    const failed = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    const claimed = await jobRepository.claim({ owner: `sli_${crypto.randomUUID()}` }); assert.equal(claimed.id, failed.job.id);
    await assert.rejects(operations.fullPreflight(await operator()), error => error.code === 'ANALYSIS_OPERATIONS_BUSY');
    assert.equal(await jobRepository.fail(claimed, { code: 'ANALYSIS_MODEL_EXECUTOR_LOST', message: '专项验证执行器失联终态。' }), true);
    assert.equal(await jobRepository.fail(claimed, { code: 'ANALYSIS_MODEL_EXECUTOR_LOST', message: '重复终态。' }), false);
    const cancelled = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    await jobs.cancelModelJob(user, cancelled.job.id); await jobs.cancelModelJob(user, cancelled.job.id);
    const deadline = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    const timed = await jobRepository.claim({ owner: `sli_${crypto.randomUUID()}` }); assert.equal(timed.id, deadline.job.id);
    await jobRepository.fail(timed, { code: 'ANALYSIS_MODEL_QUERY_CANCELLED', message: '内部截止引发的隔离不冒充用户取消。' });
    const system = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    await jobs.cancelModelJob(user, system.job.id, { cause: 'system' });
    assert.equal((await queryOne('SELECT cancel_cause FROM analysis_query_jobs WHERE id=?', [system.job.id])).cancel_cause, 'system');
    const after = operations.aggregate(await repository.samples(), 'task');
    assert.equal(after.counts.success - before.counts.success, 1); assert.equal(after.qualityFailures - before.qualityFailures, 1);
    assert.equal(after.counts.platform_failure - before.counts.platform_failure, 3); assert.equal(after.counts.cancelled - before.counts.cancelled, 1);
}));

test('专用无登录账号执行明确黄金值和反向拒绝，普通用户不可配置探针或读取全局运营数据', async () => probeFixture(async ({ user, negative, admin, config }) => {
    await assert.rejects(probe.configure(user, config), error => error.status === 403);
    await assert.rejects(probe.configure(admin, { ...config, negativeUserId: user.id }), error => error.code === 'ANALYSIS_OPERATIONS_INVALID');
    await probe.configure(admin, config);
    const started = await probe.tick(); assert.equal(started.outcome, 'running');
    await runner.processModelJobs();
    await probe.tick();
    const state = await repository.state(); assert.equal(state.probe_outcome, 'succeeded'); assert.equal(state.access_fenced, false);
    assert.ok(state.probe_finished_at);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM analysis_query_jobs WHERE user_id=?', [negative.id])).n), 0);
    assert.deepEqual(state.probe_config_json.sourceIds.length, 1); assert.equal(state.probe_config_json.expectedValues, undefined);
    await execute("UPDATE users SET password_hash='not-a-probe-marker' WHERE id=?", [negative.id]);
    assert.equal((await probe.tick()).outcome, 'failed');
    assert.ok((await operations.overview(admin)).alerts.some(item => item.code === 'probe_failed'));
}));

test('黄金值不符时持久关闭业务交付，探针修复成功后必须由系统管理员填写原因恢复', async () => probeFixture(async ({ user, model, fact, admin, config }) => {
    const business = await require('../server/services/data-analysis/semantic-models').saveDataModel({ user, body: { modelKind: 'production', name: '业务隔离验证模型', factDatasetId: fact.id } });
    const prepared = (await models.getProductionModel(user, business.id)).model;
    await probe.configure(admin, { ...config, expectedValues: { amount: '249.99', orders: '2' } });
    await probe.tick(); await runner.processModelJobs();
    assert.equal((await probe.tick()).outcome, 'statistics_failed');
    assert.equal((await repository.state()).access_fenced, true);
    let sent = false; await assert.rejects(delivery.consume(prepared, () => { sent = true; }), error => error.code === 'ANALYSIS_MODEL_INCIDENT_FENCED'); assert.equal(sent, false);
    await assert.rejects(operations.resume(admin, '尚未完成核对'), error => error.code === 'ANALYSIS_MODEL_PROBE_REQUIRED');
    await probe.configure(admin, config); await probe.tick(); await runner.processModelJobs(); await probe.tick();
    assert.equal((await repository.state()).probe_outcome, 'succeeded'); assert.equal((await repository.state()).access_fenced, true);
    await assert.rejects(operations.resume(user, '完成核对'), error => error.status === 403);
    await operations.resume(admin, '已核对专用预期值，正反向监测均通过。');
    assert.equal((await repository.state()).access_fenced, false);
    assert.equal((await jobs.getModelJob(user, (await repository.state()).pending_run_id)).modelId, model.id);
    await assert.rejects(operations.fence(user, '普通账号不得暂停全局业务。'), error => error.status === 403);
    await operations.fence(admin, '运维演练：人工暂停后核对。');
    const manual = await queryOne("SELECT user_id,details_json FROM analysis_audit_events WHERE action='model_incident_fenced' AND user_id=? ORDER BY created_at DESC LIMIT 1", [admin.id]);
    assert.equal(Number(manual.user_id), Number(admin.id)); assert.equal(manual.details_json.actor, 'operator'); assert.match(manual.details_json.beforeHash, /^[a-f0-9]{64}$/);
    await operations.resume(admin, '人工暂停核对后恢复，复用最近的成功探针。');
}));

test('反向账号意外取得模型和来源授权时立即告警并关闭业务，取消异常准入且不计算结果', async () => probeFixture(async ({ negative, model, fact, admin, config }) => {
    await probe.configure(admin, config);
    await execute("UPDATE analysis_data_models SET scope='shared',allowed_user_ids=? WHERE id=?", [String(negative.id), model.id]);
    await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(negative.id), fact.id]);
    assert.equal((await probe.tick()).outcome, 'security_failed');
    assert.equal((await repository.state()).access_fenced, true);
    const unexpected = await queryOne('SELECT status,result_object_id FROM analysis_query_jobs WHERE user_id=?', [negative.id]);
    assert.equal(unexpected.status, 'cancelled'); assert.equal(unexpected.result_object_id, null);
}));

test('运行告警复用现有可观测事件和真实本地 Webhook，不外发查询值、主体或来源明细', async () => fixture(async () => {
    const address = Object.values(os.networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address));
    assert.ok(address, '本地告警验收需要本机私网接口。');
    const received = [], server = http.createServer(async (req, res) => { let body = ''; for await (const piece of req) body += piece; received.push(JSON.parse(body)); res.end('{}'); });
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
    const previous = process.env.PIVOT_ALERT_WEBHOOK_URL, previousPrivate = process.env.ALLOW_PRIVATE_MODEL_URLS;
    process.env.PIVOT_ALERT_WEBHOOK_URL = `http://${address.address}:${server.address().port}/alerts`; process.env.ALLOW_PRIVATE_MODEL_URLS = 'true';
    try {
        const report = await operations.tick(); assert.ok(report.alerts.some(item => item.code === 'recovery_point_lag'));
        await eventually(() => received.length > 0);
        assert.ok(received.some(item => item.type === 'system' && item.source === 'pivot'));
        assert.ok(received.every(item => item.details && Array.isArray(item.details.keys) && typeof item.details.hash === 'string'));
        assert.ok(received.every(item => !JSON.stringify(item).includes('100.25')));
        const event = await queryOne("SELECT alerted_at FROM observability_events WHERE source LIKE 'data-analysis.bi.%' AND alerted_at IS NOT NULL ORDER BY created_at DESC LIMIT 1"); assert.ok(event);
        const count = async () => Number((await queryOne("SELECT COUNT(*) AS n FROM observability_events WHERE source='data-analysis.bi.recovery_point_lag'")).n);
        const initial = await count(); await operations.tick(); assert.equal(await count(), initial);
        await repository.alertsToEmit([]); await operations.tick(); assert.equal(await count(), initial + 1);
    } finally { if (previous === undefined) delete process.env.PIVOT_ALERT_WEBHOOK_URL; else process.env.PIVOT_ALERT_WEBHOOK_URL = previous; if (previousPrivate === undefined) delete process.env.ALLOW_PRIVATE_MODEL_URLS; else process.env.ALLOW_PRIVATE_MODEL_URLS = previousPrivate; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}));

test('长批次仍在执行时，快速查询释放的另一个持久槽位可继续领取新查询', async () => fixture(async ({ user, model, fact }) => {
    await publish(user, model);
    const readers = [];
    for (let i = 0; i < 2; i++) readers.push(await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','轮转验收') RETURNING id,username,unit,status", [`bi_scheduler_${crypto.randomUUID()}`]));
    const original = runtime.runIsolated; let release, parked = false;
    const barrier = new Promise(resolve => { release = resolve; });
    runtime.runIsolated = async input => { if (input.job.execution_kind === 'model_check' && input.job.model_id === model.id) { parked = true; await barrier; } return original(input); };
    let first = null;
    try {
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_units='轮转验收' WHERE id=?", [fact.id]);
        await execute("UPDATE analysis_data_models SET scope='shared',allowed_units='轮转验收' WHERE id=?", [model.id]);
        await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
        const query = reader => jobs.createModelQuery({ user: reader, modelId: model.id, body: { publishedVersion: 1, dimensions: [], metrics: ['amount'], requestKey: crypto.randomUUID() } });
        const fast = await query(readers[0]); first = runner.processModelJobs();
        await eventually(() => parked);
        await eventually(async () => (await jobs.getModelJob(readers[0], fast.id)).status === 'succeeded');
        const next = await query(readers[1]); await runner.processModelJobs();
        assert.equal((await jobs.getModelJob(readers[1], next.id)).status, 'succeeded'); assert.equal(parked, true);
        const active = await queryOne("SELECT COUNT(*) AS n FROM analysis_query_jobs WHERE user_id=? AND status='running'", [user.id]); assert.equal(Number(active.n), 1);
    } finally {
        release(); if (first) await first; runtime.runIsolated = original;
        for (const reader of readers) { await execute('DELETE FROM analysis_query_jobs WHERE user_id=?', [reader.id]); await execute('DELETE FROM analysis_object_references WHERE object_id IN (SELECT id FROM analysis_data_objects WHERE user_id=?)', [reader.id]); await execute('DELETE FROM analysis_data_objects WHERE user_id=?', [reader.id]); await execute('DELETE FROM analysis_audit_events WHERE user_id=?', [reader.id]); await execute('DELETE FROM users WHERE id=?', [reader.id]); }
    }
}));

test('运维自举使用现有数据与建模链路生成专用验收资产，不发登录凭据且重复调用保持同一配置', async () => {
    let created;
    try {
        const admin = await operator(); created = await probe.bootstrap(admin);
        assert.equal(created.credentialsIssued, false); assert.ok(created.modelId);
        assert.equal((await probe.bootstrap(admin)).modelId, created.modelId);
        await probe.tick(); await runner.processModelJobs(); await probe.tick();
        const state = await repository.state(); assert.equal(state.probe_outcome, 'succeeded');
        assert.deepEqual(state.probe_config_json.query.metrics, ['amount', 'rows']);
        const identities = await repository.principals([created.positiveUserId, created.negativeUserId]); assert.ok(identities.every(row => row.service_only && row.role === 'user'));
    } finally {
        await execute("UPDATE analysis_operation_state SET probe_config_json='{}',pending_run_id=NULL,probe_outcome='unconfigured',probe_started_at=NULL,probe_finished_at=NULL,access_fenced=FALSE,fence_reason='' WHERE id='main'");
        if (created) for (const id of [created.negativeUserId, created.positiveUserId]) await require('../scripts/test_support/bi_modeling').cleanupUser({ id });
    }
});

test('事故关闭提交与实际响应共享同一数据库栅栏，已准备数据在关闭提交后不能继续发送', async () => fixture(async ({ user, model }) => {
    const value = (await models.getProductionModel(user, model.id)).model;
    let ready, release;
    const reached = new Promise(resolve => { ready = resolve; }), barrier = new Promise(resolve => { release = resolve; });
    delivery.protect(value, { userId: user.id, modelId: model.id, definition: { nodes: [] }, required: new Map(), beforeSend: async () => { ready(); await barrier; } });
    let sent = false, fenced = false;
    const sending = delivery.consume(value, () => { sent = true; }); await reached;
    const fencing = repository.fence('隔离专项：统计与权限核查。').then(() => { fenced = true; });
    try {
        await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(fenced, false);
        release(); await sending; await fencing; assert.equal(sent, true);
        await assert.rejects(delivery.consume(value, () => assert.fail('关闭提交后不应发送响应')), error => error.code === 'ANALYSIS_MODEL_INCIDENT_FENCED');
    } finally { release(); await Promise.allSettled([sending, fencing]); await execute("UPDATE analysis_operation_state SET access_fenced=FALSE,fence_reason='' WHERE id='main'"); }
}));
