'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const models = require('../server/services/data-analysis/bi/models');
const service = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');
const jobs = require('../server/repositories/analysis-model-jobs');

process.env.DATA_ANALYSIS_MODEL_ENABLED = 'true';
process.env.DATA_ANALYSIS_MODEL_RUNTIME = 'development_process';

const { fixture, checked } = require('../scripts/test_support/bi_modeling');

test('真实 PostgreSQL 与独立 DuckDB 进程贯通草稿、持久检查、幂等发布与统一精确分析', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    const report = await checked(user, model);
    const publish = { user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } };
    const first = await service.publishModel(publish);
    assert.equal(first.version, 1); assert.equal((await service.publishModel(publish)).version, 1);
    const body = { publishedVersion: 1, dimensions: ['region'], metrics: ['amount', 'orders', 'average'], limit: 1, orderBy: [{ metricId: 'amount', direction: 'desc' }], requestKey: crypto.randomUUID() };
    const query = await service.createModelQuery({ user, modelId: model.id, body });
    assert.equal((await service.createModelQuery({ user, modelId: model.id, body })).id, query.id);
    await assert.rejects(service.createModelQuery({ user, modelId: model.id, body: { ...body, limit: 2 } }), error => error.code === 'ANALYSIS_MODEL_REQUEST_CONFLICT');
    await runner.processModelJobs();
    const result = await service.getModelJob(user, query.id);
    assert.equal(result.status, 'succeeded', result.lastError);
    assert.equal(result.result.rows[0].values.amount.value, '200.00');
    assert.equal(result.result.total.values.amount.value, '250.00');
    assert.equal(result.result.total.values.average.value, '125.00');
    assert.equal(result.result.truncated, true);
    assert.ok((await jobs.get(user.id, query.id)).result_object_id);
    const changed = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, grainDescription: '编辑中的新说明' } } });
    assert.equal(changed.publishedVersion, 1);
    await assert.rejects(service.publishModel({ ...publish, body: { ...publish.body, expectedVersion: changed.version, requestKey: crypto.randomUUID() } }), error => error.code === 'ANALYSIS_MODEL_CHECK_REQUIRED');
}));

test('固定版本视图、重新计算的透视小计与仪表盘共用授权语义，升级需要明确确认', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    const consumers = require('../server/services/data-analysis/bi/consumers');
    const governance = require('../server/services/data-analysis/governance');
    const report = await checked(user, model);
    await service.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
    const run = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: ['region'], metrics: ['amount', 'orders', 'average'], limit: 10, requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    const view = await consumers.saveModelView({ user, modelId: model.id, body: { sourceRunId: run.id, name: '订单地区分析', viewType: 'chart' } });
    assert.equal(view.publishedVersion, 1); assert.equal(view.binding.strategy, 'latest_checked');
    assert.ok((await governance.listSavedViews(user)).some(item => item.id === view.id && item.sourceType === 'model'));
    const rerun = await governance.runSavedView(user, view.id);
    await runner.processModelJobs();
    assert.equal((await service.getModelJob(user, rerun.job.id)).result.total.values.average.value, '125.00');
    const pivot = await consumers.createModelPivot({ user, jobId: run.id, body: { requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    assert.equal((await service.getModelJob(user, pivot.cell.id)).result.total.values.orders.value, '2');
    const dashboard = await governance.saveDashboard({ user, body: { name: '订单经营看板' } });
    const item = await governance.saveDashboardItem({ user, dashboardId: dashboard.id, body: { sourceType: 'model', savedViewId: view.id, title: '地区金额', position: { y: 0 } } });
    assert.equal(item.sourceType, 'model');
    const refreshed = await governance.refreshDashboard({ user, dashboardId: dashboard.id });
    assert.equal(refreshed.status, 'running');
    await runner.processModelJobs();
    const rendered = await governance.getDashboard(user, dashboard.id);
    const snapshot = rendered.dashboard.lastSnapshot.items.find(snapshot => snapshot.itemId === item.id);
    assert.equal(snapshot.status, 'succeeded'); assert.equal(snapshot.result.total.values.amount.value, '250.00');
    assert.equal((await queryOne('SELECT status FROM analysis_refresh_runs WHERE id=?', [refreshed.runId])).status, 'succeeded');
    const dependencies = await require('../server/services/data-analysis/bi/versions').modelDependencies(user, model.id);
    assert.equal(dependencies.views.length, 1); assert.equal(dependencies.dashboards.length, 1);
    const edited = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, metrics: model.definition.metrics.map(metric => metric.id === 'amount' ? { ...metric, name: '新版金额' } : metric) } } });
    const nextReport = await checked(user, edited);
    await service.publishModel({ user, modelId: model.id, body: { expectedVersion: edited.version, checkId: nextReport.id, requestKey: crypto.randomUUID() } });
    assert.equal((await governance.getSavedView(user, view.id)).view.publishedVersion, 1);
    const next = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 2, dimensions: ['region'], metrics: ['amount'], requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    await assert.rejects(consumers.saveModelView({ user, modelId: model.id, viewId: view.id, body: { sourceRunId: next.id, name: view.name, expectedVersion: view.version } }), error => error.code === 'ANALYSIS_MODEL_VIEW_UPGRADE_REQUIRED');
    const upgraded = await consumers.saveModelView({ user, modelId: model.id, viewId: view.id, body: { sourceRunId: next.id, name: view.name, expectedVersion: view.version, confirmUpgrade: true } });
    assert.equal(upgraded.publishedVersion, 2);
    assert.equal((await governance.getDashboard(user, dashboard.id)).dashboard.items[0].publishedVersion, 1);
}));

