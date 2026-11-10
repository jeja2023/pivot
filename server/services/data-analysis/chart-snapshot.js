'use strict';

const { getDatasetForUser, recordArtifact } = require('./shared');
const { assertDatasetFieldsAccessible } = require('./governance');

function chartFields(chart) {
    return [...new Set([chart.xAxis?.field, chart.yAxis?.field, chart.secondaryYAxis?.field, chart.groupBy?.field]
        .filter(field => field && field !== '__count__'))];
}

async function recordChartSnapshot({ actor, row, chart, metadata }) {
    const current = await getDatasetForUser(actor, row.id);
    if (Number(current.source_version || 1) !== Number(row.source_version || 1) || current.parquet_path !== row.parquet_path) {
        throw Object.assign(new Error('生成图表期间数据或字段规则已变化，请重新生成。'), { status: 409, code: 'ANALYSIS_SOURCE_CHANGED' });
    }
    await assertDatasetFieldsAccessible(actor, current, chartFields(chart));
    chart.source = { ...chart.source, datasetId: row.id, datasetName: current.name,
        sourceVersion: Number(current.source_version || 1), generatedAt: new Date().toISOString(),
        sourceRowCount: Number(current.source_row_count ?? current.row_count ?? 0),
        truncated: current.truncated === true || Number(current.truncated) === 1,
        scopeUnknown: Number(current.truncated) === 2,
        displayedCategories: chart.labels?.length || 0, categoryLimit: chart.design?.limit || 0 };
    chart.artifactId = await recordArtifact({ userId: actor.id, datasetId: row.id, type: 'chart', title: chart.title,
        content: JSON.stringify(chart), metadata: { ...metadata, sourceVersion: chart.source.sourceVersion } });
}

module.exports = { chartFields, recordChartSnapshot };
