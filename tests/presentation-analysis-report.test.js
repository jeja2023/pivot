'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { queryOne, query, execute } = require('../server/db/client');
const { createDatasetFromRows, buildChart } = require('../server/services/data-analysis');
const { createAnalysisReport, toPresentationChart, buildAnalysisReportPlan } = require('../server/services/presentations/presentation-analysis-report');
const { buildPresentationDataNarrative } = require('../server/services/presentations/presentation-data-narrative');
const { assertAnalysisSources, preserveAnalysisSources, readAnalysisChart, digest } = require('../server/services/presentations/presentation-analysis-sources');

const chartFixture = () => ({ chartType: 'bar', title: '区域收入', xAxis: { field: 'c_1', label: '区域' },
    yAxis: { field: 'c_2', label: '收入', aggregation: 'sum' }, labels: ['华东', '华南'], series: [{ name: '收入', data: [120, 180] }],
    design: { sortBy: 'value', sortOrder: 'desc', limit: 30 }, source: { rows: 2, sourceVersion: 1, generatedAt: '2026-11-09T00:00:00Z' } });

test('汇报从数值快照构建，拒绝缺失值、复杂图类型与不完整序列，不把无效值改成零', () => {
    const chart = chartFixture();
    assert.deepEqual(toPresentationChart(chart).data.rows, [['华东', 120], ['华南', 180]]);
    for (const value of [null, '', '120', false, NaN, Infinity]) {
        const input = globalThis.structuredClone(chart); input.series[0].data[1] = value;
        assert.throws(() => toPresentationChart(input), error => error.code === 'PRESENTATION_ANALYSIS_CHART_INVALID');
    }
    assert.throws(() => toPresentationChart({ ...chart, chartType: 'dual_axis' }), error => error.code === 'PRESENTATION_ANALYSIS_CHART_UNSUPPORTED');
    assert.throws(() => toPresentationChart({ ...chart, series: [{ data: [1] }] }), error => error.code === 'PRESENTATION_ANALYSIS_CHART_INVALID');
    const precise = globalThis.structuredClone(chart); precise.series[0].data[0] = 0.123456789;
    const converted = toPresentationChart(precise);
    const content = require('../server/services/presentations/presentation-design-content').buildDesignPresentation({ title: '精度', slides: [
        { title: '精度', layout: 'chart', chart: { type: 'bar', ...converted.data } }
    ] }, require('../server/services/presentations/presentation-templates').getBuiltInTemplate('executive-clean'));
    assert.equal(content.slides[0].elements.find(element => element.type === 'chart').data.rows[0][1], 0.123456789);
});

test('类别排序不生成趋势，空值不使最高值错配到其它分类，零基期不产生无穷增长率', () => {
    const categorical = buildPresentationDataNarrative({ data: { columns: ['地区', '收入'], rows: [['华东', null], ['华南', 180], ['华北', 120]] }, design: { sortBy: 'value' } });
    assert.match(categorical.headline, /华南.*180/);
    assert.doesNotMatch(categorical.annotation, /增加|减少|变化.*%/);
    const trend = buildPresentationDataNarrative({ data: { columns: ['季度', '收入'], rows: [['Q1', 0], ['Q2', 120]] } });
    assert.match(trend.annotation, /增加 120/); assert.doesNotMatch(trend.annotation, /Infinity|%/);
    const lexicalDates = buildPresentationDataNarrative({ data: { columns: ['月份', '收入'], rows: [['2026年10月', 180], ['2026年2月', 120]] }, design: { sortBy: 'label', sortOrder: 'asc' } });
    assert.doesNotMatch(lexicalDates.annotation, /增加|减少|变化.*%/);
});

test('明细覆盖所有展示分类，导入截断与固定口径进入汇报，来源不能通过保存移除', () => {
    const chart = chartFixture(); chart.labels = Array.from({ length: 25 }, (_, i) => `地区${i}`); chart.series[0].data = chart.labels.map((_, i) => i);
    chart.source.truncated = true;
    const plan = buildAnalysisReportPlan({ chart, dataset: { id: 'ds_test', name: '销售' }, artifactId: 'art_test', digest: 'abc' }, '汇报');
    const tables = plan.slides.filter(slide => slide.table);
    assert.equal(tables.flatMap(slide => slide.table.rows).length, 25);
    assert.equal(plan.slides.filter(slide => slide.chart).flatMap(slide => slide.chart.rows).length, 25);
    assert.match(plan.caveat, /截断/);
    const saved = preserveAnalysisSources({ sources: [plan.source] }, { sources: [{ ...plan.source, analysisBinding: undefined }] });
    assert.deepEqual(saved.sources, [plan.source]);
});