test('候选刷新按绑定修订切换，历史运行固定旧清单，破坏性治理变化保留上次成功数据', { timeout: 60000 }, async () => fixture(async ({ user, model, fact }) => {
    const publication = require('../server/repositories/analysis-model-publications');
    const report = await checked(user, model);
    await service.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
    const before = await publication.binding(model.id, 1);
    const replacement = await require('../server/services/data-analysis/datasets').createDatasetFromRows({ user, name: '订单新批次', rows: [{ 订单: 'a', 明细: '1', 金额: '100.25', 地区: '北' }, { 订单: 'a', 明细: '2', 金额: '99.75', 地区: '北' }, { 订单: 'b', 明细: '1', 金额: '50.00', 地区: '南' }, { 订单: 'c', 明细: '1', 金额: '25.00', 地区: '南' }] });
    const replacementRow = await queryOne('SELECT parquet_path,row_count FROM analysis_datasets WHERE id=?', [replacement.id]);
    await execute('UPDATE analysis_datasets SET parquet_path=?,row_count=?,source_version=source_version+1,updated_at=NOW() WHERE id=?', [replacementRow.parquet_path, replacementRow.row_count, fact.id]);
    const request = { user, modelId: model.id, body: { publishedVersion: 1, bindingRevision: Number(before.revision), requestKey: crypto.randomUUID() } };
    const refresh = await service.createModelRefresh(request);
    assert.equal((await service.createModelRefresh(request)).job.id, refresh.job.id);
    await assert.rejects(service.createModelRefresh({ ...request, body: { ...request.body, requestKey: crypto.randomUUID() } }), error => error.code === 'ANALYSIS_MODEL_REFRESH_RUNNING');
    await runner.processModelJobs();
    assert.equal((await service.getModelCheck(user, model.id, refresh.check.id)).status, 'passed');
    const after = await publication.binding(model.id, 1);
    assert.equal(Number(after.revision), Number(before.revision) + 1); assert.notEqual(after.manifest_id, before.manifest_id);
    const latest = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: [], metrics: ['amount'], requestKey: crypto.randomUUID() } });
    const historical = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: [], metrics: ['amount'], binding: { strategy: 'historical', manifestId: before.manifest_id }, requestKey: crypto.randomUUID() } });
    await runner.processModelJobs(); await runner.processModelJobs();
    assert.equal((await service.getModelJob(user, latest.id)).result.total.values.amount.value, '275.00');
    assert.equal((await service.getModelJob(user, historical.id)).result.total.values.amount.value, '250.00');
    await require('../server/services/data-analysis/governance').updateFieldGovernance({ user, datasetId: fact.id, fields: [{ fieldKey: 'c_3', unit: '万元', logicalType: 'number' }] });
    const breaking = await service.createModelRefresh({ ...request, body: { ...request.body, bindingRevision: Number(after.revision), requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    const failed = await service.getModelCheck(user, model.id, breaking.check.id);
    assert.equal(failed.status, 'incomplete'); assert.equal(failed.report.blockers[0].code, 'ANALYSIS_MODEL_SOURCE_SEMANTICS_CHANGED');
    const retained = await publication.binding(model.id, 1);
    assert.equal(retained.manifest_id, after.manifest_id); assert.equal(retained.data_state, 'refresh_failed');
}));

