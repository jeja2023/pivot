/* 图表渲染辅助函数（拆自 render.js） */




function normalizePivotChartSpec(raw) {
    let spec = null;
    try {
        spec = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
        return null;
    }
    if (!spec || typeof spec !== 'object') return null;
    if (spec.type !== 'pivot_chart' && spec.data && typeof spec.data === 'object') {
        spec = coerceSimpleChartSpec(spec);
    } else if (spec.type !== 'pivot_chart') {
        spec = coerceLooseChartSpec(spec);
    }
    if (!spec || spec.type !== 'pivot_chart' || !Array.isArray(spec.labels) || !Array.isArray(spec.series)) return null;
    return {
        chartType: ['bar', 'line', 'area', 'pie'].includes(spec.chartType) ? spec.chartType : 'bar',
        title: String(spec.title || '图表'),
        labels: spec.labels.map(label => String(label ?? '')).slice(0, 80),
        series: spec.series.slice(0, 20).map(item => ({
            name: String(item?.name || '系列'),
            data: Array.isArray(item?.data) ? item.data.map(value => Number(value) || 0).slice(0, 80) : []
        })),
        xAxis: spec.xAxis || null,
        yAxis: spec.yAxis || null,
        echartsOption: spec.echartsOption || spec.option || null,
        source: spec.source || {}
    };
}

function normalizeLooseChartType(input, seriesList = []) {
    const primaryType = String(input?.chartType || input?.type || seriesList[0]?.type || '').trim().toLowerCase();
    if (primaryType === 'line' && seriesList[0]?.areaStyle) return 'area';
    return ['bar', 'line', 'area', 'pie'].includes(primaryType) ? primaryType : '';
}

function coerceLooseAxisSpec(axis, fallbackType = '') {
    const primaryAxis = Array.isArray(axis) ? axis[0] : axis;
    if (!primaryAxis || typeof primaryAxis !== 'object') {
        return fallbackType ? { type: fallbackType } : null;
    }
    const label = String(primaryAxis.label || primaryAxis.name || primaryAxis.title || '').trim();
    const field = String(primaryAxis.field || primaryAxis.key || primaryAxis.dimension || '').trim();
    const type = String(primaryAxis.type || fallbackType || '').trim();
    return {
        ...primaryAxis,
        ...(label ? { label } : {}),
        ...(field ? { field } : {}),
        ...(type ? { type } : {})
    };
}

function extractLooseAxisLabels(axis) {
    if (!axis || !Array.isArray(axis.data)) return [];
    return axis.data.map(label => String(label ?? '')).slice(0, 80);
}

function normalizeLooseSeriesData(data = []) {
    if (!Array.isArray(data)) return [];
    return data.map((point) => {
        if (point && typeof point === 'object' && !Array.isArray(point)) {
            return Number(point.value) || 0;
        }
        return Number(point) || 0;
    }).slice(0, 80);
}

function extractLooseSeriesLabels(seriesList = []) {
    for (const item of seriesList) {
        if (!Array.isArray(item?.data)) continue;
        const labels = item.data.map((point) => {
            if (point && typeof point === 'object' && !Array.isArray(point) && point.name != null) {
                return String(point.name);
            }
            return '';
        }).slice(0, 80);
        if (labels.some(Boolean)) return labels;
    }
    return [];
}

function extractLooseChartTitle(title, fallback = '') {
    if (title && typeof title === 'object' && !Array.isArray(title)) {
        return String(title.text || title.subtext || fallback || '图表');
    }
    return String(title || fallback || '图表');
}

