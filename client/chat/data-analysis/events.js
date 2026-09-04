
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state } = app;
    const updateToolbarHeader = (...args) => app.updateToolbarHeader(...args), uploadDataset = (...args) => app.uploadDataset(...args);
    const renderCompareKeyOptions = (...args) => app.renderCompareKeyOptions(...args), syncChartAggregationControls = (...args) => app.syncChartAggregationControls(...args);
    const syncChartTypeControls = (...args) => app.syncChartTypeControls(...args), loadDatasetDetail = (...args) => app.loadDatasetDetail(...args);
    const loadArtifacts = (...args) => app.loadArtifacts(...args), renderVisualFilters = (...args) => app.renderVisualFilters(...args);
    const runQueryVisual = (...args) => app.runQueryVisual(...args), previewDataset = (...args) => app.previewDataset(...args);
    const fetchJson = (...args) => app.fetchJson(...args), toast = (...args) => app.toast(...args), setBusy = (...args) => app.setBusy(...args);
    const loadDatasets = (...args) => app.loadDatasets(...args), showCompareDetailModal = (...args) => app.showCompareDetailModal(...args);
    const importFromDatabase = (...args) => app.importFromDatabase(...args), submitDatabaseImport = (...args) => app.submitDatabaseImport(...args);
    const renderChart = (...args) => app.renderChart(...args), buildChart = (...args) => app.buildChart(...args);
    const downloadChartPng = (...args) => app.downloadChartPng(...args), exportChartDataToCsv = (...args) => app.exportChartDataToCsv(...args);
    const runCompare = (...args) => app.runCompare(...args), exportCompareToExcel = (...args) => app.exportCompareToExcel(...args);
    const buildSqlFromVisual = (...args) => app.buildSqlFromVisual(...args), runQuery = (...args) => app.runQuery(...args);
    const exportTableToCsv = (...args) => app.exportTableToCsv(...args), runPivot = (...args) => app.runPivot(...args);
    const syncPivotAggregationControls = (...args) => app.syncPivotAggregationControls(...args), applyPivotRecommendations = (...args) => app.applyPivotRecommendations(...args);
    const runAi = (...args) => app.runAi(...args), runSemanticAnalysis = (...args) => app.runSemanticAnalysis(...args);
    const cancelSemanticAnalysis = (...args) => app.cancelSemanticAnalysis(...args), retrySemanticAnalysis = (...args) => app.retrySemanticAnalysis(...args);
    const selectSemanticJob = (...args) => app.selectSemanticJob?.(...args), openSemanticHistoryRecord = (...args) => app.openSemanticHistoryRecord?.(...args);
    const openAiAnalysisHistoryRecord = (...args) => app.openAiAnalysisHistoryRecord?.(...args), resetAiWorkspace = (...args) => app.resetAiWorkspace?.(...args);
    const resumeAiWorkspace = (...args) => app.resumeAiWorkspace?.(...args), normalizeTab = (...args) => app.normalizeTab(...args);
    const persistActiveTab = (...args) => app.persistActiveTab(...args), createVisualQuery = (...args) => app.createVisualQuery(...args);

    function activateTab(tab) {
        const previousTab = document.querySelector('.data-analysis-tab.active')?.dataset.dataAnalysisTab;
        const targetTab = normalizeTab(tab);
        if (previousTab && previousTab !== targetTab) clearTabData(previousTab);
        document.querySelectorAll('.data-analysis-tab').forEach(button => {
            button.classList.toggle('active', button.dataset.dataAnalysisTab === targetTab);
        });
        document.querySelectorAll('.data-analysis-tab-panel').forEach(panel => {
            panel.classList.toggle('hidden', panel.id !== `data-analysis-${targetTab}-panel`);
        });
        if (targetTab === 'ai') resumeAiWorkspace();
        // 切换 Tab 时同步更新顶部标题和简介
        updateToolbarHeader(targetTab);
        persistActiveTab(targetTab);
    }

    function resetInputs(values) {
        Object.entries(values).forEach(([id, value]) => {
            const input = document.getElementById(id);
            if (input) input.value = value;
        });
    }

    // 页签切换只清理浏览器内的临时输入与分析结果；数据集和服务端历史记录不会被删除。
    function clearTabData(tab) {
        switch (normalizeTab(tab)) {
        case 'overview':
            state.previewDatasetId = '';
            state.previewPage = 1;
            document.getElementById('data-analysis-preview-modal')?.classList.add('hidden');
            break;
        case 'cleaning':
            app.resetCleaningWorkspace?.();
            break;
        case 'chart':
            state.chart = null;
            resetInputs({
                'data-analysis-chart-x': '', 'data-analysis-chart-y': '', 'data-analysis-chart-group': '',
                'data-analysis-chart-aggregation': 'sum', 'data-analysis-chart-type': 'bar',
                'data-analysis-chart-limit': '30', 'data-analysis-chart-sort': 'value_desc', 'data-analysis-chart-palette': 'teal'
            });
            app.renderChart?.();
            break;
        case 'compare':
            state.compare = null;
            state.compareLeftId = '';
            state.compareRightId = '';
            ['data-analysis-compare-left', 'data-analysis-compare-right'].forEach(id => {
                const input = document.getElementById(id);
                if (input) input.value = '';
            });
            app.renderCompareKeyOptions?.();
            app.renderCompare?.();
            document.getElementById('data-analysis-compare-modal')?.classList.add('hidden');
            break;
        case 'query': {
            state.query = null;
            state.queryPage = 1;
            state.queryMode = 'visual';
            state.visualQuery = createVisualQuery();
            const sqlInput = document.getElementById('data-analysis-query-sql');
            if (sqlInput) sqlInput.value = '';
            document.getElementById('data-analysis-query-mode-visual')?.classList.add('active');
            document.getElementById('data-analysis-query-mode-sql')?.classList.remove('active');
            document.getElementById('data-analysis-query-visual-box')?.classList.remove('hidden');
            document.getElementById('data-analysis-query-sql-box')?.classList.add('hidden');
            app.renderVisualQueryControls?.();
            app.renderQuery?.();
            break;
        }
        case 'pivot':
            state.pivot = null;
            resetInputs({
                'data-analysis-pivot-row': '', 'data-analysis-pivot-col': '', 'data-analysis-pivot-value': '',
                'data-analysis-pivot-aggregation': 'sum', 'data-analysis-pivot-row-limit': '50', 'data-analysis-pivot-col-limit': '20',
                'data-analysis-pivot-sort': 'total_desc', 'data-analysis-pivot-empty-label': '(空值)', 'data-analysis-pivot-percent-mode': 'none'
            });
            app.renderPivot?.();
            break;
        case 'ai':
            resetAiWorkspace();
            break;
        case 'history':
            state.artifacts = [];
            state.historyPage = 1;
            app.renderHistory?.();
            break;
        default:
            break;
        }
    }

    let cellTooltipEl = null;
    let activeTooltipTarget = null;

    function ensureCellTooltip() {
        if (cellTooltipEl?.isConnected) return cellTooltipEl;
        cellTooltipEl = document.createElement('div');
        cellTooltipEl.className = 'data-analysis-cell-tooltip hidden';
        cellTooltipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(cellTooltipEl);
        return cellTooltipEl;
    }

    function positionCellTooltip(target) {
        if (!cellTooltipEl || !target) return;
        const rect = target.getBoundingClientRect();
        const tooltipRect = cellTooltipEl.getBoundingClientRect();
        const gap = 6;
        const viewportPadding = 12;

        let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
        left = Math.min(Math.max(left, viewportPadding), window.innerWidth - tooltipRect.width - viewportPadding);

        let top = rect.top - tooltipRect.height - gap;
        if (top < viewportPadding) {
            top = rect.bottom + gap;
        }
        cellTooltipEl.style.left = `${Math.round(left)}px`;
        cellTooltipEl.style.top = `${Math.round(top)}px`;
    }

    function showCellTooltip(target) {
        const text = target?.dataset?.cellFull;
        if (!text) return;
        const isTruncated = target.scrollWidth > target.clientWidth;
        if (!isTruncated && text.length <= 16) return;

        const tooltip = ensureCellTooltip();
        tooltip.textContent = text;
        tooltip.classList.remove('hidden');
        activeTooltipTarget = target;
        positionCellTooltip(target);
    }

    function hideCellTooltip(target = null) {
        if (target && target !== activeTooltipTarget) return;
        cellTooltipEl?.classList.add('hidden');
        activeTooltipTarget = null;
    }

    function openEditDatasetModal(datasetId) {
        const dataset = state.datasets.find(item => item.id === datasetId);
        if (!dataset) return;
        const modal = document.getElementById('data-analysis-edit-dataset-modal');
        const idInput = document.getElementById('data-analysis-edit-dataset-id');
        const nameInput = document.getElementById('data-analysis-edit-dataset-name');
        const origInput = document.getElementById('data-analysis-edit-dataset-original-name');
        const metaEl = document.getElementById('data-analysis-edit-dataset-meta');
        if (!modal || !idInput || !nameInput || !origInput) return;
        idInput.value = dataset.id || '';
        nameInput.value = dataset.name || '';
        origInput.value = dataset.originalName || '';
        if (metaEl) {
            const fileTypeLabel = dataset.fileType === 'cleaned' ? '清洗后数据' : (dataset.fileType || '表格');
            const rowCount = Number(dataset.rowCount || 0).toLocaleString();
            const colCount = Number(dataset.columnCount || 0).toLocaleString();
            const esc = str => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            if (window.PivotSafeHtml?.setHtml) {
                window.PivotSafeHtml.setHtml(metaEl, `<div><strong>数据规模：</strong>${rowCount} 行 / ${colCount} 列</div><div><strong>文件类型：</strong>${esc(fileTypeLabel)}</div><div><strong>创建时间：</strong>${esc(dataset.createdAt || '-')}</div>`);
            } else {
                metaEl.textContent = `规模: ${rowCount} 行 / ${colCount} 列 | 类型: ${fileTypeLabel} | 创建: ${dataset.createdAt || '-'}`;
            }
        }
        modal.classList.remove('hidden');
        nameInput.focus();
    }

    function closeEditDatasetModal() {
        document.getElementById('data-analysis-edit-dataset-modal')?.classList.add('hidden');
    }

    async function submitEditDataset() {
        const datasetId = document.getElementById('data-analysis-edit-dataset-id')?.value?.trim();
        const nameInput = document.getElementById('data-analysis-edit-dataset-name');
        const name = nameInput?.value?.trim();
        const originalName = document.getElementById('data-analysis-edit-dataset-original-name')?.value?.trim() ?? '';
        if (!datasetId) return;
        if (!name) {
            toast('请输入数据集名称', 'warning');
            nameInput?.focus();
            return;
        }
        const saveBtn = document.getElementById('data-analysis-edit-dataset-save');
        if (saveBtn) saveBtn.disabled = true;
        setBusy(true, '正在保存修改...');
        try {
            await fetchJson(`${API}/datasets/${encodeURIComponent(datasetId)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, originalName })
            });
            toast('数据集信息已更新', 'success');
            closeEditDatasetModal();
            await loadDatasets({ keepActive: true });
        } catch (e) {
            toast(e && e.message ? e.message : '保存失败', 'error');
        } finally {
            if (saveBtn) saveBtn.disabled = false;
            setBusy(false);
        }
    }

    function bindEvents(root) {
        root.addEventListener('submit', async event => {
            if (event.target?.id === 'data-analysis-edit-dataset-form') {
                event.preventDefault();
                await submitEditDataset();
            }
        });
        root.addEventListener('change', async event => {
            if (event.target?.id === 'data-analysis-file') {
                uploadDataset(event.target.files?.[0]);
                event.target.value = '';
                return;
            }
            if (event.target?.id === 'data-analysis-cleaning-dataset') {
                const targetDatasetId = event.target.value;
                if (!targetDatasetId) {
                    app.resetCleaningWorkspace?.();
                    app.renderCleaning?.();
                    return;
                }
                try {
                    await loadDatasetDetail(targetDatasetId);
                    state.cleaningDatasetId = targetDatasetId;
                    await app.loadCleaningWorkspace?.(targetDatasetId, { resetPreview: true });
                } catch (e) {
                    console.error('[data-analysis] 加载数据清洗工作台失败', e);
                    toast(e && e.message ? e.message : '加载数据清洗工作台失败', 'error');
                }
                return;
            }
            if (event.target.closest?.('[data-cleaning-rule-input]')) {
                if (app.updateCleaningRuleInput?.(event.target)) return;
            }
            if (event.target.closest?.('[data-cleaning-dedup-field]')) {
                if (app.updateCleaningDedupField?.(event.target)) return;
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
            if (event.target?.id === 'data-analysis-semantic-dataset') {
                const targetDatasetId = event.target.value;
                state.semanticDatasetId = targetDatasetId || '';
                if (targetDatasetId) {
                    let dataset = state.datasets.find(item => item.id === targetDatasetId);
                    if (!dataset || !Array.isArray(dataset.columns) || dataset.columns.length === 0) {
                        try {
                            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(targetDatasetId)}`);
                            const index = state.datasets.findIndex(item => item.id === targetDatasetId);
                            if (index >= 0) state.datasets[index] = data.dataset;
                            else state.datasets.push(data.dataset);
                        } catch (e) {
                            console.error('[data-analysis] 获取全量分析数据集详情失败', e);
                        }
                    }
                    if (typeof app.loadSemanticJobs === 'function') {
                        try {
                            await app.loadSemanticJobs(targetDatasetId);
                        } catch (e) {
                            console.error('[data-analysis] 加载全量语义分析任务记录失败', e);
                            toast(e && e.message ? e.message : '加载全量语义分析任务记录失败', 'error');
                        }
                    }
                } else {
                    state.semanticJobs = [];
                    state.semanticJob = null;
                    if (typeof app.renderSemanticControls === 'function') {
                        app.renderSemanticControls();
                    }
                }
                return;
            }
            if (event.target?.id === 'data-analysis-semantic-job') {
                const selectedText = event.target.options?.[event.target.selectedIndex]?.text || '';
                event.target.title = selectedText;
                try {
                    await selectSemanticJob(event.target.value, { datasetId: state.semanticDatasetId });
                } catch (e) {
                    console.error('[data-analysis] 打开全量语义分析任务记录失败', e);
                    toast(e && e.message ? e.message : '打开全量语义分析任务记录失败', 'error');
                }
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
            if (event.target?.id === 'data-analysis-ai-prompt') {
                const clearBtn = document.getElementById('data-analysis-ai-clear-prompt');
                if (clearBtn) clearBtn.classList.toggle('hidden', !event.target.value.trim());
            }
            if (event.target?.id === 'data-cleaning-name') {
                state.cleaningRunName = event.target.value;
            }
            if (event.target.closest?.('[data-cleaning-rule-input]')) {
                app.updateCleaningRuleInput?.(event.target);
            }
        });

        // 智能分析提问框支持 Enter 发送，Shift+Enter 换行
        root.addEventListener('keydown', async event => {
            if (event.target?.id === 'data-analysis-ai-prompt' && event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                await runAi();
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
            // 数据集行内“编辑”按钮
            const rowEditBtn = event.target.closest('[data-data-analysis-action-edit]');
            if (rowEditBtn) {
                openEditDatasetModal(rowEditBtn.dataset.dataAnalysisActionEdit);
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
                        resetAiWorkspace();
                    }
                    await loadDatasets({ keepActive: false });
                } catch (e) {
                    toast(e && e.message ? e.message : '删除失败', 'error');
                } finally {
                    setBusy(false);
                }
                return;
            }
            // 关闭预览弹窗按钮或点击遮罩层
            if (event.target.closest('#data-analysis-preview-modal-close') || event.target.id === 'data-analysis-preview-modal') {
                hideCellTooltip();
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
            // 取消编辑数据集弹窗或点击遮罩层
            if (event.target.closest('#data-analysis-edit-dataset-cancel') ||
                event.target.id === 'data-analysis-edit-dataset-modal') {
                closeEditDatasetModal();
                return;
            }
            // 保存数据集编辑
            if (event.target.closest('#data-analysis-edit-dataset-save')) {
                event.preventDefault();
                await submitEditDataset();
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
            const subtab = event.target.closest('[data-ai-subtab]');
            if (subtab) {
                const subtabName = subtab.dataset.aiSubtab;
                document.querySelectorAll('.data-analysis-subtab').forEach(btn => {
                    const isActive = btn.dataset.aiSubtab === subtabName;
                    btn.classList.toggle('active', isActive);
                    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
                });
                document.getElementById('data-analysis-ai-subpanel-chat')?.classList.toggle('hidden', subtabName !== 'chat');
                document.getElementById('data-analysis-ai-subpanel-semantic')?.classList.toggle('hidden', subtabName !== 'semantic');
                if (subtabName === 'semantic') {
                    if (!state.semanticDatasetId && state.activeId) {
                        state.semanticDatasetId = state.activeId;
                    }
                    const targetDatasetId = state.semanticDatasetId || state.activeId;
                    if (targetDatasetId) {
                        state.semanticDatasetId = targetDatasetId;
                        if (typeof app.loadSemanticJobs === 'function') {
                            app.loadSemanticJobs(targetDatasetId).catch(console.error);
                        } else if (typeof app.renderSemanticControls === 'function') {
                            app.renderSemanticControls();
                        }
                    } else if (typeof app.renderSemanticControls === 'function') {
                        app.renderSemanticControls();
                    }
                }
                return;
            }
            const tab = event.target.closest('[data-data-analysis-tab]');
            if (tab) {
                const name = tab.dataset.dataAnalysisTab;
                activateTab(name);
                if (name === 'history') loadArtifacts();
                if (name === 'cleaning') {
                    app.loadCleaningWorkspace?.(state.cleaningDatasetId || state.activeId, { resetPreview: true })
                        .catch(error => toast(error?.message || '加载数据清洗工作台失败', 'error'));
                }
                return;
            }
            if (event.target.closest('#data-cleaning-refresh')) {
                try {
                    await app.loadCleaningWorkspace?.(state.cleaningDatasetId || state.activeId, { resetPreview: false });
                    toast('数据质量报告已刷新', 'success');
                } catch (e) {
                    toast(e?.message || '刷新数据质量报告失败', 'error');
                }
                return;
            }
            if (event.target.closest('#data-cleaning-add-rule')) {
                state.cleaningRules.push(app.createCleaningRule?.() || {});
                state.cleaningPreview = null;
                app.renderCleaning?.();
                return;
            }
            const templateBtn = event.target.closest('[data-cleaning-template]');
            if (templateBtn) {
                const datasetId = state.cleaningDatasetId || state.activeId;
                if (!datasetId) {
                    toast('请先选择需要清洗的数据集', 'warning');
                    return;
                }
                const templateKey = templateBtn.dataset.cleaningTemplate;
                let rule = null;
                const columns = app.getCleaningColumns ? app.getCleaningColumns() : (state.datasets?.find(d => d.id === datasetId)?.columns || []);
                const firstField = columns[0]?.key || '';
                if (templateKey === 'trim') {
                    rule = app.createCleaningRule?.('trim', firstField);
                } else if (templateKey === 'normalize_empty') {
                    rule = app.createCleaningRule?.('normalize_empty', firstField);
                } else if (templateKey === 'fill_missing_0') {
                    rule = app.createCleaningRule?.('fill_missing', firstField);
                    if (rule) {
                        rule.strategy = 'constant';
                        rule.value = '0';
                    }
                } else if (templateKey === 'deduplicate') {
                    rule = app.createCleaningRule?.('deduplicate');
                    if (rule && firstField) rule.fields = [firstField];
                } else if (templateKey === 'remove_outliers') {
                    const numericCol = columns.find(col => /int|float|double|num|dec/i.test(col.type || '')) || columns[0];
                    rule = app.createCleaningRule?.('remove_outliers', numericCol?.key || firstField);
                }
                if (rule) {
                    state.cleaningRules.push(rule);
                    state.cleaningPreview = null;
                    app.renderCleaning?.();
                    toast('已添加快捷清洗规则', 'success');
                }
                return;
            }
            const cleaningTabBtn = event.target.closest('[data-cleaning-tab]');
            if (cleaningTabBtn) {
                const tabName = cleaningTabBtn.dataset.cleaningTab;
                if (tabName && typeof app.switchCleaningTab === 'function') {
                    app.switchCleaningTab(tabName);
                }
                return;
            }
            const switchCleaningTabBtn = event.target.closest('[data-cleaning-switch-tab]');
            if (switchCleaningTabBtn) {
                const tabName = switchCleaningTabBtn.dataset.cleaningSwitchTab;
                if (tabName && typeof app.switchCleaningTab === 'function') {
                    app.switchCleaningTab(tabName);
                }
                return;
            }
            const suggestionRule = event.target.closest('[data-cleaning-add-suggestion]');
            if (suggestionRule) {
                const item = state.cleaningQuality?.recommendations?.[Number(suggestionRule.dataset.cleaningAddSuggestion)];
                if (item) {
                    const rule = app.createCleaningRule?.(item.operation, item.field) || {};
                    if (item.operation === 'deduplicate') rule.fields = item.fields || [];
                    state.cleaningRules.push(rule);
                    state.cleaningPreview = null;
                    app.renderCleaning?.();
                    toast('已采纳清洗规则建议', 'success');
                }
                return;
            }
            const deleteCleaningRule = event.target.closest('[data-cleaning-rule-delete]');
            if (deleteCleaningRule) {
                state.cleaningRules.splice(Number(deleteCleaningRule.dataset.cleaningRuleDelete), 1);
                state.cleaningPreview = null;
                app.renderCleaning?.();
                return;
            }
            const moveCleaningRule = event.target.closest('[data-cleaning-rule-move]');
            if (moveCleaningRule) {
                const card = moveCleaningRule.closest('[data-cleaning-rule-index]');
                const index = Number(card?.dataset.cleaningRuleIndex);
                const next = moveCleaningRule.dataset.cleaningRuleMove === 'up' ? index - 1 : index + 1;
                if (state.cleaningRules[index] && state.cleaningRules[next]) {
                    [state.cleaningRules[index], state.cleaningRules[next]] = [state.cleaningRules[next], state.cleaningRules[index]];
                    state.cleaningPreview = null;
                    app.renderCleaning?.();
                }
                return;
            }
            if (event.target.closest('#data-cleaning-preview-run')) {
                await app.previewCleaningRules?.();
                return;
            }
            if (event.target.closest('#data-cleaning-apply') || event.target.closest('#data-cleaning-preview-apply-cta')) {
                await app.applyCleaningRules?.();
                return;
            }
            if (event.target.closest('#data-cleaning-refresh-runs')) {
                try {
                    await app.loadCleaningWorkspace?.(state.cleaningDatasetId || state.activeId, { resetPreview: false });
                    toast('清洗记录已刷新', 'success');
                } catch (e) {
                    toast(e?.message || '刷新清洗记录失败', 'error');
                }
                return;
            }
            const openCleaningOutput = event.target.closest('[data-cleaning-open-output]');
            if (openCleaningOutput) {
                await loadDatasetDetail(openCleaningOutput.dataset.cleaningOpenOutput);
                activateTab('overview');
                return;
            }
            const loadCleaningRun = event.target.closest('[data-cleaning-load-run]');
            if (loadCleaningRun) {
                const run = state.cleaningRuns.find(item => item.id === loadCleaningRun.dataset.cleaningLoadRun);
                if (run) {
                    state.cleaningRules = Array.isArray(run.rules) ? run.rules.map(rule => ({ ...rule, fields: [...(rule.fields || [])] })) : [];
                    state.cleaningRunName = run.name ? `${run.name}（复制）` : '';
                    state.cleaningPreview = null;
                    app.renderCleaning?.();
                    app.switchCleaningTab?.('rules');
                    toast('已载入历史清洗规则，可预览后再次生成', 'success');
                }
                return;
            }
            const replayCleaningRun = event.target.closest('[data-cleaning-replay-run]');
            if (replayCleaningRun) {
                const run = state.cleaningRuns.find(item => item.id === replayCleaningRun.dataset.cleaningReplayRun);
                if (!run) return;
                const confirmed = typeof showConfirm === 'function'
                    ? await showConfirm('再次生成清洗后数据集', '将使用这条历史规则重新从源数据集生成新的派生数据集。')
                    : true;
                if (!confirmed) return;
                try {
                    const result = await app.fetchJson(`${API}/cleaning/runs/${encodeURIComponent(run.id)}/replay`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: `${run.name}（再次执行）` })
                    });
                    toast(`已生成清洗后数据集「${result.dataset?.name || ''}」`, 'success');
                    state.activeId = result.dataset?.id || state.activeId;
                    await app.loadDatasets?.({ keepActive: true });
                    activateTab('overview');
                } catch (e) {
                    toast(e?.message || '重新应用清洗规则失败', 'error');
                }
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
                } else if (item && item.analysis) {
                    activateTab('ai');
                    try {
                        await openAiAnalysisHistoryRecord(item, item.datasetId || state.activeId);
                    } catch (e) {
                        console.error('[data-analysis] 恢复 AI 分析历史记录失败', e);
                        toast(e && e.message ? e.message : '恢复 AI 分析历史记录失败', 'error');
                    }
                } else if (item && item.semantic) {
                    activateTab('ai');
                    document.querySelectorAll('.data-analysis-subtab').forEach(btn => {
                        const isActive = btn.dataset.aiSubtab === 'semantic';
                        btn.classList.toggle('active', isActive);
                        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
                    });
                    document.getElementById('data-analysis-ai-subpanel-chat')?.classList.add('hidden');
                    document.getElementById('data-analysis-ai-subpanel-semantic')?.classList.remove('hidden');
                    try {
                        await openSemanticHistoryRecord(item, item.datasetId || state.activeId);
                    } catch (e) {
                        console.error('[data-analysis] 恢复全量语义分析历史记录失败', e);
                        toast(e && e.message ? e.message : '恢复全量语义分析历史记录失败', 'error');
                    }
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
                if (typeof app.exportQueryResultToCsv === 'function') {
                    app.exportQueryResultToCsv();
                } else {
                    const table = document.querySelector('.data-analysis-query-table table');
                    exportTableToCsv(table, '数据查询结果.csv');
                }
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
            if (event.target.closest('#data-analysis-ai-stop')) {
                app.stopAi?.();
                return;
            }
            const aiChip = event.target.closest('.data-analysis-ai-scenario-card') || event.target.closest('.data-analysis-ai-chip');
            if (aiChip) {
                const prompt = aiChip.dataset.prompt || aiChip.textContent.trim();
                const promptInput = document.getElementById('data-analysis-ai-prompt');
                if (promptInput) {
                    promptInput.value = prompt;
                    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
                    promptInput.focus();
                    promptInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
                toast('已填入分析诉求，可继续补充或点击「生成建议」', 'info');
                return;
            }
            if (event.target.closest('#data-analysis-ai-clear-prompt')) {
                const promptInput = document.getElementById('data-analysis-ai-prompt');
                if (promptInput) {
                    promptInput.value = '';
                    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
                    promptInput.focus();
                }
                return;
            }
            if (event.target.closest('#data-analysis-ai-copy-result')) {
                const resultEl = document.getElementById('data-analysis-ai-result');
                const text = resultEl?.innerText || resultEl?.textContent || '';
                if (!text.trim()) {
                    toast('暂无分析报告可复制', 'warning');
                    return;
                }
                navigator.clipboard?.writeText(text).then(() => {
                    toast('已复制完整分析报告到剪贴板', 'success');
                }).catch(() => {
                    toast('复制失败，请手动选取文本', 'error');
                });
                return;
            }
            if (event.target.closest('#data-analysis-ai-reset-view')) {
                const resultEl = document.getElementById('data-analysis-ai-result');
                if (resultEl) PivotSafeHtml.setHtml(resultEl, '');
                document.getElementById('data-analysis-ai-result-wrap')?.classList.add('hidden');
                document.getElementById('data-analysis-ai-landing')?.classList.remove('hidden');
                const promptInput = document.getElementById('data-analysis-ai-prompt');
                if (promptInput) {
                    promptInput.value = '';
                    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                toast('已重置并返回探索引导看板', 'info');
                return;
            }
            if (event.target.closest('#data-analysis-semantic-run')) {
                await runSemanticAnalysis();
                return;
            }
            if (event.target.closest('#data-analysis-semantic-cancel')) {
                await cancelSemanticAnalysis();
                return;
            }
            if (event.target.closest('#data-analysis-semantic-retry')) {
                await retrySemanticAnalysis();
                return;
            }
            if (event.target.closest('#data-analysis-semantic-refresh-jobs')) {
                try {
                    await app.loadSemanticJobs?.(state.semanticDatasetId, {
                        preferredJobId: state.semanticSelectedJobId
                    });
                    toast('全量语义分析任务记录已刷新', 'success');
                } catch (e) {
                    console.error('[data-analysis] 刷新全量语义分析任务记录失败', e);
                    toast(e && e.message ? e.message : '刷新全量语义分析任务记录失败', 'error');
                }
                return;
            }
            if (event.target.closest('#data-analysis-semantic-copy-report')) {
                const text = String(state.semanticJob?.report || state.semanticJob?.result?.report || '').trim();
                if (!text) {
                    toast('暂无可复制的全量分析报告内容', 'info');
                    return;
                }
                try {
                    await navigator.clipboard.writeText(text);
                    toast('已成功复制全量分析报告至剪贴板', 'success');
                } catch (e) {
                    console.error('[data-analysis] 复制报告失败', e);
                    toast('复制失败，请手动选取内容复制', 'error');
                }
                return;
            }
        });

        // 单元格长文本自定义悬浮气泡查看（替代浏览器默认原生 title 提示）
        document.addEventListener('mouseover', event => {
            const cell = event.target.closest('td[data-cell-full]');
            if (cell && (cell.closest('.data-analysis-preview') || cell.closest('.data-analysis-query-table') || cell.closest('.data-analysis-pivot-table') || cell.closest('.data-analysis-history-table'))) {
                showCellTooltip(cell);
            }
        });

        document.addEventListener('mouseout', event => {
            const cell = event.target.closest('td[data-cell-full]');
            if (cell) {
                hideCellTooltip(cell);
            }
        });

        document.addEventListener('scroll', () => {
            hideCellTooltip();
        }, true);
    }

    Object.assign(app, {
        activateTab,
        clearTabData,
        bindEvents,
        openEditDatasetModal,
        closeEditDatasetModal,
        submitEditDataset
    });
})();