test('共享需要实际来源权限与另一位人员的复核，证据不可改写，解除共享立即撤销历史读取', { timeout: 60000 }, async () => fixture(async ({ user, model, fact }) => {
    const sharing = require('../server/services/data-analysis/bi/sharing');
    const other = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [`bi_reviewer_${crypto.randomBytes(5).toString('hex')}`]);
    try {
        const report = await checked(user, model);
        await service.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
        const proposal = { expectedVersion: model.version, scope: 'shared', allowedUnits: '', allowedUserIds: String(other.id), reviewerId: Number(other.id), checkId: report.id, requestKey: crypto.randomUUID() };
        await assert.rejects(sharing.requestModelReview({ user, modelId: model.id, body: proposal }), error => error.code === 'ANALYSIS_MODEL_SOURCE_UNAVAILABLE');
        await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(other.id), fact.id]);
        await assert.rejects(sharing.requestModelReview({ user, modelId: model.id, body: { ...proposal, reviewerId: Number(user.id), requestKey: crypto.randomUUID() } }), error => error.code === 'ANALYSIS_MODEL_REVIEWER_INVALID');
        const review = await sharing.requestModelReview({ user, modelId: model.id, body: proposal });
        assert.equal((await sharing.getModelReview(other, review.id)).definition.grainDescription, '一条订单商品明细');
        await assert.rejects(sharing.changeModelSharing({ user, modelId: model.id, body: { ...proposal, reviewId: review.id } }), error => error.code === 'ANALYSIS_MODEL_REVIEW_REQUIRED');
        await assert.rejects(sharing.decideModelReview({ user: other, reviewId: review.id, body: { approved: true, comment: '核对完成', confirmations: ['grain'] } }), error => error.code === 'ANALYSIS_MODEL_REVIEW_INVALID');
        await sharing.decideModelReview({ user: other, reviewId: review.id, body: { approved: true, comment: '粒度、实付金额、范围与时间均已核对', confirmations: ['grain', 'metrics', 'coverage', 'freshness', 'warnings', 'scope'] } });
        await assert.rejects(execute("UPDATE analysis_model_reviews SET comment='改写' WHERE id=?", [review.id]), error => error.code === 'P0001');
        const shared = await sharing.changeModelSharing({ user, modelId: model.id, body: { ...proposal, reviewId: review.id } });
        assert.equal(shared.scope, 'shared');
        assert.equal((await models.getProductionModel(other, model.id)).model.availability, 'available');
        await sharing.changeModelSharing({ user, modelId: model.id, body: { expectedVersion: shared.version, scope: 'personal' } });
        await assert.rejects(models.getProductionModel(other, model.id), error => error.status === 404);
    } finally {
        await execute('UPDATE analysis_data_models SET sharing_review_id=NULL WHERE id=?', [model.id]);
        await execute('DELETE FROM analysis_model_reviews WHERE reviewer_id=?', [other.id]);
        await execute('DELETE FROM analysis_audit_events WHERE user_id=?', [other.id]);
        await execute('DELETE FROM users WHERE id=?', [other.id]);
    }
}));

test('取消意图优先于完成，过期执行代次不能续租、提交或释放新槽位', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    const created = await service.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    const claim = await jobs.claim({ owner: 'first_owner' });
    assert.equal(claim.id, created.job.id);
    await jobs.cancel(user.id, claim.id);
    assert.equal(await jobs.renew(claim), false);
    assert.equal(await jobs.complete(claim, { report: { passed: true, complete: true }, authorize: () => { throw new Error('取消后不能进入授权或提交'); } }), false);
    await jobs.fail(claim, { code: 'ANALYSIS_MODEL_QUERY_CANCELLED', message: '分析已取消。' });
    assert.equal((await jobs.get(user.id, claim.id)).status, 'cancelled');
    const next = await service.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    const old = await jobs.claim({ owner: 'old_owner' }); assert.equal(old.id, next.job.id);
    await execute("UPDATE analysis_query_jobs SET lease_expires_at=NOW()-INTERVAL '1 minute' WHERE id=?", [old.id]);
    assert.equal(await jobs.renew(old), false);
    await jobs.fail(old, { code: 'ANALYSIS_MODEL_LEASE_EXPIRED', message: '旧执行器已隔离。', retryable: true });
    await execute("UPDATE analysis_query_jobs SET next_run_at=NOW() WHERE id=?", [old.id]);
    const current = await jobs.claim({ owner: 'new_owner' });
    assert.equal(current.execution_epoch, Number(old.execution_epoch) + 1);
    assert.equal(await jobs.renew(old), false);
    assert.equal(await jobs.complete(old, { authorize: () => {} }), false);
    await jobs.releaseSlot(old);
    assert.equal((await queryOne('SELECT job_id FROM analysis_runtime_slots WHERE id=?', [current.slot_id])).job_id, current.id);
    await jobs.fail(current, { code: 'ANALYSIS_MODEL_QUERY_CANCELLED', message: '测试结束，已停止。' });
}));