function coerceLooseChartSpec(input) {
    const seriesList = Array.isArray(input?.series) ? input.series.filter(Boolean).slice(0, 20) : [];
    const chartType = normalizeLooseChartType(input, seriesList);
    if (!chartType) return null;

    const xAxis = coerceLooseAxisSpec(input.xAxis, chartType === 'pie' ? '' : 'category');
    const yAxis = coerceLooseAxisSpec(input.yAxis, chartType === 'pie' ? '' : 'value');

    if (chartType === 'pie') {
        const pieSeries = seriesList[0] || {};
        const points = Array.isArray(pieSeries.data) ? pieSeries.data : [];
        return {
            type: 'pivot_chart',
            chartType,
            title: extractLooseChartTitle(input.title, pieSeries.name),
            labels: points.map((point, index) => (
                point && typeof point === 'object' && !Array.isArray(point)
                    ? String(point.name ?? index + 1)
                    : String(index + 1)
            )).slice(0, 80),
            series: [{
                name: String(pieSeries.name || '系列'),
                data: normalizeLooseSeriesData(points)
            }],
            xAxis,
            yAxis,
            source: {
                format: 'loose_chart',
                dataQuery: input?.dataQuery || null
            }
        };
    }

    const normalizedSeries = (seriesList.length ? seriesList : [{}]).map(item => ({
        name: String(item?.name || '系列'),
        data: normalizeLooseSeriesData(item?.data)
    }));
    let labels = extractLooseAxisLabels(xAxis);
    if (!labels.length) labels = extractLooseSeriesLabels(seriesList);
    if (!labels.length) {
        const pointCount = normalizedSeries.reduce((max, item) => Math.max(max, item.data.length), 0);
        labels = Array.from({ length: pointCount }, (_, index) => String(index + 1));
    }

    return {
        type: 'pivot_chart',
        chartType,
        title: extractLooseChartTitle(input.title),
        labels,
        series: normalizedSeries,
        xAxis,
        yAxis,
        source: {
            format: 'loose_chart',
            dataQuery: input?.dataQuery || null
        }
    };
}

function coerceSimpleChartSpec(input) {
    const data = input?.data || {};
    const config = input?.config || {};
    const xValues = Array.isArray(data.x) ? data.x : (Array.isArray(input.labels) ? input.labels : []);
    const yValues = Array.isArray(data.y) ? data.y : (Array.isArray(input.values) ? input.values : []);
    if (!xValues.length || !yValues.length) return null;
    const firstSeries = Array.isArray(yValues[0]) ? yValues[0] : yValues;
    const chartType = String(config.chartType || input.chartType || 'bar').toLowerCase();
    return {
        type: 'pivot_chart',
        chartType: ['bar', 'line', 'area', 'pie'].includes(chartType) ? chartType : 'bar',
        title: config.title || input.title || '图表',
        labels: xValues,
        series: [{
            name: config.yAxisLabel || input.yAxisLabel || '数值',
            data: firstSeries
        }],
        xAxis: { label: config.xAxisLabel || input.xAxisLabel || '分类' },
        yAxis: { label: config.yAxisLabel || input.yAxisLabel || '数值' },
        source: { format: 'simple_chart' }
    };
}

function buildEchartsOptionFromPivotSpec(spec) {
    if (spec.echartsOption && typeof spec.echartsOption === 'object') return polishEchartsLayoutOption(spec.echartsOption);
    const chartType = spec.chartType === 'area' ? 'line' : spec.chartType;
    const baseTitle = { text: spec.title, left: 18, top: 16, textStyle: { fontSize: 15, fontWeight: 700, color: '#334155' } };
    if (chartType === 'pie') {
        const values = spec.series[0]?.data || [];
        return {
            title: baseTitle,
            tooltip: { trigger: 'item' },
            legend: { top: 50, left: 'center', type: 'scroll' },
            series: [{
                name: spec.series[0]?.name || '系列',
                type: 'pie',
                radius: ['35%', '68%'],
                center: ['50%', '58%'],
                data: spec.labels.map((label, index) => ({ name: label, value: values[index] || 0 }))
            }]
        };
    }
    return {
        title: baseTitle,
        color: ['#10a37f', '#2563eb', '#f59e0b', '#ef4444', '#7c3aed', '#0891b2'],
        tooltip: { trigger: 'axis', confine: true },
        legend: { top: 50, right: 18, type: 'scroll' },
        grid: { left: 68, right: 32, top: 96, bottom: 64, containLabel: true },
        xAxis: {
            type: 'category',
            name: spec.xAxis?.label || spec.xAxis?.field || '分类',
            nameLocation: 'middle',
            nameGap: 38,
            nameTextStyle: { color: '#64748b', fontWeight: 600 },
            axisLabel: { hideOverlap: true, margin: 12 },
            data: spec.labels
        },
        yAxis: {
            type: 'value',
            name: spec.yAxis?.label || (spec.yAxis?.field === '__count__' ? '数量' : spec.yAxis?.field || '数值'),
            nameLocation: 'middle',
            nameRotate: 90,
            nameGap: 56,
            nameTextStyle: { color: '#64748b', fontWeight: 600 },
            axisLabel: { margin: 10 },
            splitLine: { lineStyle: { color: '#e2e8f0' } }
        },
        series: spec.series.map(item => ({
            name: item.name,
            type: chartType,
            data: item.data,
            smooth: chartType === 'line',
            areaStyle: spec.chartType === 'area' ? {} : undefined,
            emphasis: { focus: 'series' }
        }))
    };
}

