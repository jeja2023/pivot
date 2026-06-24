
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('PivotDataAnalysis context is not loaded');
    const { API, state, html, esc, activeDataset } = app;
    const fetchJson = (...args) => app.fetchJson(...args);
    const guardButton = (...args) => app.guardButton(...args);
    const toast = (...args) => app.toast(...args);

    function chartNumericFields(dataset = activeDataset()) {
        return (dataset?.profile || []).filter(item => item.type === 'number').map(item => item.key);
    }

    function selectHasOption(select, value) {
        return Array.from(select?.options || []).some(option => option.value === value);
    }

    function syncChartAggregationControls(source = 'auto', notify = false) {
        const yEl = document.getElementById('data-analysis-chart-y');
        const aggregationEl = document.getElementById('data-analysis-chart-aggregation');
        if (!yEl || !aggregationEl) return;
        const aggregation = aggregationEl.value || 'sum';
        if (yEl.value || aggregation === 'count') return;

        if (source === 'aggregation') {
            const fallback = chartNumericFields().find(key => selectHasOption(yEl, key));
            if (fallback) {
                yEl.value = fallback;
                return;
            }
        }

        aggregationEl.value = 'count';
        if (notify) toast('未选择数值字段，已自动切换为计数。', 'warning');
    }

    function syncChartTypeControls(source = 'auto') {
        const typeEl = document.getElementById('data-analysis-chart-type');
        const groupEl = document.getElementById('data-analysis-chart-group');
        const sortEl = document.getElementById('data-analysis-chart-sort');
        const groupControl = document.querySelector('[data-data-analysis-chart-control="group"]');
        const chartType = typeEl?.value || 'bar';
        const isPie = chartType === 'pie';
        groupControl?.classList.toggle('hidden', isPie);
        if (isPie && groupEl) groupEl.value = '';
        if (!sortEl || !['auto', 'type'].includes(source)) return;

        const isTrendChart = chartType === 'line' || chartType === 'area';
        if (isTrendChart && ['value_desc', 'value_asc'].includes(sortEl.value)) {
            sortEl.value = 'label_asc';
        } else if (!isTrendChart && ['label_asc', 'label_desc'].includes(sortEl.value)) {
            sortEl.value = 'value_desc';
        }
    }

    async function buildChart() {
        const dataset = activeDataset();
        if (!dataset) {
            toast('请选择分析数据集', 'warning');
            return;
        }
        const xField = document.getElementById('data-analysis-chart-x')?.value;
        if (!xField) {
            toast('请选择分类字段', 'warning');
            return;
        }
        await guardButton('data-analysis-build-chart', '生成中…', async () => {
            syncChartAggregationControls('build', true);
            syncChartTypeControls('build');
            const sortValue = document.getElementById('data-analysis-chart-sort')?.value || 'value_desc';
            const [sortBy, sortOrder] = sortValue.split('_');
            const payload = {
                xField: document.getElementById('data-analysis-chart-x')?.value || '',
                yField: document.getElementById('data-analysis-chart-y')?.value || '',
                groupField: document.getElementById('data-analysis-chart-group')?.value || '',
                aggregation: document.getElementById('data-analysis-chart-aggregation')?.value || 'sum',
                chartType: document.getElementById('data-analysis-chart-type')?.value || 'bar',
                limit: document.getElementById('data-analysis-chart-limit')?.value || '30',
                sortBy: sortBy || 'value',
                sortOrder: sortOrder || 'desc',
                colorPalette: document.getElementById('data-analysis-chart-palette')?.value || 'teal'
            };
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/chart`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            state.chart = data.chart;
            renderChart();
        });
    }

    function renderChart() {
        const box = document.getElementById('data-analysis-chart-result');
        if (!box) return;
        if (!state.chart) {
            const suggestions = state.summary?.suggestions || [];
            box.innerHTML = suggestions.length ? `
                <div class="data-analysis-suggestions">
                    ${suggestions.map((item, index) => `
                        <button type="button" data-data-analysis-chart-suggestion="${index}">
                            <strong>${esc(item.title)}</strong>
                            <span>${esc(item.chartType)} / ${esc(item.aggregation)}</span>
                        </button>
                    `).join('')}
                </div>
            ` : '<div class="data-analysis-empty">选择字段后生成图表</div>';
            return;
        }
        box.innerHTML = `
            <div class="data-analysis-chart-actions">
                <button id="data-analysis-chart-png" class="btn-secondary" type="button">保存为图片</button>
                <button id="data-analysis-chart-data-csv" class="btn-secondary" type="button">导出图表数据 (CSV)</button>
            </div>
            <div class="pivot-echart-block" data-pivot-echart="${html.escapeAttr(JSON.stringify(state.chart))}">
                <div class="pivot-echart-title">图表预览</div>
                <div class="pivot-echart-canvas"></div>
                <canvas height="300"></canvas>
                <pre class="pivot-echart-error-text"></pre>
            </div>
        `;
        window.renderPivotCharts?.(box);
    }

    // 把当前图表块导出为 PNG：优先用 ECharts 实例的 getDataURL，回退到 2D canvas 的 toDataURL。
    function downloadChartPng() {
        const box = document.getElementById('data-analysis-chart-result');
        const block = box?.querySelector('.pivot-echart-block');
        if (!block) return;
        let dataUrl = '';
        try {
            if (block._pivotEchart && typeof block._pivotEchart.getDataURL === 'function') {
                dataUrl = block._pivotEchart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
            } else {
                const canvas = block.querySelector('canvas');
                if (canvas && !canvas.hidden) dataUrl = canvas.toDataURL('image/png');
            }
        } catch (_e) { dataUrl = ''; }
        if (!dataUrl) {
            toast('图表尚未渲染完成，请稍后再试', 'warning');
            return;
        }
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${(state.chart?.title || 'chart').replace(/[<>:"/\\|?*]/g, '_').slice(0, 60)}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // 将 HTML 表格数据前端导出为 CSV (包含 UTF-8 BOM 防乱码)
    function exportTableToCsv(tableElement, filename) {
        if (!tableElement) return;
        const rows = Array.from(tableElement.querySelectorAll('tr'));
        const csvContent = rows.map(row => {
            const cells = Array.from(row.querySelectorAll('th, td'));
            return cells.map(cell => {
                let text = cell.textContent || '';
                text = text.replace(/"/g, '""');
                return `"${text}"`;
            }).join(',');
        }).join('\n');

        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename || 'export.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // 智能解析 ECharts 选项数据并导出为 CSV
    function exportChartDataToCsv() {
        const chart = state.chart;
        if (!chart) return;

        let csvContent = '\uFEFF';

        // 优先尝试读取 dataset.source
        if (chart.dataset && Array.isArray(chart.dataset.source)) {
            const source = chart.dataset.source;
            csvContent += source.map(row => {
                return row.map(cell => {
                    let text = String(cell ?? '');
                    text = text.replace(/"/g, '""');
                    return `"${text}"`;
                }).join(',');
            }).join('\n');
        }
        // 读取传统的 xAxis.data 和 series
        else if (chart.xAxis && chart.xAxis.data && Array.isArray(chart.series)) {
            const xData = chart.xAxis.data;
            const seriesList = chart.series;
            
            const headers = ['分类字段', ...seriesList.map(s => s.name || '数值')];
            csvContent += headers.map(h => `"${h.replace(/"/g, '""')}"`).join(',') + '\n';
            
            xData.forEach((xVal, rowIndex) => {
                const row = [String(xVal)];
                seriesList.forEach(s => {
                    const val = s.data?.[rowIndex] ?? '';
                    row.push(String(val));
                });
                csvContent += row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',') + '\n';
            });
        }
        // 读取饼图类型的单 series.data 键值对
        else if (Array.isArray(chart.series) && chart.series[0] && Array.isArray(chart.series[0].data)) {
            const data = chart.series[0].data;
            csvContent += '"名称","数值"\n';
            data.forEach(item => {
                const name = String(item.name || '');
                const val = String(item.value ?? '');
                csvContent += `"${name.replace(/"/g, '""')}","${val.replace(/"/g, '""')}"\n`;
            });
        } else {
            toast('图表数据格式暂不支持导出', 'warning');
            return;
        }

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `${(chart.title?.text || 'chart_data').replace(/[<>:"/\\|?*]/g, '_').slice(0, 60)}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    Object.assign(app, {
        chartNumericFields,
        selectHasOption,
        syncChartAggregationControls,
        syncChartTypeControls,
        buildChart,
        renderChart,
        downloadChartPng,
        exportTableToCsv,
        exportChartDataToCsv
    });
})();