test('同一运行的分页、CSV 和 XLSX 数值一致，导出覆盖 Top N 之外分组，凭据绑定会话和当前权限', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    const fs = require('node:fs/promises'), XLSX = require('@e965/xlsx');
    const results = require('../server/services/data-analysis/bi/results');
    const objects = require('../server/services/data-analysis/bi/objects');
    const objectRepository = require('../server/repositories/analysis-objects');
    const report = await checked(user, model);
    await service.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
    const query = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: ['region'], metrics: ['amount', 'orders', 'average'], limit: 2, orderBy: [{ metricId: 'amount', direction: 'desc' }], requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    const first = await results.resultPage({ user, jobId: query.id, session: 'first-session', limit: 1 });
    assert.equal(first.rows[0].values.amount.value, '200.00'); assert.ok(first.nextCursor);
    const second = await results.resultPage({ user, jobId: query.id, session: 'first-session', limit: 1, cursor: first.nextCursor });
    assert.equal(second.rows[0].values.amount.value, '50.00'); assert.equal(second.nextCursor, null); assert.equal(second.total.values.amount.value, '250.00');
    await assert.rejects(results.resultPage({ user, jobId: query.id, session: 'other-session', limit: 1, cursor: first.nextCursor }), error => error.code === 'ANALYSIS_MODEL_RESULT_TOKEN_INVALID');
    await assert.rejects(results.resultPage({ user, jobId: query.id, session: 'first-session', limit: 1, cursor: first.nextCursor.slice(0, -5) + 'xxxxx' }), error => error.code === 'ANALYSIS_MODEL_RESULT_TOKEN_INVALID');
    await assert.rejects(results.resultPage({ user, jobId: query.id, session: 'first-session', limit: 101 }), error => error.code === 'ANALYSIS_MODEL_PAGE_INVALID');
    const top = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: ['region'], metrics: ['amount'], limit: 1, requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    for (const format of ['csv', 'xlsx']) {
        const request = { user, jobId: top.id, body: { format, requestKey: crypto.randomUUID() } };
        const exported = await results.createModelExport(request);
        assert.equal((await results.createModelExport(request)).id, exported.id);
        await runner.processModelJobs();
        const finished = await service.getModelJob(user, exported.id);
        assert.equal(finished.status, 'succeeded', finished.lastError); assert.equal(finished.result.rowCount, 2); assert.equal(finished.result.complete, true);
        const row = await jobs.get(user.id, exported.id), object = await objectRepository.get(row.result_object_id);
        const file = await objects.verify(object);
        if (format === 'csv') {
            const text = await fs.readFile(file, 'utf8');
            assert.equal(text.split('\r\n').filter(line => line.startsWith('"data",')).length, 2);
            assert.match(text, /"250\.00"/); assert.match(text, /"来源清单"/); assert.match(text, /"decimal_string"/);
        } else {
            const book = XLSX.read(await fs.readFile(file), { type: 'buffer' });
            assert.ok(book.Sheets['运行说明']);
            const cells = Object.values(book.Sheets['分析结果']).filter(cell => cell && cell.v === '250.00');
            assert.equal(cells.length, 1); assert.equal(cells[0].t, 's');
        }
        const ticket = await results.issueDownload({ user, jobId: exported.id, session: 'first-session' });
        assert.equal(ticket.expiresIn, 60); assert.ok(ticket.token); assert.ok(!JSON.stringify(ticket).includes(object.storage_key));
    }
    await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
    await assert.rejects(results.resultPage({ user, jobId: query.id, session: 'first-session', cursor: first.nextCursor, limit: 1 }), error => error.status === 404);
}));

