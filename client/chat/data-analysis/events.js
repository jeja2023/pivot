
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state } = app;
    const updateToolbarHeader = (...args) => app.updateToolbarHeader(...args);
    const uploadDataset = (...args) => app.uploadDataset(...args);
    const renderCompareKeyOptions = (...args) => app.renderCompareKeyOptions(...args);
    const syncChartAggregationControls = (...args) => app.syncChartAggregationControls(...args);
    const syncChartTypeControls = (...args) => app.syncChartTypeControls(...args);
    const loadDatasetDetail = (...args) => app.loadDatasetDetail(...args);
    const loadArtifacts = (...args) => app.loadArtifacts(...args);
    const renderVisualFilters = (...args) => app.renderVisualFilters(...args);
    const runQueryVisual = (...args) => app.runQueryVisual(...args);
    const previewDataset = (...args) => app.previewDataset(...args);
    const fetchJson = (...args) => app.fetchJson(...args);
    const toast = (...args) => app.toast(...args);
    const setBusy = (...args) => app.setBusy(...args);
    const loadDatasets = (...args) => app.loadDatasets(...args);
    const showCompareDetailModal = (...args) => app.showCompareDetailModal(...args);
    const importFromDatabase = (...args) => app.importFromDatabase(...args);
    const submitDatabaseImport = (...args) => app.submitDatabaseImport(...args);
    const renderChart = (...args) => app.renderChart(...args);
    const buildChart = (...args) => app.buildChart(...args);
    const downloadChartPng = (...args) => app.downloadChartPng(...args);
    const exportChartDataToCsv = (...args) => app.exportChartDataToCsv(...args);
    const runCompare = (...args) => app.runCompare(...args);
    const exportCompareToExcel = (...args) => app.exportCompareToExcel(...args);
    const buildSqlFromVisual = (...args) => app.buildSqlFromVisual(...args);
    const runQuery = (...args) => app.runQuery(...args);
    const exportTableToCsv = (...args) => app.exportTableToCsv(...args);
    const runPivot = (...args) => app.runPivot(...args);
    const syncPivotAggregationControls = (...args) => app.syncPivotAggregationControls(...args);
    const applyPivotRecommendations = (...args) => app.applyPivotRecommendations(...args);
    const runAi = (...args) => app.runAi(...args);

    function activateTab(tab) {
        document.querySelectorAll('.data-analysis-tab').forEach(button => {
            button.classList.toggle('active', button.dataset.dataAnalysisTab === tab);
        });
        document.querySelectorAll('.data-analysis-tab-panel').forEach(panel => {
            panel.classList.toggle('hidden', panel.id !== `data-analysis-${tab}-panel`);
        });
        // 切换 Tab 时同步更新顶部标题和简介
        updateToolbarHeader(tab);
    }

    function bindEvents(root) {
        root.addEventListener('change', async event => {
            if (event.target?.id === 'data-analysis-file') {
                uploadDataset(event.target.files?.[0]);
                event.target.value = '';
                return;
            }
            if (['data-analysis-compare-left', 'data-analysis-compare-right'].includes(event.target?.id)) {
                renderCompareKeyOptions();
                return;
            }
            if (event.target?.id === 'data-analysis-chart-y') {
                syncChartAggregationControls('y');
                return;
            }
            if (event.target?.id === 'data-analysis-chart-aggregation') {
                syncChartAggregationControls('aggregation', true);
                return;
            }
            if (event.target?.id === 'data-analysis-pivot-aggregation') {
                syncPivotAggregationControls('aggregation', true);
                return;
            }
            if (event.target?.id === 'data-analysis-pivot-value') {
                syncPivotAggregationControls('value');
                return;
            }
            if (event.target?.id === 'data-analysis-chart-type') {
                syncChartTypeControls('type');
                return;
            }
            if ([
                'data-analysis-chart-dataset',
                'data-analysis-query-dataset',
                'data-analysis-pivot-dataset',
                'data-analysis-ai-dataset',
                'data-analysis-history-dataset'
            ].includes(event.target?.id)) {
                const targetDatasetId = event.target.value;
                try {
                    await loadDatasetDetail(targetDatasetId);
                } catch (e) {
                    console.error('[data-analysis] loadDatasetDetail 失败', e);
                    toast(e && e.message ? e.message : '加载数据集详情失败', 'error');
                }
                const activeTabEl = document.querySelector('.data-analysis-tab.active');
                const activeTabName = activeTabEl?.dataset.dataAnalysisTab;
                if (activeTabName === 'history') loadArtifacts();
                return;
            }
            
            // 筛选条件变化同步到 state
            const filterRow = event.target.closest('.data-analysis-query-filter-row');
            if (filterRow) {
                const index = Number(filterRow.dataset.filterIndex);
                if (state.visualQuery.filters[index]) {
                    if (event.target.classList.contains('data-analysis-query-filter-field')) {
                        state.visualQuery.filters[index].field = event.target.value;
                    } else if (event.target.classList.contains('data-analysis-query-filter-operator')) {
                        state.visualQuery.filters[index].operator = event.target.value;
                        renderVisualFilters();
                    } else if (event.target.classList.contains('data-analysis-query-filter-value')) {
                        state.visualQuery.filters[index].value = event.target.value;
                    }
                }
                return;
            }
            if (event.target?.id === 'data-analysis-query-visual-op') {
                state.visualQuery.logicalOperator = event.target.value;
                return;
            }
            if (event.target?.id === 'data-analysis-query-visual-sort-field') {
                state.visualQuery.sortField = event.target.value;
                return;
            }
            if (event.target?.id === 'data-analysis-query-visual-sort-order') {
                state.visualQuery.sortOrder = event.target.value;
                return;
            }
            if (event.target?.id === 'data-analysis-query-visual-limit') {
                state.visualQuery.limit = Number(event.target.value) || 100;
                return;
            }
        });

        // 捕获用户在筛选输入框的实时打字输入以保存筛选值
        root.addEventListener('input', event => {
            const filterRow = event.target.closest('.data-analysis-query-filter-row');
            if (filterRow && event.target.classList.contains('data-analysis-query-filter-value')) {
                const index = Number(filterRow.dataset.filterIndex);
                if (state.visualQuery.filters[index]) {
                    state.visualQuery.filters[index].value = event.target.value;
                }
            }
            if (event.target?.id === 'data-analysis-query-visual-limit') {
                state.visualQuery.limit = Number(event.target.value) || 100;
            }
        });
        root.addEventListener('click', async event => {
            // 切换为可视化查询模式
            if (event.target.closest('#data-analysis-query-mode-visual')) {
                state.queryMode = 'visual';
                document.getElementById('data-analysis-query-mode-visual').classList.add('active');
                document.getElementById('data-analysis-query-mode-sql').classList.remove('active');
                document.getElementById('data-analysis-query-visual-box').classList.remove('hidden');
                document.getElementById('data-analysis-query-sql-box').classList.add('hidden');
                return;
            }
            // 切换为 SQL 查询模式（高级）
            if (event.target.closest('#data-analysis-query-mode-sql')) {
                state.queryMode = 'sql';
                document.getElementById('data-analysis-query-mode-sql').classList.add('active');
                document.getElementById('data-analysis-query-mode-visual').classList.remove('active');
                document.getElementById('data-analysis-query-sql-box').classList.remove('hidden');
                document.getElementById('data-analysis-query-visual-box').classList.add('hidden');
                
                const sqlTextarea = document.getElementById('data-analysis-query-sql');
                if (sqlTextarea) {
                    try {
                        const sql = buildSqlFromVisual();
                        if (sql) sqlTextarea.value = sql;
                    } catch (_e) {}
                }
                return;
            }
            // 添加可视化查询筛选条件
            if (event.target.closest('#data-analysis-query-visual-add')) {
                state.visualQuery.filters.push({ field: '', operator: 'eq', value: '' });
                renderVisualFilters();
                return;
            }
            // 删除可视化查询筛选条件
            const removeBtn = event.target.closest('.data-analysis-query-filter-remove');
            if (removeBtn) {
                const filterRow = removeBtn.closest('.data-analysis-query-filter-row');
                if (filterRow) {
                    const index = Number(filterRow.dataset.filterIndex);
                    state.visualQuery.filters.splice(index, 1);
                    renderVisualFilters();
                }
                return;
            }
            // 运行可视化查询
            if (event.target.closest('#data-analysis-run-query-visual')) {
                await runQueryVisual();
                return;
            }

            // 数据集行内“预览”按钮
            const previewBtn = event.target.closest('[data-data-analysis-action-preview]');
            if (previewBtn) {
                await previewDataset(previewBtn.dataset.dataAnalysisActionPreview);
                return;
            }
            // 数据集行内“导出”按钮
            const rowExportBtn = event.target.closest('[data-data-analysis-action-export]');
            if (rowExportBtn) {
                const datasetId = rowExportBtn.dataset.dataAnalysisActionExport;
                // 默认以 Excel (.xlsx) 格式导出原始数据集
                window.location.href = `${API}/datasets/${encodeURIComponent(datasetId)}/export?format=xlsx`;
                return;
            }
            // 数据集行内“删除”按钮
            const rowDeleteBtn = event.target.closest('[data-data-analysis-action-delete]');
            if (rowDeleteBtn) {
                const datasetId = rowDeleteBtn.dataset.dataAnalysisActionDelete;
                const dataset = state.datasets.find(item => item.id === datasetId);
                if (!dataset) return;
                const confirmed = typeof window.showConfirm === 'function'
                    ? await window.showConfirm('删除数据集', `确定删除数据集「${dataset.name}」吗？删除后相关分析记录和文件也会一并清理。`)
                    : false;
                if (!confirmed) return;
                setBusy(true, '正在删除数据集...');
                try {
                    await fetchJson(`${API}/datasets/${encodeURIComponent(datasetId)}`, { method: 'DELETE' });
                    toast('数据集已删除');
                    if (state.activeId === datasetId) {
                        state.activeId = '';
                    }
                    await loadDatasets({ keepActive: false });
                } catch (e) {
                    toast(e && e.message ? e.message : '删除失败', 'error');
                } finally {
                    setBusy(false);
                }
                return;
            }
            // 关闭预览弹窗按钮
            if (event.target.closest('#data-analysis-preview-modal-close')) {
                document.getElementById('data-analysis-preview-modal')?.classList.add('hidden');
                return;
            }
            // 关闭比对列表放大弹窗按钮
            if (event.target.closest('#data-analysis-compare-modal-close')) {
                document.getElementById('data-analysis-compare-modal')?.classList.add('hidden');
                return;
            }
            // 点击比对列表放大查看
            const compareSection = event.target.closest('.data-analysis-compare-lists section');
            if (compareSection) {
                const type = compareSection.dataset.compareType;
                if (type) showCompareDetailModal(type);
                return;
            }
            // 关闭/取消数据库导入弹窗
            if (event.target.closest('#data-analysis-db-import-modal-close') || event.target.closest('#data-analysis-db-import-modal-cancel')) {
                document.getElementById('data-analysis-db-import-modal')?.classList.add('hidden');
                return;
            }
            // 提交数据库导入
            if (event.target.closest('#data-analysis-db-import-submit')) {
                await submitDatabaseImport();
                return;
            }
            const tab = event.target.closest('[data-data-analysis-tab]');
            if (tab) {
                const name = tab.dataset.dataAnalysisTab;
                activateTab(name);
                if (name === 'history') loadArtifacts();
                return;
            }
            if (event.target.closest('#data-analysis-import-db')) {
                await importFromDatabase();
                return;
            }
            const historyItem = event.target.closest('[data-data-analysis-history]');
            if (historyItem) {
                const item = state.artifacts?.[Number(historyItem.dataset.dataAnalysisHistory)];
                if (item && item.chart) {
                    state.chart = item.chart;
                    activateTab('chart');
                    renderChart();
                }
                return;
            }
            const suggestion = event.target.closest('[data-data-analysis-chart-suggestion]');
            if (suggestion) {
                const item = state.summary?.suggestions?.[Number(suggestion.dataset.dataAnalysisChartSuggestion)];
                if (item) {
                    document.getElementById('data-analysis-chart-x').value = item.xField || '';
                    document.getElementById('data-analysis-chart-y').value = item.yField || '';
                    document.getElementById('data-analysis-chart-aggregation').value = item.aggregation || 'count';
                    document.getElementById('data-analysis-chart-type').value = item.chartType || 'bar';
                    syncChartTypeControls('type');
                    await buildChart();
                }
                return;
            }
            if (event.target.closest('#data-analysis-overview-refresh')) {
                await loadDatasets({ keepActive: true });
                return;
            }
            if (event.target.closest('#data-analysis-build-chart')) {
                await buildChart();
                return;
            }
            if (event.target.closest('#data-analysis-chart-png')) {
                downloadChartPng();
                return;
            }
            if (event.target.closest('#data-analysis-chart-data-csv')) {
                exportChartDataToCsv();
                return;
            }
            if (event.target.closest('#data-analysis-run-compare')) {
                await runCompare();
                return;
            }
            if (event.target.closest('#data-analysis-compare-export-btn')) {
                exportCompareToExcel();
                return;
            }
            const queryField = event.target.closest('[data-data-analysis-query-field]');
            if (queryField) {
                const textarea = document.getElementById('data-analysis-query-sql');
                if (textarea) {
                    const name = queryField.dataset.dataAnalysisQueryField;
                    const needsQuote = /[^A-Za-z0-9_]/.test(name);
                    const token = needsQuote ? `"${name}"` : name;
                    const start = textarea.selectionStart ?? textarea.value.length;
                    const end = textarea.selectionEnd ?? textarea.value.length;
                    textarea.value = textarea.value.slice(0, start) + token + textarea.value.slice(end);
                    textarea.focus();
                    textarea.selectionStart = textarea.selectionEnd = start + token.length;
                }
                return;
            }
            if (event.target.closest('#data-analysis-run-query')) {
                await runQuery();
                return;
            }
            if (event.target.closest('#data-analysis-query-export-btn')) {
                const table = document.querySelector('.data-analysis-query-table table');
                exportTableToCsv(table, '数据查询结果.csv');
                return;
            }
            if (event.target.closest('#data-analysis-pivot-recommend')) {
                applyPivotRecommendations({ force: true });
                return;
            }
            if (event.target.closest('#data-analysis-run-pivot')) {
                await runPivot();
                return;
            }
            if (event.target.closest('#data-analysis-pivot-export-btn')) {
                const table = document.querySelector('.data-analysis-pivot-table table');
                exportTableToCsv(table, '数据透视分析结果.csv');
                return;
            }
            if (event.target.closest('#data-analysis-ai-run')) {
                await runAi();
                return;
            }
        });
    }

    Object.assign(app, {
        activateTab,
        bindEvents
    });
})();