function polishEchartsLayoutOption(option) {
    const polishTitle = (title = {}) => ({
        ...title,
        left: title.left ?? 18,
        top: 16,
        textStyle: { fontSize: 15, fontWeight: 700, color: '#334155', ...(title.textStyle || {}) }
    });
    const polishLegend = (legend = {}) => ({
        ...legend,
        top: 50,
        right: legend.right ?? 18,
        type: legend.type || 'scroll'
    });
    const polishGrid = (grid = {}) => ({
        ...grid,
        left: grid.left ?? 68,
        right: grid.right ?? 32,
        top: 96,
        bottom: grid.bottom ?? 64,
        containLabel: true
    });
    const polishAxis = (axis, type) => ({
        ...axis,
        ...(type === 'x' ? {
            nameLocation: 'middle',
            nameGap: Number(axis?.nameGap || 0) < 36 ? 38 : axis.nameGap,
            nameTextStyle: { color: '#64748b', fontWeight: 600, ...(axis?.nameTextStyle || {}) },
            axisLabel: { hideOverlap: true, margin: 12, ...(axis?.axisLabel || {}) }
        } : {
            nameLocation: 'middle',
            nameRotate: 90,
            nameGap: Number(axis?.nameGap || 0) < 52 ? 56 : axis.nameGap,
            nameTextStyle: { color: '#64748b', fontWeight: 600, ...(axis?.nameTextStyle || {}) },
            axisLabel: { margin: 10, ...(axis?.axisLabel || {}) },
            splitLine: { lineStyle: { color: '#e2e8f0' }, ...(axis?.splitLine || {}) }
        })
    });
    const polishAxes = (axes, type) => Array.isArray(axes)
        ? axes.map(axis => polishAxis(axis || {}, type))
        : polishAxis(axes || {}, type);
    return {
        ...option,
        title: Array.isArray(option.title)
            ? option.title.map(item => polishTitle(item || {}))
            : polishTitle(option.title || {}),
        legend: option.legend
            ? (Array.isArray(option.legend) ? option.legend.map(item => polishLegend(item || {})) : polishLegend(option.legend))
            : option.legend,
        grid: option.grid
            ? (Array.isArray(option.grid) ? option.grid.map(item => polishGrid(item || {})) : polishGrid(option.grid))
            : option.grid,
        xAxis: option.xAxis ? polishAxes(option.xAxis, 'x') : option.xAxis,
        yAxis: option.yAxis ? polishAxes(option.yAxis, 'y') : option.yAxis
    };
}

function disposePivotEchart(block) {
    if (!block) return;
    if (typeof block._pivotEchartResize === 'function') {
        window.removeEventListener('resize', block._pivotEchartResize);
        block._pivotEchartResize = null;
    }
    if (block._pivotEchart) {
        try { block._pivotEchart.dispose(); } catch (_error) { /* noop */ }
        block._pivotEchart = null;
    }
    // Safety net: dispose any echarts instance still bound to the mount node.
    if (window.echarts) {
        const mount = block.querySelector?.('.pivot-echart-canvas');
        if (mount) {
            const existing = window.echarts.getInstanceByDom?.(mount);
            if (existing) {
                try { existing.dispose(); } catch (_error) { /* noop */ }
            }
        }
    }
}

function teardownPivotCharts(root = document) {
    root.querySelectorAll?.('.pivot-echart-block').forEach(disposePivotEchart);
}

function renderEcharts(block, spec) {
    const mount = block.querySelector('.pivot-echart-canvas');
    if (!mount || !window.echarts) return false;
    // Dispose any prior instance/listener bound to this block before re-initializing.
    disposePivotEchart(block);
    mount.hidden = false;
    mount.style.height = '340px';
    mount.innerHTML = '';
    try {
        const chart = window.echarts.init(mount, null, { renderer: 'canvas' });
        chart.setOption(buildEchartsOptionFromPivotSpec(spec), true);
        const onResize = () => chart.resize();
        window.addEventListener('resize', onResize, { passive: true });
        block._pivotEchart = chart;
        block._pivotEchartResize = onResize;
        return true;
    } catch (_error) {
        mount.hidden = true;
        mount.innerHTML = '';
        return false;
    }
}

let echartsLoadPromise = null;