test('受控问数与工作流明确条件后复用正式任务，停用和接收者缺权限拒绝读取与投递', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    const tools = require('../server/services/data-analysis/bi/tools');
    const report = await checked(user, model);
    await service.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
    const catalog = await tools.executeModelTool('analysis.modelCatalog', { modelId: model.id, publishedVersion: 1 }, user);
    assert.ok(catalog.metrics.some(metric => metric.id === 'amount')); assert.ok(catalog.dimensions.some(dimension => dimension.id === 'region'));
    const input = { modelId: model.id, publishedVersion: 1, metrics: ['amount'], dimensions: [], requestKey: crypto.randomUUID() };
    const preview = await tools.executeModelTool('analysis.modelQuery', input, user);
    assert.equal(preview.requiresConfirmation, true); assert.equal(preview.resolvedConditions.timezone, 'Asia/Shanghai');
    const execution = await tools.executeModelTool('analysis.modelQuery', { ...input, confirmed: true }, user, { runId: 'workflow-qa', node: { id: 'query' } });
    assert.equal((await tools.executeModelTool('analysis.modelQuery', { ...input, confirmed: true }, user, { runId: 'workflow-qa', node: { id: 'query' } })).job.id, execution.job.id);
    await runner.processModelJobs();
    const result = await tools.executeModelTool('analysis.modelResult', { runId: execution.job.id }, user);
    assert.equal(result.result.total.values.amount.value, '250.00'); assert.equal(result.analysisSource.manifestId, result.manifestId);
    await assert.rejects(tools.executeModelTool('analysis.modelQuery', { ...input, sql: 'SELECT 1' }, user), error => error.code === 'ANALYSIS_MODEL_QUERY_INVALID');
    const binding = `bi_notice_${crypto.randomUUID()}`;
    await execute("INSERT INTO agent_channel_bindings(id,user_id,channel_type,channel_key,status) VALUES (?,?,'web',?,'active')", [binding, user.id, binding]);
    const channels = require('../server/services/agent-channel-adapters');
    const delivery = await channels.enqueueChannelDelivery(user, { bindingId: binding, body: '订单金额 250.00', eventType: 'workflow.notify', interaction: { analysisSource: { runId: result.id, recipientUserIds: [Number(user.id)] } }, idempotencyKey: crypto.randomUUID() });
    try {
        await assert.rejects(tools.assertModelDelivery({ sender: user, runId: result.id, recipientUserIds: [Number(user.id)], channelType: 'email' }), error => error.code === 'ANALYSIS_MODEL_DELIVERY_DENIED');
        await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
        assert.equal((await channels.deliverChannelDelivery(delivery.id)).status, 'dead_letter');
        await assert.rejects(tools.executeModelTool('analysis.modelResult', { runId: result.id }, user), error => error.status === 404);
    } finally {
        await execute('DELETE FROM agent_channel_deliveries WHERE binding_id=?', [binding]); await execute('DELETE FROM agent_channel_bindings WHERE id=?', [binding]);
    }
}));

