
const {
    CHART_PALETTES,
    CHART_COLORS,
    getDatasetForUser,
    getColumn,
    normalizeAggregation,
    getDatasetPaths,
    sqlIdent,
    sqlLiteral,
    withAnalysisSlot,
    duckReadAll,
    recordArtifact,
    jsonParse,
    serializeDataset,
    isProfileNumberColumn,
    isIdentifierLikeColumn,
    isMetricNumericColumn
} = require('./shared');

function normalizeChartPalette(value) {
    const palette = String(value || '').toLowerCase();
    return CHART_PALETTES[palette] ? palette : 'teal';
}

function normalizeChartSort(input, chartType) {
    const defaultSortBy = chartType === 'line' || chartType === 'area' ? 'label' : 'value';
    const sortBy = ['label', 'value'].includes(String(input.sortBy || '').toLowerCase())
        ? String(input.sortBy).toLowerCase()
        : defaultSortBy;
    const defaultSortOrder = sortBy === 'label' ? 'asc' : 'desc';
    const sortOrder = ['asc', 'desc'].includes(String(input.sortOrder || '').toLowerCase())
        ? String(input.sortOrder).toLowerCase()
        : defaultSortOrder;
    return { sortBy, sortOrder };
}

function buildChartOption({ chartType, title, labels, series, xName, yName, colors = CHART_COLORS }) {
    if (chartType === 'pie') {
        return {
            title: { text: title, left: 18, top: 16, textStyle: { fontSize: 15, fontWeight: 700, color: '#334155' } },
            color: colors,
            tooltip: { trigger: 'item' },
            legend: { top: 50, left: 'center', type: 'scroll' },
            series: [{
                name: yName,
                type: 'pie',
                radius: ['35%', '68%'],
                center: ['50%', '58%'],
                data: labels.map((label, index) => ({ name: label, value: series[0]?.data?.[index] || 0 }))
            }]
        };
    }
    const normalizedType = chartType === 'area' ? 'line' : chartType;
    return {
        title: { text: title, left: 18, top: 16, textStyle: { fontSize: 15, fontWeight: 700, color: '#334155' } },
        color: colors,
        tooltip: { trigger: 'axis', confine: true },
        legend: { top: 50, right: 18, type: 'scroll' },
        grid: { left: 68, right: 32, top: 96, bottom: 64, containLabel: true },
        xAxis: {
            type: 'category',
            name: xName,
            nameLocation: 'middle',
            nameGap: 38,
            axisLabel: { hideOverlap: true, margin: 12 },
            data: labels
        },
        yAxis: {
            type: 'value',
            name: yName,
            nameLocation: 'middle',
            nameRotate: 90,
            nameGap: 56
        },
        series: series.map(item => ({
            name: item.name,
            type: normalizedType,
            data: item.data,
            smooth: normalizedType === 'line',
            areaStyle: chartType === 'area' ? {} : undefined
        }))
    };
}

async function buildChart(userId, datasetId, input = {}) {
    const row = getDatasetForUser(userId, datasetId);
    const xCol = getColumn(row, input.xField || input.xAxis);
    const yField = String(input.yField || input.yAxis || '').trim();
    const yCol = yField ? getColumn(row, yField) : null;
    const groupField = String(input.groupField || input.groupBy || '').trim();
    let groupCol = groupField ? getColumn(row, groupField) : null;
    const chartType = ['bar', 'line', 'area', 'pie'].includes(String(input.chartType || '').toLowerCase())
        ? String(input.chartType).toLowerCase()
        : 'bar';
    if (chartType === 'pie') groupCol = null;
    const aggregation = normalizeAggregation(input.aggregation, Boolean(yCol));
    if (aggregation !== 'count' && !yCol) {
        const err = new Error('生成求和、平均、最小值或最大值图表时，请先选择数值字段；如果只统计数量，请使用“计数”。');
        err.status = 400;
        throw err;
    }
    const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 80);
    const colorPalette = normalizeChartPalette(input.colorPalette || input.palette);
    const colors = CHART_PALETTES[colorPalette] || CHART_COLORS;
    const { sortBy, sortOrder } = normalizeChartSort(input, chartType);
    const { parquetPath } = getDatasetPaths(row);
    const valueExpr = aggregation === 'count'
        ? 'COUNT(*)'
        : `${aggregation.toUpperCase()}(TRY_CAST(${sqlIdent(yCol.key)} AS DOUBLE))`;
    const groupSelect = groupCol ? `, COALESCE(NULLIF(${sqlIdent(groupCol.key)}, ''), '(empty)') AS group_label` : '';
    const groupBy = groupCol ? 'GROUP BY label, group_label' : 'GROUP BY label';
    const orderBy = `ORDER BY ${sortBy === 'label' ? 'label' : 'value'} ${sortOrder.toUpperCase()}`;
    const sql = `
        SELECT COALESCE(NULLIF(${sqlIdent(xCol.key)}, ''), '(empty)') AS label${groupSelect}, ${valueExpr} AS value
        FROM read_parquet(${sqlLiteral(parquetPath)})
        ${groupBy}
        ${orderBy}
        LIMIT ${limit * (groupCol ? 20 : 1)}
    `;
    const rows = await withAnalysisSlot(() => duckReadAll(sql));
    const labels = Array.from(new Set(rows.map(item => String(item.label)))).slice(0, limit);
    const groups = groupCol ? Array.from(new Set(rows.map(item => String(item.group_label)))).slice(0, 12) : ['value'];
    const series = groups.map(group => ({
        name: groupCol ? group : (aggregation === 'count' ? '数量' : yCol?.name || '数值'),
        data: labels.map(label => {
            const item = rows.find(record => String(record.label) === label && (!groupCol || String(record.group_label) === group));
            return Number(item?.value) || 0;
        })
    }));
    const title = String(input.title || `${xCol.name}${groupCol ? `按${groupCol.name}` : ''}${aggregation === 'count' ? '数量' : yCol ? yCol.name : ''}分析`).slice(0, 120);
    const chart = {
        type: 'pivot_chart',
        version: 1,
        renderer: 'echarts',
        chartType,
        title,
        xAxis: { field: xCol.key, label: xCol.name },
        yAxis: { field: yCol?.key || '__count__', label: aggregation === 'count' ? '数量' : yCol?.name || '数值', aggregation },
        groupBy: groupCol ? { field: groupCol.key, label: groupCol.name } : null,
        labels,
        series,
        design: { limit, sortBy, sortOrder, colorPalette },
        source: { datasetId, rows: row.row_count }
    };
    chart.echartsOption = buildChartOption({
        chartType,
        title,
        labels,
        series,
        xName: xCol.name,
        yName: chart.yAxis.label,
        colors
    });
    recordArtifact({
        userId,
        datasetId,
        type: 'chart',
        title,
        content: JSON.stringify(chart),
        metadata: { chartType, xField: xCol.key, yField: yCol?.key || '', aggregation, limit, sortBy, sortOrder, colorPalette }
    });
    return { chart, rows };
}