function ensureEchartsLazyLoaded() {
    if (window.echarts) return Promise.resolve(true);
    if (!window.Pivot?.loadScriptOnce) return Promise.resolve(false);
    if (!echartsLoadPromise) {
        echartsLoadPromise = window.Pivot.loadScriptOnce('/common/vendor/echarts.min.js')
            .then(() => Boolean(window.echarts))
            .catch(() => false);
    }
    return echartsLoadPromise;
}

function drawPivotChart(canvas, spec) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx || !spec) return;
    const rect = canvas.getBoundingClientRect();
    const parentWidth = canvas.parentElement?.clientWidth || 0;
    const width = Math.max(rect.width || parentWidth || 620, 320);
    const height = Number(canvas.getAttribute('height')) || 300;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const palette = ['#10a37f', '#2563eb', '#f59e0b', '#ef4444', '#7c3aed', '#0891b2'];
    const padLeft = 72;
    const padRight = 22;
    const padTop = 28;
    const padBottom = 64;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;
    const allValues = spec.series.flatMap(item => item.data);
    const maxValue = Math.max(...allValues, 0);
    const minValue = Math.min(...allValues, 0);
    const rangeMax = maxValue === minValue ? maxValue + 1 : maxValue;
    const rangeMin = maxValue === minValue ? Math.min(0, minValue - 1) : minValue;
    const valueRange = rangeMax - rangeMin || 1;
    const valueToY = (value) => padTop + chartH - ((value - rangeMin) / valueRange) * chartH;
    const zeroY = valueToY(0);
    const xAxisLabel = String(spec.xAxis?.label || spec.xAxis?.field || '??').trim();
    const yAxisLabel = String(spec.yAxis?.label || (spec.yAxis?.field === '__count__' ? '??' : spec.yAxis?.field || '??')).trim();
    const legendItems = spec.series.slice(0, 4).map((item, index) => ({
        label: String(item.name || '??').trim() || '??',
        color: palette[index % palette.length]
    }));

    if (spec.chartType === 'pie') {
        const values = spec.series[0]?.data || [];
        const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0) || 1;
        const radius = Math.min(chartW, chartH) * 0.36;
        const cx = padLeft + chartW * 0.38;
        const cy = padTop + chartH * 0.5;
        let start = -Math.PI / 2;
        values.forEach((value, index) => {
            const angle = (Math.max(value, 0) / total) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, radius, start, start + angle);
            ctx.closePath();
            ctx.fillStyle = palette[index % palette.length];
            ctx.fill();
            start += angle;
        });
        ctx.font = '12px sans-serif';
        spec.labels.slice(0, 8).forEach((label, index) => {
            const x = padLeft + chartW * 0.72;
            const y = padTop + 18 + index * 22;
            ctx.fillStyle = palette[index % palette.length];
            ctx.fillRect(x, y - 10, 10, 10);
            ctx.fillStyle = '#475569';
            ctx.fillText(`${label}: ${values[index] ?? 0}`, x + 16, y);
        });
        return;
    }

    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
        const y = padTop + chartH * (i / 4);
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();
    }
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i += 1) {
        const value = rangeMax - valueRange * (i / 4);
        ctx.fillText(Number(value.toFixed(1)).toLocaleString(), padLeft - 8, padTop + chartH * (i / 4) + 4);
    }
    if (rangeMin < 0 && rangeMax > 0) {
        ctx.strokeStyle = '#94a3b8';
        ctx.beginPath();
        ctx.moveTo(padLeft, zeroY);
        ctx.lineTo(width - padRight, zeroY);
        ctx.stroke();
    }

    if (yAxisLabel) {
        ctx.save();
        ctx.translate(18, padTop + chartH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = '#64748b';
        ctx.font = '600 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(yAxisLabel, 0, 0);
        ctx.restore();
    }

    if (legendItems.length) {
        ctx.save();
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const legendLabels = legendItems.map(item => ({
            color: item.color,
            label: item.label.toLowerCase() === 'count' ? '??' : item.label
        }));
        const itemWidths = legendLabels.map(item => ctx.measureText(item.label).width + 20);
        let legendX = width - padRight - itemWidths.reduce((sum, value) => sum + value, 0) - Math.max(0, legendItems.length - 1) * 10;
        const legendY = 14;
        legendLabels.forEach((item, index) => {
            const itemWidth = itemWidths[index];
            ctx.fillStyle = item.color;
            ctx.fillRect(legendX, legendY - 4, 8, 8);
            ctx.fillStyle = '#475569';
            ctx.fillText(item.label, legendX + 12, legendY);
            legendX += itemWidth + 10;
        });
        ctx.restore();
    }

    const labels = spec.labels.length ? spec.labels : [''];
    if (spec.chartType === 'line' || spec.chartType === 'area') {
        spec.series.forEach((item, seriesIndex) => {
            const points = labels.map((_, index) => ({
                x: padLeft + (labels.length === 1 ? chartW / 2 : chartW * index / (labels.length - 1)),
                y: valueToY(item.data[index] || 0)
            }));
            if (spec.chartType === 'area' && points.length) {
                ctx.beginPath();
                points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, zeroY) : null);
                points.forEach((point, index) => index === 0 ? ctx.lineTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
                ctx.lineTo(points[points.length - 1].x, zeroY);
                ctx.closePath();
                ctx.fillStyle = palette[seriesIndex % palette.length] + '2b';
                ctx.fill();
            }
            ctx.beginPath();
            points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
            ctx.strokeStyle = palette[seriesIndex % palette.length];
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = palette[seriesIndex % palette.length];
            points.forEach(point => {
                ctx.beginPath();
                ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
                ctx.fill();
            });
        });
    } else {
        const groupCount = Math.max(spec.series.length, 1);
        const slotW = chartW / labels.length;
        const barW = Math.max(Math.min(slotW / groupCount * 0.68, 34), 4);
        labels.forEach((_, labelIndex) => {
            spec.series.forEach((item, seriesIndex) => {
                const value = item.data[labelIndex] || 0;
                const y = valueToY(value);
                const x = padLeft + labelIndex * slotW + slotW / 2 - (groupCount * barW) / 2 + seriesIndex * barW;
                ctx.fillStyle = palette[seriesIndex % palette.length];
                ctx.fillRect(x, Math.min(y, zeroY), Math.max(barW - 2, 2), Math.abs(zeroY - y));
            });
        });
    }

    const labelStep = Math.max(1, Math.ceil(labels.length / Math.max(4, Math.floor(width / 90))));
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    labels.forEach((label, index) => {
        if (index % labelStep !== 0 && index !== labels.length - 1) return;
        const x = padLeft + (labels.length === 1 ? chartW / 2 : chartW * index / Math.max(labels.length - 1, 1));
        ctx.fillText(String(label).slice(0, 12), x, height - padBottom + 24);
    });

    if (xAxisLabel) {
        ctx.fillStyle = '#64748b';
        ctx.font = '600 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(xAxisLabel, padLeft + chartW / 2, height - 14);
    }
}

