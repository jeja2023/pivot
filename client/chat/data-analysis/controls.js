(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { state, esc, activeDataset } = app;
    const syncChartAggregationControls = (...args) => app.syncChartAggregationControls(...args);
    const syncChartTypeControls = (...args) => app.syncChartTypeControls(...args);
    const renderVisualQueryControls = (...args) => app.renderVisualQueryControls(...args);

    function buildOptions(columns = [], { includeEmpty = false, emptyLabel = '无' } = {}) {
        const options = includeEmpty ? [`<option value="">${esc(emptyLabel)}</option>`] : [];
        columns.forEach(column => {
            options.push(`<option value="${esc(column.key)}">${esc(column.name)}</option>`);
        });
        return options.join('');
    }

    function setSelectOptions(id, htmlText, value) {
        const el = document.getElementById(id);
        if (!el) return;
        const previous = value !== undefined ? value : el.value;
        PivotSafeHtml.setHtml(el, htmlText);
        if (Array.from(el.options).some(option => option.value === previous)) {
            el.value = previous;
        } else {
            el.value = '';
        }
    }

    function renderControls() {
        const dataset = activeDataset();
        const columns = dataset?.columns || [];
        setSelectOptions('data-analysis-chart-x', buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择分类字段' }));
        setSelectOptions('data-analysis-chart-y', buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择数值字段' }));
        setSelectOptions('data-analysis-chart-y2', buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择辅助数值字段' }));
        setSelectOptions('data-analysis-chart-group', buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择分组字段' }));
        syncChartAggregationControls('auto');
        syncChartTypeControls('auto');
        
        const datasetOptions = `<option value="">请选择数据集</option>` + state.datasets.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
        setSelectOptions('data-analysis-compare-left', datasetOptions, state.compareLeftId);
        setSelectOptions('data-analysis-compare-right', datasetOptions, state.compareRightId);
        renderCompareKeyOptions();

        // 渲染各个具体分析页面的数据集选择框
        setSelectOptions('data-analysis-chart-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-cleaning-dataset', datasetOptions, state.cleaningDatasetId || state.activeId);
        setSelectOptions('data-analysis-query-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-pivot-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-ai-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-semantic-dataset', datasetOptions, state.semanticDatasetId || state.activeId || '');
        setSelectOptions('data-analysis-history-dataset', datasetOptions, state.activeId);
        
        // 渲染可视化查询编辑器
        renderVisualQueryControls();

        // 渲染智能分析数据集画像与引导看板
        app.renderAiDatasetProfile?.();
        app.renderSemanticControls?.();
        app.renderCleaning?.();
    }

    function renderCompareKeyOptions() {
        const leftId = document.getElementById('data-analysis-compare-left')?.value;
        const rightId = document.getElementById('data-analysis-compare-right')?.value;
        const left = state.datasets.find(item => item.id === leftId) || null;
        const right = state.datasets.find(item => item.id === rightId) || null;
        setSelectOptions('data-analysis-compare-left-key', buildOptions(left?.columns || [], { includeEmpty: true, emptyLabel: '请选择左侧主键' }));
        setSelectOptions('data-analysis-compare-right-key', buildOptions(right?.columns || [], { includeEmpty: true, emptyLabel: '请选择右侧主键' }));
        setSelectOptions('data-analysis-compare-field', buildOptions(left?.columns || [], { includeEmpty: true, emptyLabel: '请选择对比字段（留空仅比对主键）' }));
    }

    Object.assign(app, { buildOptions, setSelectOptions, renderControls, renderCompareKeyOptions });
})();
