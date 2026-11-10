'use strict';

function numberLabel(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    if (Number.isInteger(number)) return String(number);
    const rounded = number.toFixed(2).replace(/\.00$/, '');
    return Number(rounded) === number ? rounded : `约${rounded}`;
}

function isOrderedLabel(value) {
    const label = String(value || '').trim();
    const quarter = /^(?:(\d{4})\s*年?\s*)?Q([1-4])$/i.exec(label);
    if (quarter) return { kind: quarter[1] ? 'year-quarter' : 'quarter', key: Number(quarter[1] || 0) * 4 + Number(quarter[2]) };
    const date = /^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?月?$/.exec(label);
    if (!date) return null;
    const year = Number(date[1]), month = Number(date[2]), day = Number(date[3] || 1), stamp = new Date(Date.UTC(year, month - 1, day));
    if (stamp.getUTCFullYear() !== year || stamp.getUTCMonth() !== month - 1 || stamp.getUTCDate() !== day) return null;
    return { kind: date[3] ? 'date' : 'month', key: stamp.getTime() };
}

function orderedLabels(labels) {
    const values = labels.map(isOrderedLabel);
    return values.length > 1 && values.every((value, index) => value && value.kind === values[0].kind && (!index || value.key > values[index - 1].key));
}

function recommendChartType(chart = {}) {
    const labels = (chart.data?.rows || []).map(row => row?.[0]);
    const seriesCount = Math.max(0, (chart.data?.columns || []).length - 1);
    if (labels.length >= 3 && orderedLabels(labels)) return 'line';
    if (seriesCount === 1 && labels.length >= 2 && labels.length <= 6) return 'bar';
    return chart.chartType || 'bar';
}

function buildPresentationDataNarrative(chart = {}) {
    const columns = chart.data?.columns || [];
    const rows = chart.data?.rows || [];
    const seriesName = String(columns[1] || '数值');
    const validRows = rows.filter(row => row?.[1] !== null && typeof row?.[1] !== 'boolean'
        && String(row?.[1] ?? '').trim() && Number.isFinite(Number(row[1])));
    const values = validRows.map(row => Number(row[1]));
    const labels = validRows.map(row => String(row[0] ?? ''));
    if (!values.length) return { recommendation: recommendChartType(chart), headline: '', annotation: '', backupRows: [] };
    const maximum = Math.max(...values);
    const maximumIndex = values.indexOf(maximum);
    const first = values[0];
    const last = values.at(-1);
    const firstLabel = labels[0] || '首个区间';
    const lastLabel = labels.at(-1) || '最新区间';
    const direction = last > first ? '增加' : last < first ? '减少' : '保持不变';
    const delta = Math.abs(last - first);
    const percent = first === 0 ? '' : `，变化 ${numberLabel(delta / Math.abs(first) * 100)}%`;
    const headline = `${labels[maximumIndex] || '当前'}的${seriesName}最高，为 ${numberLabel(maximum)}`;
    const ordered = labels.length === rows.length && orderedLabels(labels)
        && (!chart.design?.sortBy || chart.design.sortBy === 'label' && chart.design.sortOrder === 'asc');
    const annotation = ordered && rows.length > 1
        ? `${lastLabel}的${seriesName}为 ${numberLabel(last)}，较${firstLabel}${direction} ${numberLabel(delta)}${percent}。`
        : `本图展示 ${rows.length} 个分类${columns.length > 2 ? `、${columns.length - 1} 个序列；以上结论仅描述“${seriesName}”` : ''}，分类排列不表示时间变化。`;
    return {
        recommendation: recommendChartType(chart),
        headline,
        annotation,
        backupRows: rows.slice(0, 20).map(row => row.map(value => String(value ?? '')))
    };
}

module.exports = { buildPresentationDataNarrative, recommendChartType };