function renderPivotCharts(root = document) {
    root.querySelectorAll?.('.pivot-echart-block[data-pivot-echart]').forEach(block => {
        if (block.dataset.rendered === '1') return;
        const spec = normalizePivotChartSpec(block.dataset.pivotEchart || '');
        const canvas = block.querySelector('canvas');
        const title = block.querySelector('.pivot-echart-title');
        const echartMount = block.querySelector('.pivot-echart-canvas');
        if (!spec || !canvas) {
            block.classList.add('is-error');
            if (title) {
                title.hidden = false;
                title.textContent = '图表渲染失败';
            }
            if (echartMount) echartMount.hidden = true;
            if (canvas) canvas.hidden = true;
            const errorText = block.querySelector('.pivot-echart-error-text');
            if (errorText) {
                errorText.textContent = compactChartErrorText(block.dataset.pivotEchart || '');
            }
            return;
        }
        block.classList.remove('is-error');
        const rendered = renderEcharts(block, spec);
        canvas.hidden = rendered;
        if (title) {
            title.hidden = rendered;
            title.textContent = '图表预览';
        }
        if (!rendered) {
            if (echartMount) echartMount.hidden = true;
            drawPivotChart(canvas, spec);
            ensureEchartsLazyLoaded().then((ready) => {
                if (!ready || block.dataset.renderedEcharts === '1') return;
                const upgraded = renderEcharts(block, spec);
                if (!upgraded) return;
                canvas.hidden = true;
                if (title) title.hidden = true;
                block.dataset.renderedEcharts = '1';
            });
        }
        block.dataset.rendered = '1';
    });
}

window.renderPivotCharts = renderPivotCharts;
window.teardownPivotCharts = teardownPivotCharts;

function compactChartErrorText(raw) {
    const text = String(raw || '').trim();
    if (!text) return '图表配置为空';
    return text.length > 360 ? `${text.slice(0, 360)}\n...` : text;
}
