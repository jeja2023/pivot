'use strict';

const { presentationError } = require('./presentation-schema');
const { buildPresentationDataNarrative } = require('./presentation-data-narrative');
const { digest, readAnalysisChart } = require('./presentation-analysis-sources');

function toPresentationChart(chart) {
    if (!['bar', 'line', 'area', 'pie'].includes(chart.chartType)) throw presentationError('此类图表暂不能转为可编辑汇报，请先选择柱形图、折线图、面积图或饼图。', 400, 'PRESENTATION_ANALYSIS_CHART_UNSUPPORTED');
    const series = chart.series || [];
    if (!series.length || series.length > 11 || !chart.labels?.length || chart.labels.length > 80
        || series.some(item => !Array.isArray(item.data) || item.data.length !== chart.labels.length)) {
        throw presentationError('图表数据不完整或超过汇报范围，请调整分类与序列后重新生成。', 422, 'PRESENTATION_ANALYSIS_CHART_INVALID');
    }
    const rows = chart.labels.map((label, index) => [String(label ?? ''), ...series.map(item => {
        const value = item.data[index];
        if (typeof value !== 'number' || !Number.isFinite(value)) throw presentationError('图表含有缺失或无效数值，请先核对数据；不会用零替代。', 422, 'PRESENTATION_ANALYSIS_CHART_INVALID');
        return value;
    })]);
    if (chart.chartType === 'pie' && (series.length !== 1 || rows.length > 20)) throw presentationError('饼图汇报仅支持一个序列、最多二十个分类，请调整图表后重试。', 422, 'PRESENTATION_ANALYSIS_CHART_INVALID');
    return { chartType: chart.chartType, title: chart.title, data: { columns: [chart.xAxis?.label || '分类', ...series.map(item => String(item.name || '数值'))], rows }, design: chart.design };
}

function buildAnalysisReportPlan(snapshot, title) {
    const { chart, dataset, artifactId } = snapshot, converted = toPresentationChart(chart);
    const narrative = buildPresentationDataNarrative(converted);
    const aggregation = ({ sum: '求和', count: '计数', avg: '平均值', min: '最小值', max: '最大值' })[chart.yAxis?.aggregation] || '按图表口径';
    const query = `${chart.xAxis?.label || '分类'}；${chart.yAxis?.label || '数量'}；${aggregation}${chart.groupBy?.label ? `；按${chart.groupBy.label}分组` : ''}`;
    const sort = `${chart.design?.sortBy === 'label' ? '分类' : '数值'}${chart.design?.sortOrder === 'asc' ? '升序' : '降序'}`;
    const scope = `源数据 ${Number(chart.source?.rows || 0)} 行；本次展示 ${converted.data.rows.length} 个分类（上限 ${chart.design?.limit || converted.data.rows.length}），按${sort}排列。`;
    const caveat = chart.source?.scopeUnknown ? '原始数据范围未确认，不能将本次结果当作完整总体。'
        : chart.source?.truncated ? '导入数据存在截断，本次汇报仅覆盖已导入范围。' : '本次图表不代表未展示分类，未推断业务原因或未来趋势。';
    const source = { id: 'analysis_source', title: `${dataset.name} · 图表快照`, type: 'analysis_chart',
        locator: `分析图表 ${artifactId}；数据集版本 ${chart.source.sourceVersion}；生成于 ${chart.source.generatedAt}`,
        digest: snapshot.digest, excerpt: JSON.stringify({ query, scope, caveat, data: converted.data }).slice(0, 2400),
        excerptTruncated: JSON.stringify({ query, scope, caveat, data: converted.data }).length > 2400,
        analysisBinding: { artifactId, datasetId: dataset.id, sourceVersion: chart.source.sourceVersion } };
    const shortTitle = String(chart.title || '数据分析').slice(0, 52);
    const slides = [
        { layout: 'cover', title: String(title).slice(0, 90), points: [`${dataset.name} · 固定分析快照`, '数据分析与图表汇报'], speakerNotes: caveat },
        { layout: 'title-content', title: '分析结论与统计范围', points: [narrative.headline, narrative.annotation, `统计口径：${query}`, scope, caveat].filter(Boolean), speakerNotes: '结论为对实际图表数值的确定性描述，提交前请核对业务解释。' }
    ];
    for (let start = 0; start < converted.data.rows.length; start += 20) {
        const rows = converted.data.rows.slice(start, start + 20);
        slides.push({ layout: 'chart', title: `${shortTitle}${converted.data.rows.length > 20 ? `（第${start + 1}—${start + rows.length}类）` : ''}`,
            chart: { type: converted.chartType, columns: converted.data.columns, rows }, points: [query], speakerNotes: `${scope}\n${caveat}` });
    }
    for (let start = 0; start < converted.data.rows.length; start += 8) {
        const rows = converted.data.rows.slice(start, start + 8).map(row => row.map(String));
        slides.push({ layout: 'table', title: `图表数据明细（${start + 1}—${start + rows.length}）`,
            table: { columns: converted.data.columns, rows }, points: ['与图表使用同一份固定快照，按当前图表顺序逐项列出。'], speakerNotes: query });
    }
    return { title, slides, source, scope, caveat };
}

async function createAnalysisReport(user, body = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const artifactId = String(body.artifactId || ''), requestKey = String(body.requestKey || '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) throw presentationError('缺少有效请求标识，请刷新后重试。');
    const snapshot = await readAnalysisChart(user, artifactId);
    const title = String(body.title || `${String(snapshot.chart.title || '数据分析').slice(0, 80)}汇报`).trim();
    if (!title || title.length > 90) throw presentationError('汇报标题须为一至九十个字符。');
    const id = `analysis_${digest(JSON.stringify([user.id, artifactId, requestKey, title])).slice(0, 40)}`;
    const store = require('./presentation-service');
    return require('../../repositories/presentation-analysis-reports').serializeCreation(id, async () => {
        signal?.throwIfAborted();
        const existing = await store.getPresentation(user, id);
        if (existing) return { presentation: existing, reused: true };
        const plan = buildAnalysisReportPlan(snapshot, title);
        const template = await store.resolveTemplateForUser(user, 'executive-clean');
        const compiled = await require('./presentation-design-compiler').compileDesignPlan(plan, template, [plan.source], { signal });
        const content = { ...compiled.presentation, sources: [plan.source], metadata: { ...compiled.presentation.metadata, aiGenerated: false } };
        await require('./presentation-analysis-sources').assertAnalysisSources(content, user);
        signal?.throwIfAborted();
        const presentation = await store.createPresentation(user, { id, title, templateId: template.id, templateVersion: template.version,
            content, tags: ['数据汇报'] });
        return { presentation, reused: false };
    }, { signal });
}

module.exports = { buildAnalysisReportPlan, createAnalysisReport, toPresentationChart };
