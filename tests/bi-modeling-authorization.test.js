'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { queryOne, execute, transaction } = require('../server/db/client');
const { fixture, checked } = require('../scripts/test_support/bi_modeling');
const authorization = require('../server/repositories/analysis-authorization');
const service = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');
const delivery = require('../server/services/data-analysis/bi/delivery');
const models = require('../server/services/data-analysis/bi/models');
const results = require('../server/services/data-analysis/bi/results');
const consumers = require('../server/services/data-analysis/bi/consumers');
const governance = require('../server/services/data-analysis/governance');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function published(user, model) {
    const report = await checked(user, model);
    await service.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
}

async function withReader({ model, fact }, run) {
    const reader = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`bi_acl_${crypto.randomUUID()}`]);
    try {
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_units='QA' WHERE id=?", [fact.id]);
        await execute("UPDATE analysis_data_models SET scope='shared',allowed_units='QA' WHERE id=?", [model.id]);
        const job = await service.createModelQuery({ user: reader, modelId: model.id, body: { publishedVersion: 1, dimensions: ['region'], metrics: ['average'], requestKey: crypto.randomUUID() } });
        await runner.processModelJobs();
        assert.equal((await service.getModelJob(reader, job.id)).status, 'succeeded');
        await run({ reader, job });
    } finally {
        await execute('DELETE FROM analysis_dashboard_items WHERE user_id=?', [reader.id]);
        await execute('DELETE FROM analysis_saved_views WHERE user_id=?', [reader.id]);
        await execute('DELETE FROM analysis_dashboards WHERE user_id=?', [reader.id]);
        await execute('UPDATE analysis_runtime_slots SET job_id=NULL WHERE job_id IN (SELECT id FROM analysis_query_jobs WHERE user_id=?)', [reader.id]);
        await execute('DELETE FROM analysis_query_jobs WHERE user_id=?', [reader.id]);
        await execute('DELETE FROM analysis_object_references WHERE object_id IN (SELECT id FROM analysis_data_objects WHERE user_id=?)', [reader.id]);
        await execute('DELETE FROM analysis_data_objects WHERE user_id=?', [reader.id]);
        await execute('DELETE FROM analysis_audit_events WHERE user_id=?', [reader.id]);
        await execute('DELETE FROM users WHERE id=?', [reader.id]);
    }
}

async function httpFixture(build, run, onStart = null) {
    const app = express();
    app.use((_req, res, next) => {
        const writeHead = res.writeHead;
        res.writeHead = function recordStart(...args) { onStart?.(this.statusCode); return writeHead.apply(this, args); };
        next();
    });
    app.get('/:name', delivery.handler(async (req, res) => res.json(await build(req.params.name))));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code || 'FAILED' }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await run(name => fetch(`http://127.0.0.1:${server.address().port}/${name}`)); }
    finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}

test('授权修订必须存在，旧库回填可重复且不降低现有修订，锁顺序始终为主体、模型、来源', async () => fixture(async ({ user, model, fact }) => {
    const definition = model.definition;
    const required = require('../server/services/data-analysis/bi/manifests').allRequired(definition);
    const before = await queryOne("SELECT revision FROM analysis_authorization_revisions WHERE resource_kind='dataset' AND resource_id=?", [fact.id]);
    for (const [kind, id] of [['principal', String(user.id)], ['model', model.id], ['dataset', fact.id]]) {
        await execute('DELETE FROM analysis_authorization_revisions WHERE resource_kind=? AND resource_id=?', [kind, id]);
        await assert.rejects(transaction(trx => authorization.authorize(trx, { userId: user.id, modelId: model.id, definition, required })), error => error.code === 'ANALYSIS_AUTHORIZATION_UNREADY' && error.status === 503);
        await transaction(trx => require('../server/db/migrations/analysis-authorization-fences')[0].upPg(trx));
    }
    await execute("UPDATE analysis_authorization_revisions SET revision=99 WHERE resource_kind='dataset' AND resource_id=?", [fact.id]);
    await transaction(trx => require('../server/db/migrations/analysis-authorization-fences')[0].upPg(trx));
    assert.equal(String((await queryOne("SELECT revision FROM analysis_authorization_revisions WHERE resource_kind='dataset' AND resource_id=?", [fact.id])).revision), '99');
    assert.ok(Number(before.revision) > 0);
    const locks = [];
    await transaction(async trx => {
        const traced = { ...trx, queryOne: (sql, params) => {
            if (sql.includes('pg_advisory_xact_lock') && sql.includes("'pivot:analysis:release'")) {
                assert.ok(sql.includes('pg_advisory_xact_lock_shared')); locks.push('release');
            } else if (sql.includes('pg_advisory_xact_lock') && sql.includes("'pivot:analysis:authorization'")) locks.push(params[0]);
            return trx.queryOne(sql, params);
        } };
        await authorization.authorize(traced, { userId: user.id, modelId: model.id, definition, required, write: true });
    });
    assert.deepEqual(locks, ['release', `principal:${user.id}`, `model:${model.id}`, `dataset:${fact.id}`]);
}));