test('HTTP 合同验证当前会话、结构化输入、运行分页及受控范围下载，撤权后拒绝旧令牌', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    const express = require('express'), http = require('node:http');
    const { authMiddleware, generateAccessToken } = require('../server/auth');
    const app = express(); app.use(express.json());
    require('../server/routes/apps/data-analysis-model-routes').registerDataAnalysisModelRoutes(app, { authMiddleware });
    app.use((error, _req, res, _next) => { res.status(error.status || 500).json({ code: error.code, error: error.message }); });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const token = generateAccessToken(user, { sessionIp: '127.0.0.1' });
    const request = async (path, method = 'GET', body = undefined, headers = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/apps/data-analysis${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* 导出返回原始文件字节。 */ }
        return { status: response.status, headers: response.headers, json, text };
    };
    try {
        const check = await request(`/models/${model.id}/checks`, 'POST', { expectedVersion: model.version, requestKey: crypto.randomUUID() });
        assert.equal(check.status, 202, JSON.stringify(check.json)); await runner.processModelJobs();
        const report = await request(`/models/${model.id}/checks/${check.json.check.id}`);
        assert.equal(report.json.check.status, 'passed');
        const published = await request(`/models/${model.id}/publish`, 'POST', { expectedVersion: model.version, checkId: check.json.check.id, requestKey: crypto.randomUUID() });
        assert.equal(published.status, 200);
        const bad = await request(`/models/${model.id}/queries`, 'POST', { publishedVersion: 1, metrics: ['amount'], sql: 'SELECT 1', requestKey: crypto.randomUUID() });
        assert.equal(bad.status, 400); assert.equal(bad.json.code, 'ANALYSIS_MODEL_QUERY_INVALID');
        const query = await request(`/models/${model.id}/queries`, 'POST', { publishedVersion: 1, dimensions: ['region'], metrics: ['amount'], execution: 'async', requestKey: crypto.randomUUID() });
        assert.equal(query.status, 202); await runner.processModelJobs();
        const page = await request(`/async-queries/${query.json.job.id}/results?limit=1`);
        assert.equal(page.status, 200); assert.equal(page.json.total.values.amount.value, '250.00'); assert.match(page.headers.get('cache-control'), /no-store/);
        assert.equal((await request(`/async-queries/${query.json.job.id}/results?limit=101`)).status, 400);
        const exported = await request(`/async-queries/${query.json.job.id}/exports`, 'POST', { format: 'csv', requestKey: crypto.randomUUID() });
        assert.equal(exported.status, 202); await runner.processModelJobs();
        const ticket = await request(`/async-queries/${exported.json.job.id}/download-token`, 'POST', {});
        assert.equal(ticket.status, 200); assert.equal(ticket.json.expiresIn, 60);
        const contentPath = `/async-queries/${exported.json.job.id}/export-content`;
        const download = await request(contentPath, 'GET', undefined, { 'X-Analysis-Download-Token': ticket.json.token, Range: 'bytes=0-63' });
        assert.equal(download.status, 206); assert.equal(download.headers.get('content-length'), '64'); assert.match(download.headers.get('content-range'), /^bytes 0-63\//);
        assert.equal((await request(contentPath, 'GET', undefined, { 'X-Analysis-Download-Token': ticket.json.token, Range: 'bytes=999999999-' })).status, 416);
        assert.equal((await request(contentPath, 'GET', undefined, { 'X-Analysis-Download-Token': ticket.json.token.slice(0, -5) + 'xxxxx' })).status, 403);
        await execute('UPDATE users SET token_version=token_version+1 WHERE id=?', [user.id]);
        assert.equal((await request(contentPath, 'GET', undefined, { 'X-Analysis-Download-Token': ticket.json.token })).status, 401);
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}));

test('二维透视逐格、行列小计与总计复用同一清单，精确去重和比率在各自范围重算', { timeout: 60000 }, async () => fixture(async ({ user, model }) => {
    model = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition,
        dimensions: [...model.definition.dimensions, { id: 'line', name: '明细号', nodeId: 'fact', fieldKey: 'c_2' }], metrics: model.definition.metrics.map(metric => ({ ...metric, allowedDimensionIds: ['region', 'line'] })) } } });
    const report = await checked(user, model);
    await service.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
    const run = await service.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: ['region', 'line'], metrics: ['amount', 'orders', 'average'], requestKey: crypto.randomUUID() } });
    await runner.processModelJobs();
    const pivot = await require('../server/services/data-analysis/bi/consumers').createModelPivot({ user, jobId: run.id, body: { requestKey: crypto.randomUUID() } });
    for (let index = 0; index < 3; index++) await runner.processModelJobs();
    const [cells, rows, columns] = await Promise.all([pivot.cell, pivot.rowTotals, pivot.columnTotals].map(job => service.getModelJob(user, job.id)));
    assert.ok([cells, rows, columns].every(job => job.status === 'succeeded' && job.manifestId === pivot.manifestId && job.publishedVersion === 1));
    const values = record => ['amount', 'orders', 'average'].map(id => record.values[id].value);
    const find = (result, expected) => result.rows.find(row => Object.entries(expected).every(([id, label]) => row.members[id].label === label));
    assert.deepEqual(values(find(cells.result, { region: '北', line: '1' })), ['100.25', '1', '100.25']);
    assert.deepEqual(values(find(cells.result, { region: '北', line: '2' })), ['99.75', '1', '99.75']);
    assert.deepEqual(values(find(cells.result, { region: '南', line: '1' })), ['50.00', '1', '50.00']);
    assert.deepEqual(values(find(rows.result, { region: '北' })), ['200.00', '1', '200.00']);
    assert.deepEqual(values(find(columns.result, { line: '1' })), ['150.25', '2', '75.13']);
    assert.deepEqual(values(find(columns.result, { line: '2' })), ['99.75', '1', '99.75']);
    for (const result of [cells.result, rows.result, columns.result]) assert.deepEqual(values(result.total), ['250.00', '2', '125.00']);
}));