async function runSummary(userId, datasetId) {
    const row = getDatasetForUser(userId, datasetId);
    const profile = jsonParse(row.profile_json, []);
    const numericColumns = profile.filter(isMetricNumericColumn);
    const completeness = profile.length
        ? profile.reduce((sum, column) => sum + Number(column.fillRate || 0), 0) / profile.length
        : 0;
    const highlights = [
        `共 ${row.row_count} 行、${row.column_count} 列`,
        `平均填充率 ${(completeness * 100).toFixed(1)}%`,
        numericColumns.length ? `${numericColumns.length} 个字段可按数值分析` : '暂未识别到稳定数值字段'
    ];
    const topColumns = profile
        .slice()
        .sort((a, b) => (Number(b.distinct) || 0) - (Number(a.distinct) || 0))
        .slice(0, 5)
        .map(column => ({
            name: column.name,
            type: column.type,
            distinct: column.distinct,
            fillRate: column.fillRate
        }));
    const suggestions = [];
    const dimension = profile.find(column => (['text', 'date', 'boolean'].includes(column.type) || isIdentifierLikeColumn(column)) && column.distinct > 1 && column.distinct <= 80);
    if (dimension && numericColumns[0]) {
        suggestions.push({
            title: `按${dimension.name}汇总${numericColumns[0].name}`,
            chartType: dimension.type === 'date' ? 'line' : 'bar',
            xField: dimension.key,
            yField: numericColumns[0].key,
            aggregation: 'sum'
        });
    }
    const category = profile.find(column => column.type === 'text' && column.distinct > 1 && column.distinct <= 20);
    if (category) {
        suggestions.push({
            title: `${category.name}数量分布`,
            chartType: 'pie',
            xField: category.key,
            yField: '',
            aggregation: 'count'
        });
    }
    return {
        dataset: serializeDataset(row),
        highlights,
        topColumns,
        numericColumns: numericColumns.slice(0, 8),
        suggestions
    };
}

async function buildAiContext(userId, datasetId) {
    const summary = await runSummary(userId, datasetId);
    const dataset = summary.dataset;
    const profile = Array.isArray(dataset.profile) ? dataset.profile : [];
    const typeLabel = { number: '数值', text: '文本', date: '日期', boolean: '布尔', empty: '空' };
    const fieldProfiles = profile.map(column => {
        const isMetric = isMetricNumericColumn(column);
        const isNumber = isProfileNumberColumn(column);
        const label = isMetric ? '数值指标' : (isNumber && isIdentifierLikeColumn(column) ? '编号/维度' : (typeLabel[column.type] || column.type || '未知'));
        const metric = isMetric ? `，均值 ${Number(column.numeric.avg || 0).toFixed(2)}，范围 ${column.numeric.min}~${column.numeric.max}` : '';
        return `${column.name}（${label}${metric}）`;
    });
    const numericFields = profile.filter(isMetricNumericColumn).map(column => column.name);
    return [
        `数据集：${dataset.name}` ,
        `规模：${dataset.rowCount} 行，${dataset.columnCount} 列`,
        `字段：${dataset.columns.map(column => column.name).join('、')}`,
        `字段类型：${fieldProfiles.join('；') || '暂无'}` ,
        `可直接数值计算字段：${numericFields.join('、') || '暂无'}` ,
        'SQL 提示：表名固定为 data；中文字段名请使用双引号；字段画像为“数值”的列在 data 表中已经按 DOUBLE 物化，可直接 SUM/AVG/加减计算；不确定类型时使用 TRY_CAST("字段名" AS DOUBLE)。',
        `画像：${summary.highlights.join('；')}` ,
        `建议图表：${summary.suggestions.map(item => item.title).join('；') || '暂无'}`
    ].join('\n');
}

module.exports = {
    buildAiContext,
    buildChart,
    buildChartOption,
    runSummary
};