test('读取与派生交付始终重查当前数据版本、字段权限、快照摘要和原所有者', async () => {
    const chart = chartFixture(), content = JSON.stringify(chart), user = { id: 7 }, calls = [];
    const deps = { ownerId: 9, readChart: async (id, owner) => { calls.push([id, owner]); return { id, dataset_id: 'ds_test', content }; },
        getDataset: async actor => { assert.equal(actor, user); return { id: 'ds_test', source_version: 1 }; },
        assertFields: async (_actor, _dataset, fields) => { assert.deepEqual(fields, ['c_1', 'c_2']); } };
    const source = { id: 'analysis_source', digest: digest(content), analysisBinding: { artifactId: 'art_test', datasetId: 'ds_test', sourceVersion: 1 } };
    await assertAnalysisSources({ sources: [source] }, user, deps);
    assert.deepEqual(calls, [['art_test', 9]]);
    await assert.rejects(assertAnalysisSources({ sources: [{ ...source, digest: 'forged' }] }, user, deps), error => error.code === 'PRESENTATION_ANALYSIS_BINDING_INVALID');
    await assert.rejects(readAnalysisChart(user, 'art_test', { ...deps, getDataset: async () => ({ source_version: 2 }) }), error => error.code === 'PRESENTATION_ANALYSIS_STALE');
    await assert.rejects(readAnalysisChart(user, 'art_test', { ...deps, assertFields: async () => { throw Object.assign(new Error('当前字段不可用'), { status: 403 }); } }), error => error.status === 403);
});

test('共享来源撤回后，个人汇报、历史版本和已签发投屏会话均不可继续读取', { timeout: 60000 }, async () => {
    const owner = await queryOne("SELECT id,username,unit,role,status FROM users WHERE username='admin'");
    const viewer = await queryOne("INSERT INTO users(username,password_hash,unit,role,status) VALUES (?,'test-hash','汇报验收','user','active') RETURNING id,username,unit,role,status", [`report-${crypto.randomUUID()}`]);
    viewer.tenant_id = 1;
    const dataset = await createDatasetFromRows({ user: owner, name: '共享来源撤回验收', rows: [{ region: '华东', amount: 120 }] });
    await execute("UPDATE analysis_datasets SET scope='shared',allowed_user_ids=? WHERE id=?", [String(viewer.id), dataset.id]);
    const { chart } = await buildChart(viewer, dataset.id, { xField: 'c_1', yField: 'c_2', aggregation: 'sum' });
    const { presentation } = await createAnalysisReport(viewer, { artifactId: chart.artifactId, requestKey: crypto.randomUUID() });
    const service = require('../server/services/presentations/presentation-service');
    const remote = await service.createPresentationRemoteSession(viewer, presentation.id);
    assert.ok(await service.getPresentationVersion(viewer, presentation.id, 1));
    assert.ok(await service.getPresentationRemoteState(remote.token));
    const manager = new (require('../server/services/agent-runtime/artifact-manager').ArtifactManager)();
    await assert.rejects(manager.share(presentation.artifactId, viewer), error => error.code === 'ARTIFACT_PUBLIC_SOURCE_DENIED');
    const oldShare = await queryOne("INSERT INTO agent_artifact_shares(artifact_id,visibility) VALUES (?,'public') RETURNING id", [presentation.artifactId]);
    await assert.rejects(manager.getShared(oldShare.id), error => error.code === 'ARTIFACT_PUBLIC_SOURCE_DENIED');
    await execute("UPDATE analysis_datasets SET scope='personal',allowed_user_ids='' WHERE id=?", [dataset.id]);
    await assert.rejects(service.getPresentation(viewer, presentation.id), error => error.status === 404);
    await assert.rejects(service.getPresentationVersion(viewer, presentation.id, 1), error => error.status === 404);
    await assert.rejects(service.getPresentationRemoteState(remote.token), error => error.status === 404);
    for (const operation of [() => manager.get(presentation.artifactId, viewer), () => manager.getVersions(presentation.artifactId, viewer),
        () => manager.getShared(oldShare.id), () => manager.update(presentation.artifactId, viewer, { content: '{}' })]) {
        await assert.rejects(operation(), error => [403, 404].includes(error.status));
    }
    assert.equal((await manager.list(viewer)).artifacts.some(item => Number(item.id) === Number(presentation.artifactId)), false);
});

