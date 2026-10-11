'use strict';

function numberLabel(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/\.00$/, '');
}

function isOrderedLabel(value) {
    return /(?:\d{4}[-/.年]|季度|Q[1-4]|月|周|日)/i.test(String(value || ''));
}

function recommendChartType(chart = {}) {
    const labels = (chart.data?.rows || []).map(row => row?.[0]);
    const seriesCount = Math.max(0, (chart.data?.columns || []).length - 1);
    if (labels.length >= 3 && labels.every(isOrderedLabel)) return 'line';
    if (seriesCount === 1 && labels.length >= 2 && labels.length <= 6) return 'bar';
    return chart.chartType || 'bar';
}

function buildPresentationDataNarrative(chart = {}) {
    const columns = chart.data?.columns || [];
    const rows = chart.data?.rows || [];
    const seriesName = String(columns[1] || '数值');
    const values = rows.map(row => Number(row?.[1])).filter(Number.isFinite);
    const labels = rows.map(row => String(row?.[0] || ''));
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
    const annotation = rows.length > 1
        ? `${lastLabel}的${seriesName}为 ${numberLabel(last)}，较${firstLabel}${direction} ${numberLabel(delta)}${percent}。`
        : `${lastLabel}的${seriesName}为 ${numberLabel(last)}。`;
    return {
        recommendation: recommendChartType(chart),
        headline,
        annotation,
        backupRows: rows.slice(0, 20).map(row => row.map(value => String(value ?? '')))
    };
}

module.exports = { buildPresentationDataNarrative, recommendChartType };
