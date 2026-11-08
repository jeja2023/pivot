'use strict';

// Child process entry points use a real application DB pool and real analysis
// execution. No service mocks or production fault switches are installed.
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../../server/db/client');
const { createFixture, checked } = require('./bi_modeling');
const jobs = require('../../server/services/data-analysis/bi/jobs');
const runner = require('../../server/services/data-analysis/bi/runner');
const journal = require('../../server/services/data-analysis/bi/security-journal');
const recovery = require('../../server/services/data-analysis/bi/security-recovery');
const governance = require('../../server/services/data-analysis/governance');
const { canonicalHash } = require('../../server/services/data-analysis/bi/canonical');

async function main(mode, inputFile) {
    if (mode === 'seed') {
        const { user, model, fact } = await createFixture(), report = await checked(user, model);
        await execute('UPDATE users SET password_hash=? WHERE id=?', [await require('../../server/services/password-hasher').hashPasswordOffThread('PhysicalFixture123!', 12), user.id]);
        await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
        const job = await jobs.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: ['region'], metrics: ['amount', 'orders', 'average'], requestKey: crypto.randomUUID() } });
        await runner.processModelJobs();
        assert.equal((await jobs.getModelJob(user, job.id)).result.total.values.amount.value, '250.00');
        const view = await require('../../server/services/data-analysis/bi/consumers').saveModelView({ user, modelId: model.id, body: { sourceRunId: job.id, name: '灾备固定视图', viewType: 'chart' } });
        const dashboard = await governance.saveDashboard({ user, body: { name: '灾备看板' } });
        await governance.saveDashboardItem({ user, dashboardId: dashboard.id, body: { sourceType: 'model', savedViewId: view.id, title: '地区金额', position: { y: 0 } } });
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids='99999999' WHERE id=?", [fact.id]);
        const sessionId = `session_${crypto.randomUUID()}`;
        await execute("INSERT INTO sessions(id,user_id,title) VALUES (?,?,'共享整库恢复前会话')", [sessionId, user.id]);
        const deleted = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id", [`physical_deleted_${crypto.randomUUID()}`]);
        await journal.flush({ force: true, full: true });
        const priorToken = require('../../server/auth').generateAccessToken(await queryOne('SELECT * FROM users WHERE id=?', [user.id]));
        return { user, modelId: model.id, factId: fact.id, jobId: job.id, viewId: view.id, dashboardId: dashboard.id, sessionId, deletedUserId: deleted.id, priorToken };
    }
    const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
    if (mode === 'revoke') {
        await execute("UPDATE analysis_datasets SET scope='personal',allowed_user_ids='' WHERE id=?", [input.factId]);
        await execute('DELETE FROM users WHERE id=?', [input.deletedUserId]);
        await execute("UPDATE sessions SET title='恢复点之后的会话修改' WHERE id=?", [input.sessionId]);
        await journal.flush({ force: true, full: true });
        return { revoked: true };
    }
    if (mode === 'closed') {
        // Even with the feature flag disabled a fresh process cannot read an
        // old physical snapshot whose independent event head did not change.
        process.env.DATA_ANALYSIS_MODEL_ENABLED = 'false';
        await assert.rejects(require('../../server/services/data-analysis/shared').getDatasetForUser(input.user, input.factId), error => error.status === 503);
        const state = await queryOne("SELECT mode,recovery_reason FROM analysis_security_state WHERE id='main'");
        assert.equal(state.mode, 'recovery_required');
        return state;
    }
    if (mode === 'replay') return recovery.replay({ reason: '隔离物理共同恢复演练：主机和本地存储均不可用。' });
    if (mode === 'reconcile') return recovery.reconcile(input);
    if (mode === 'health') {
        const admin = await queryOne("SELECT * FROM users WHERE username='admin'");
        const snapshot = await require('../../server/services/data-analysis/bi/operations').overview(admin);
        return { alerts: snapshot.alerts.map(item => item.code), recoveryAgeSeconds: Number(snapshot.health.recovery_age_seconds), probeOutcome: snapshot.probe.outcome };
    }
    if (mode === 'verify') {
        const dataset = await require('../../server/services/data-analysis/shared').getDatasetForUser(input.user, input.factId);
        assert.equal(dataset.scope, 'personal'); assert.equal(dataset.allowed_user_ids, '');
        const removed = await queryOne('SELECT status,deleted_at FROM users WHERE id=?', [input.deletedUserId]);
        assert.equal(removed.status, 'disabled'); assert.ok(removed.deleted_at);
        assert.equal((await queryOne('SELECT title FROM sessions WHERE id=?', [input.sessionId])).title, '共享整库恢复前会话');
        assert.equal((await jobs.getModelJob(input.user, input.jobId)).result.total.values.amount.value, '250.00');
        const rerun = await governance.runSavedView(input.user, input.viewId); await runner.processModelJobs();
        const result = await jobs.getModelJob(input.user, rerun.job.id);
        assert.equal(result.status, 'succeeded', result.lastError); assert.equal(result.result.total.values.average.value, '125.00');
        assert.equal((await governance.getDashboard(input.user, input.dashboardId)).dashboard.items.length, 1);
        const publications = require('../../server/repositories/analysis-model-publications'), before = await publications.binding(input.modelId, 1);
        const refresh = await jobs.createModelRefresh({ user: input.user, modelId: input.modelId, body: { publishedVersion: 1, bindingRevision: Number(before.revision), requestKey: crypto.randomUUID() } });
        await runner.processModelJobs(); assert.equal((await jobs.getModelCheck(input.user, input.modelId, refresh.check.id)).status, 'passed');
        assert.equal(Number((await publications.binding(input.modelId, 1)).revision), Number(before.revision) + 1);
        for (const format of ['csv', 'xlsx']) {
            const exported = await require('../../server/services/data-analysis/bi/results').createModelExport({ user: input.user, jobId: input.jobId, body: { format, requestKey: crypto.randomUUID() } });
            await runner.processModelJobs();
            const result = await jobs.getModelJob(input.user, exported.id); assert.equal(result.status, 'succeeded', result.lastError); assert.equal(result.result.complete, true);
            const row = await require('../../server/repositories/analysis-model-jobs').get(input.user.id, exported.id);
            const file = await require('../../server/services/data-analysis/bi/objects').verify(await require('../../server/repositories/analysis-objects').get(row.result_object_id));
            const text = format === 'csv' ? await fs.readFile(file, 'utf8') : JSON.stringify(require('@e965/xlsx').read(await fs.readFile(file), { type: 'buffer' }).Sheets);
            assert.ok(text.includes('250.00')); assert.ok(text.includes('125.00'));
        }
        const http = require('node:http'), server = http.createServer(require('../../server/app').app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const base = `http://127.0.0.1:${server.address().port}`, login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: input.user.username, password: 'PhysicalFixture123!' }) });
            assert.equal(login.status, 200, await login.text());
            const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
            for (const [route, expected] of [[`/api/apps/data-analysis/async-queries/${input.jobId}/results`, '250.00'], [`/api/apps/data-analysis/views/${input.viewId}`, '灾备固定视图'], [`/api/apps/data-analysis/dashboards/${input.dashboardId}`, '灾备看板'], [`/api/sessions/${input.sessionId}`, '共享整库恢复前会话']]) {
                const response = await fetch(`${base}${route}`, { headers: { cookie } }); const body = await response.text();
                assert.equal(response.status, 200, body); assert.ok(body.includes(expected), route);
            }
            const old = await fetch(`${base}/api/apps/data-analysis/async-queries/${input.jobId}/results`, { headers: { authorization: `Bearer ${input.priorToken}` } });
            assert.equal(old.status, 401);
            const adminLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD }) });
            assert.equal(adminLogin.status, 200, await adminLogin.text());
            const adminCookie = adminLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
            const denied = await fetch(`${base}/api/apps/data-analysis/async-queries/${input.jobId}/results`, { headers: { cookie: adminCookie } });
            assert.ok([403, 404].includes(denied.status));
        } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
        process.env.PIVOT_ALERT_WEBHOOK_URL = ''; await require('../../server/services/app-settings').setAppSetting('observability_webhook_url', '');
        const admin = await queryOne("SELECT * FROM users WHERE username='admin'"), probe = require('../../server/services/data-analysis/bi/operation-probe');
        await probe.bootstrap(admin); await probe.tick(); await runner.processModelJobs(); await probe.tick();
        const snapshot = await require('../../server/services/data-analysis/bi/operations').overview(admin);
        assert.equal(snapshot.probe.outcome, 'succeeded'); assert.ok(snapshot.alerts.some(item => item.code === 'recovery_point_lag'));
        return { fixedResult: '250.00', recomputedAverage: '125.00', sourceRevocationRetained: true, deletedPrincipalDenied: true, sessionPointRestored: true, dashboardRestored: true,
            actualLoginAndHttpReads: true, oldTokenDenied: true, otherUserHttpDenied: true, refreshRechecked: true, csvAndXlsxRechecked: true, positiveAndNegativeProbe: true, recoveryLagAlert: true };
    }
    if (mode === 'sign') {
        const draft = await recovery.prepareAuthorityDraft();
        const expected = new Map(input.resources.map(item => [`${item.target_table}:${item.target_id}`, item]));
        const resources = draft.resources.map(item => {
            const current = expected.get(`${item.target_table}:${item.target_id}`);
            if (current) return current;
            assert.ok(item.tombstone || item.payload_json.deleted_at, '当前独立身份源不认识恢复后的活跃资源，禁止从旧库猜测。');
            return { ...item, tombstone: true, payload_json: { ...item.payload_json, ...(item.target_table === 'users' ? { status: 'disabled' } : {}) } };
        });
        const body = { ...draft, requiresCurrentAuthorityReview: false, authority: '演练故障前独立保存的当前授权源', approvedBy: '本地隔离演练负责人', reason: '逐项核对当前授权与删除墓碑。',
            approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), resources };
        const privateKey = crypto.createPrivateKey(input.privateKey);
        return { body, signature: crypto.sign(null, Buffer.from(canonicalHash(body)), privateKey).toString('base64url') };
    }
    throw new Error('未知隔离恢复应用操作。');
}
if (require.main === module) main(...process.argv.slice(2)).then(async result => {
    const output = process.argv[4];
    if (output) await fs.writeFile(output, JSON.stringify(result), { mode: 0o600 });
    else process.stdout.write(JSON.stringify(result) + '\n');
}).catch(error => { process.stderr.write((error.stack || error.message) + '\n'); process.exitCode = 1; }).finally(() => require('../../server/db/pg-connection').closePgPool());