test('真实分析图表到PPT可重复接续、导出原生图表和明细，跨账号与来源变更均阻止读取', { timeout: 120000 }, async () => {
    const user = await queryOne("SELECT id,username,unit,role,status FROM users WHERE username='admin'");
    const { getPresentation, savePresentationContent, createPresentationExport } = require('../server/services/presentations/presentation-service');
    const { getAgentArtifactForUser } = require('../server/services/agent-artifacts');
    const { issueDownloadToken, getRenditionForUser } = require('../server/services/agent-artifact-renditions');
    const dataset = await createDatasetFromRows({ user, name: `汇报闭环${crypto.randomUUID().slice(0, 8)}`, rows: [{ region: '华东', amount: 120 }, { region: '华南', amount: 180 }] });
    const { chart } = await buildChart(user, dataset.id, { xField: 'c_1', yField: 'c_2', aggregation: 'sum', chartType: 'bar' });
    assert.ok(chart.artifactId); assert.equal(chart.source.sourceVersion, 1);
    const body = { artifactId: chart.artifactId, requestKey: crypto.randomUUID() };
    const results = await Promise.all([createAnalysisReport(user, body), createAnalysisReport(user, body)]);
    assert.equal(results[0].presentation.id, results[1].presentation.id);
    assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
    const document = results[0].presentation;
    assert.equal(document.content.sources[0].analysisBinding.artifactId, chart.artifactId);
    assert.equal((await query('SELECT id FROM presentation_documents WHERE client_id=?', [document.id])).length, 1);
    assert.ok(document.content.slides.some(slide => slide.elements.some(element => element.type === 'chart')));
    const content = globalThis.structuredClone(document.content); content.sources = []; content.slides.forEach(slide => { slide.sourceRefs = []; slide.elements.forEach(element => { element.sourceRefs = []; }); });
    const saved = await savePresentationContent(user, document.id, { baseVersion: document.version, title: '已核对的区域汇报', content });
    assert.equal(saved.content.sources[0].analysisBinding.artifactId, chart.artifactId);
    assert.equal((await createAnalysisReport(user, body)).presentation.title, '已核对的区域汇报');
    const inspector = require('../server/services/presentations/presentation-export-verification');
    const originalInspect = inspector.verifyPptxExport;
    let exported;
    try {
        inspector.verifyPptxExport = async (...args) => { const report = await originalInspect(...args); assert.equal(report.status, 'passed', JSON.stringify(report.issues)); return report; };
        exported = await createPresentationExport(user, document.id, 'pptx');
    } finally { inspector.verifyPptxExport = originalInspect; }
    const rendition = await getRenditionForUser(exported.rendition.id, user);
    const loaded = await require('../server/services/agent-artifact-cas').readBuffer({ ref: rendition.storage_ref, tenantId: rendition.tenant_id, userId: user.id, tenantScoped: true });
    const zip = await JSZip.loadAsync(loaded.buffer);
    const charts = Object.keys(zip.files).filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    assert.equal(charts.length, 1);
    assert.match(await zip.file(charts[0]).async('string'), /180/);
    await issueDownloadToken(user, rendition.id);
    const runId = `analysis-ppt-${crypto.randomUUID()}`;
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status) VALUES (?,?,'分析汇报','将图表转为汇报PPT','running')", [runId, user.id]);
    const delivered = await require('../server/services/agent-tools').executeBuiltInTool('presentation.from_analysis', { artifactId: chart.artifactId }, user,
        { run: { id: runId, user_id: user.id }, stepId: 'analysis-ppt-export' });
    assert.equal(delivered.status, 'completed', JSON.stringify(delivered.validation));
    assert.equal(delivered.format, 'pptx');
    const feed = await require('../server/services/chat-task-feed').getChatTaskFeed(runId, user);
    assert.ok(feed.artifacts.some(item => item.rendition?.id === String(delivered.renditionId) && item.rendition.ready));
    await assert.rejects(createAnalysisReport({ ...user, id: 999999999 }, body), error => error.status === 404);
    await execute('UPDATE analysis_datasets SET source_version=source_version+1 WHERE id=?', [dataset.id]);
    await assert.rejects(getPresentation(user, document.id), error => error.code === 'PRESENTATION_ANALYSIS_STALE');
    await assert.rejects(getAgentArtifactForUser(document.artifactId, user), error => error.code === 'PRESENTATION_ANALYSIS_STALE');
    await assert.rejects(issueDownloadToken(user, rendition.id), error => error.code === 'PRESENTATION_ANALYSIS_STALE');
    const blockedFeed = await require('../server/services/chat-task-feed').getChatTaskFeed(runId, user);
    assert.equal(blockedFeed.knowledgeAccess.current, false);
    assert.equal(blockedFeed.artifacts.length, 0);
    assert.doesNotMatch(JSON.stringify(blockedFeed), /华东|华南|180/);
});