test('真实 HTTP 在撤权提交后拒绝已准备的模型、版本、分页、视图、仪表盘与 AI 结果，派生指标依赖同时受限', { timeout: 90000 }, async () => fixture(async context => {
    const { user, model, fact } = context;
    await published(user, model);
    await withReader(context, async ({ reader, job }) => {
        const view = await consumers.saveModelView({ user: reader, modelId: model.id, body: { sourceRunId: job.id, name: '受控平均金额' } });
        const dashboard = await governance.saveDashboard({ user: reader, body: { name: '授权竞态验证' } });
        await consumers.saveModelDashboardItem({ user: reader, dashboardId: dashboard.id, body: { savedViewId: view.id } });
        const prepared = {
            model: (await models.getProductionModel(reader, model.id)).model,
            versions: await require('../server/services/data-analysis/bi/versions').modelVersions(reader, model.id),
            job: await service.getModelJob(reader, job.id),
            page: await results.resultPage({ user: reader, jobId: job.id, session: 'acl-test' }),
            view: (await governance.getSavedView(reader, view.id)).view,
            dashboard: (await governance.getDashboard(reader, dashboard.id)).dashboard,
            ai: await require('../server/services/data-analysis/bi/tools').executeModelTool('analysis.modelResult', { runId: job.id }, reader),
            catalog: await require('../server/services/data-analysis/bi/tools').executeModelTool('analysis.modelCatalog', { modelId: model.id, publishedVersion: 1 }, reader)
        };
        assert.equal(prepared.job.result.total.values.average.value, '125.00');
        await governance.updateFieldGovernance({ user, datasetId: fact.id, fields: [{ fieldKey: 'c_3', sensitivity: 'restricted' }] });
        await httpFixture(name => ({ value: prepared[name] }), async request => {
            for (const name of Object.keys(prepared)) {
                const response = await request(name);
                assert.equal(response.status, 403, name);
                const body = await response.text();
                assert.equal(JSON.parse(body).code, 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
                assert.equal(body.includes('125.00'), false);
            }
        });
        assert.equal((await models.getProductionModel(reader, model.id)).model.definition.metrics.some(metric => metric.id === 'average'), false);
        await assert.rejects(service.getModelJob(reader, job.id), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
        await assert.rejects(results.resultPage({ user: reader, jobId: job.id, session: 'acl-test' }), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
        const source = await queryOne('SELECT allowed_units,allowed_user_ids FROM analysis_datasets WHERE id=?', [fact.id]);
        assert.equal(source.allowed_units, 'QA'); assert.equal(source.allowed_user_ids, '');
    });
}));

test('来源共享、模型共享、关系粒度键、单位、停用与删除均在下一次交付前重新判定', { timeout: 90000 }, async () => fixture(async context => {
    const { user, model, fact } = context;
    await published(user, model);
    await withReader(context, async ({ reader, job }) => {
        const cases = [
            { code: 'ANALYSIS_MODEL_SOURCE_UNAVAILABLE', revoke: () => execute("UPDATE analysis_datasets SET scope='personal' WHERE id=?", [fact.id]), restore: () => execute("UPDATE analysis_datasets SET scope='shared' WHERE id=?", [fact.id]) },
            { code: 'ANALYSIS_MODEL_NOT_FOUND', revoke: () => execute("UPDATE analysis_data_models SET scope='personal' WHERE id=?", [model.id]), restore: () => execute("UPDATE analysis_data_models SET scope='shared' WHERE id=?", [model.id]) },
            { code: 'ANALYSIS_MODEL_FIELD_UNAVAILABLE', revoke: () => governance.updateFieldGovernance({ user, datasetId: fact.id, fields: [{ fieldKey: 'c_1', sensitivity: 'restricted' }] }), restore: () => governance.updateFieldGovernance({ user, datasetId: fact.id, fields: [{ fieldKey: 'c_1', sensitivity: 'internal' }] }) },
            { code: 'ANALYSIS_MODEL_NOT_FOUND', revoke: () => execute("UPDATE users SET unit='Other' WHERE id=?", [reader.id]), restore: () => execute("UPDATE users SET unit='QA' WHERE id=?", [reader.id]) },
            { code: 'ANALYSIS_MODEL_NOT_FOUND', revoke: () => execute("UPDATE users SET status='disabled' WHERE id=?", [reader.id]), restore: () => execute("UPDATE users SET status='active' WHERE id=?", [reader.id]) },
            { code: 'ANALYSIS_MODEL_NOT_FOUND', revoke: () => execute('UPDATE users SET deleted_at=NOW() WHERE id=?', [reader.id]), restore: () => execute('UPDATE users SET deleted_at=NULL WHERE id=?', [reader.id]) }
        ];
        for (const item of cases) {
            const value = await service.getModelJob(reader, job.id);
            await item.revoke();
            let sent = false;
            await assert.rejects(delivery.consume(value, () => { sent = true; }), error => error.code === item.code);
            assert.equal(sent, false);
            await item.restore();
        }
    });
}));

test('响应持有授权栅栏时撤权等待，固定随机种子竞争验证提交后无新数据响应', { timeout: 90000 }, async () => fixture(async ({ user, model, fact }) => {
    const entry = { userId: user.id, modelId: model.id, definition: model.definition, required: require('../server/services/data-analysis/bi/manifests').allRequired(model.definition) };
    const locked = deferred(), release = deferred();
    const value = delivery.protect({ secret: '受控数据' }, { ...entry, beforeSend: async () => { locked.resolve(); await release.promise; } });
    const response = delivery.consume(value, body => JSON.stringify(body));
    await locked.promise;
    let revoked = false;
    const revoke = execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]).then(() => { revoked = true; });
    await delay(80); assert.equal(revoked, false);
    release.resolve(); assert.match(await response, /受控数据/);
    await revoke;
    await assert.rejects(delivery.consume(delivery.protect({ secret: '受控数据' }, entry), () => { throw new Error('撤权后不得调度新响应'); }), error => error.code === 'ANALYSIS_MODEL_NOT_FOUND');
    let seed = 0x22f06;
    for (let index = 0; index < 12; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        await execute("UPDATE users SET status='active' WHERE id=?", [user.id]);
        const payload = delivery.protect({ secret: '受控数据', seed }, entry), events = [];
        await httpFixture(async () => { await delay(seed % 7); return payload; }, async request => {
            const read = request('race').then(async result => ({ status: result.status, body: await result.text() }));
            const mutation = delay((seed >>> 8) % 7).then(() => execute("UPDATE users SET status='disabled' WHERE id=?", [user.id])).then(() => events.push('revoked'));
            const result = await read;
            events.push(result.status === 200 ? 'read' : 'denied');
            await mutation;
            assert.ok([200, 404].includes(result.status), `seed=${seed}`);
            if (result.status === 404) assert.equal(result.body.includes('受控数据'), false);
            else assert.ok(events.indexOf('sent') >= 0 && events.indexOf('sent') < events.indexOf('revoked'), `seed=${seed},events=${events}`);
            const after = await request('after');
            assert.equal(after.status, 404, `seed=${seed},events=${events}`);
        }, status => { if (status === 200) events.push('sent'); });
    }
    await execute("UPDATE users SET status='active' WHERE id=?", [user.id]);
    assert.ok(fact.id);
}));

test('真实长下载受慢客户端背压时撤权五秒内停止调度，重试、范围和旧会话令牌均不能恢复', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    await published(user, model);
    const query = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: ['region'], metrics: ['amount'], requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    const exported = await results.createModelExport({ user, jobId: query.id, body: { format: 'csv', requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-bi-download-'));
    const file = path.join(directory, 'large.csv'), fileSize = 64 * 1024 ** 2;
    const handle = await fs.open(file, 'wx');
    try { const block = Buffer.alloc(1024 ** 2, 'x'); for (let index = 0; index < 64; index++) await handle.write(block); }
    finally { await handle.close(); }
    const object = await require('../server/services/data-analysis/bi/objects').importFile({ file, userId: user.id, purpose: 'export' });
    await execute('UPDATE analysis_query_jobs SET result_object_id=? WHERE id=?', [object.id, exported.id]);
    const session = 'real-long-download', ticket = await results.issueDownload({ user, jobId: exported.id, session });
    const writes = [], first = deferred(), closed = deferred();
    const app = express();
    app.get('/download', require('../server/http').asyncHandler(async (req, res) => {
        const write = res.write;
        res.write = function recordBytes(chunk, ...args) { writes.push({ at: Date.now(), bytes: chunk.length }); first.resolve(); return write.call(this, chunk, ...args); };
        res.once('close', () => closed.resolve(Date.now()));
        await results.downloadModelExport({ user, jobId: exported.id, session, token: ticket.token, range: req.headers.range, response: res });
    }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let client;
    try {
        const responseReady = deferred();
        client = http.get(`http://127.0.0.1:${server.address().port}/download`, response => {
            response.on('error', () => {}); response.pause(); responseReady.resolve(response);
        });
        client.on('error', () => {});
        assert.equal((await responseReady.promise).statusCode, 200);
        await first.promise;
        await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
        const revokedAt = Date.now();
        const stopAt = await Promise.race([closed.promise, delay(5500).then(() => { throw new Error('长下载未在五秒内终止'); })]);
        assert.ok(stopAt - revokedAt <= 5000);
        assert.ok(writes.length > 0 && writes.every(write => write.bytes <= 65536));
        assert.ok(writes.reduce((sum, write) => sum + write.bytes, 0) < fileSize);
        assert.ok(writes.every(write => write.at <= revokedAt + 5000));
        const denied = await fetch(`http://127.0.0.1:${server.address().port}/download`, { headers: { Range: 'bytes=0-63' } });
        assert.equal(denied.status, 404);
        await execute("UPDATE users SET status='active' WHERE id=?", [user.id]);
        const old = await fetch(`http://127.0.0.1:${server.address().port}/download`, { headers: { Range: 'bytes=0-63' } });
        assert.equal(old.status, 403);
    } finally {
        client?.destroy();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        const target = path.resolve(directory), parent = path.resolve(os.tmpdir());
        assert.equal(path.dirname(target), parent);
        await fs.rm(target, { recursive: true, force: true });
    }
}));

test('真实 Agent 检查点重放与站内投递回执重新核对当前来源权限', { timeout: 90000 }, async () => fixture(async context => {
    await published(context.user, context.model);
    await withReader(context, async ({ reader, job }) => {
        const runId = `bi_acl_agent_${crypto.randomUUID()}`;
        await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'授权重放','读取固定模型结果','running','{}',NOW(),NOW())", [runId, reader.id]);
        try {
            const runtime = require('../server/services/agent-tool-runtime');
            const tools = require('../server/services/agent-tools').getBuiltInToolDefinitions(reader);
            const options = { run: { id: runId, user_id: reader.id, tool_policy: 'all', approval_policy: 'approve_all_mcp' }, stepId: 'model-result' };
            const first = await runtime.executeToolByName('analysis.modelResult', { runId: job.id }, reader, tools, options);
            assert.equal(first.result.total.values.average.value, '125.00');
            const repeated = await runtime.executeToolByName('analysis.modelResult', { runId: job.id }, reader, tools, options);
            assert.equal(repeated.id, first.id);
            assert.equal(Number((await queryOne("SELECT COUNT(*) AS n FROM agent_run_checkpoints WHERE run_id=? AND tool_name='analysis.modelResult' AND status='completed'", [runId])).n), 1);
            const receipt = await require('../server/services/data-analysis/bi/tools').assertModelDelivery({ sender: reader, runId: job.id, recipientUserIds: [Number(reader.id)], channelType: 'web' });
            await governance.updateFieldGovernance({ user: context.user, datasetId: context.fact.id, fields: [{ fieldKey: 'c_3', sensitivity: 'restricted' }] });
            await assert.rejects(runtime.executeToolByName('analysis.modelResult', { runId: job.id }, reader, tools, options), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
            let sent = false;
            await assert.rejects(delivery.consume(receipt, () => { sent = true; }), error => error.code === 'ANALYSIS_MODEL_FIELD_UNAVAILABLE');
            assert.equal(sent, false);
        } finally { await execute('DELETE FROM agent_runs WHERE id=?', [runId]); }
    });
}));
