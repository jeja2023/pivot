
(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state } = app;
    const renderHeader = (...args) => app.renderHeader(...args);
    const renderOverview = (...args) => app.renderOverview(...args);
    const renderControls = (...args) => app.renderControls(...args);
    const renderChart = (...args) => app.renderChart(...args);
    const renderCompare = (...args) => app.renderCompare(...args);
    const renderQueryFields = (...args) => app.renderQueryFields(...args);
    const renderPivotControls = (...args) => app.renderPivotControls(...args);
    const renderSemanticControls = (...args) => app.renderSemanticControls?.(...args);
    const resetAiWorkspace = (...args) => app.resetAiWorkspace?.(...args);
    const resumeAiWorkspace = (...args) => app.resumeAiWorkspace?.(...args);
    const normalizeTab = (...args) => app.normalizeTab(...args);
    const getStoredActiveTab = (...args) => app.getStoredActiveTab(...args);

    async function fetchJson(url, options = {}) {
        try {
            const res = await apiFetch(url, options);
            let data;
            try { data = res.status === 204 ? {} : await res.json(); }
            catch (_) { throw Object.assign(new Error('服务未返回有效数据，请刷新后重试。'), { status: res.status }); }
            if (!res.ok) {
                throw Object.assign(new Error(data?.error?.message || data?.error || `请求失败：${res.status}，请稍后重试。`), { status: res.status, code: data?.code || data?.error?.code || '',
                    applied: data?.applied === true, securityConfirmationPending: data?.securityConfirmationPending === true });
            }
            return data;
        } catch (error) {
            const message = String(error?.message || '');
            if (error?.name === 'AbortError') throw error;
            if (/network|failed to fetch|load failed|networkerror/i.test(message)) {
                throw new Error('网络连接中断，请检查网络后重试。');
            }
            throw error;
        }
    }

    async function loadDatasets({ keepActive = true, loadActiveDetail = true } = {}) {
        const current = app.captureRequest('datasets', () => 'datasets');
        const data = await fetchJson(`${API}/datasets`);
        if (!current()) return;
        state.datasets = Array.isArray(data.datasets) ? data.datasets : [];
        if (!keepActive || !state.datasets.some(item => item.id === state.activeId)) {
            state.activeId = '';
            state.datasetEpoch += 1;
            state.summary = null; state.query = null; state.chart = null; state.pivot = null; state.artifacts = [];
            app.stopAsyncQueryPolling?.();
        }
        if (!state.compareLeftId) state.compareLeftId = '';
        if (!state.compareRightId) state.compareRightId = '';
        render();
        if (state.activeId && loadActiveDetail) await loadDatasetDetail(state.activeId);
    }

    async function loadDatasetDetail(id) {
        if (String(id || '') !== String(state.activeId || '')) resetAiWorkspace();
        state.datasetEpoch += 1;
        state.activeId = id || '';
        state.summary = null; state.chart = null; state.query = null; state.queryPage = 1; state.pivot = null; state.artifacts = [];
        app.stopAsyncQueryPolling?.();
        state.asyncQueryJobs = [];
        const current = app.captureRequest('detail');
        render();
        if (!id) {
            state.activeId = '';
            state.summary = null;
            state.chart = null;
            state.query = null;
            state.queryPage = 1;
            state.pivot = null;
            state.artifacts = [];
            state.cleaningQuality = null;
            state.cleaningRules = [];
            state.cleaningPreview = null;
            state.cleaningRuns = [];
            state.cleaningDatasetId = '';
            state.cleaningRunName = '';
            state.semanticJobs = [];
            state.semanticJob = null;
            state.visualQuery = {
                logicalOperator: 'AND',
                filters: [
                    { field: '', operator: 'eq', value: '' }
                ],
                sortField: '',
                sortOrder: 'ASC',
                limit: 100
            };
            render();
            return true;
        }
        let data;
        try { data = await fetchJson(`${API}/datasets/${encodeURIComponent(id)}`); }
        catch (error) { if (!current()) return false; throw error; }
        if (!current()) return false;
        if (data.dataset?.id !== id) throw new Error('数据集详情不可用，请刷新列表后重试。');
        const index = state.datasets.findIndex(item => item.id === id);
        if (index >= 0) state.datasets[index] = data.dataset;
        state.activeId = id;
        state.summary = null;
        state.chart = null;
        state.query = null;
        state.queryPage = 1;
        state.pivot = null;
        state.artifacts = [];
        state.cleaningQuality = null;
        state.cleaningRules = [];
        state.cleaningPreview = null;
        state.cleaningRuns = [];
        state.cleaningDatasetId = id;
        state.cleaningRunName = '';
        state.semanticDatasetId = id;
        state.visualQuery = {
            logicalOperator: 'AND',
            filters: [
                { field: '', operator: 'eq', value: '' }
            ],
            sortField: '',
            sortOrder: 'ASC',
            limit: 100
        };
        render();
        await loadSummary(id);
        if (!current()) return false;
        if (typeof app.loadSemanticJobs === 'function' && state.semanticDatasetId) {
            await app.loadSemanticJobs(state.semanticDatasetId);
        }
        return true;
    }

    async function loadSummary(id) {
        const current = app.captureRequest('summary');
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(id)}/summary`, { method: 'POST' });
        if (!current() || id !== state.activeId) return;
        state.summary = data;
        render();
    }

    async function uploadDataset(file) {
        if (!file) return;
        const form = new FormData();
        form.append('file', file);
        form.append('name', file.name.replace(/\.[^.]+$/, ''));
        setBusy(true, '正在导入数据集...');
        try {
            const data = await fetchJson(`${API}/datasets`, { method: 'POST', body: form, timeoutMs: 300000 });
            resetAiWorkspace();
            state.activeId = data.dataset?.id || '';
            toast('数据集已导入');
            await loadDatasets({ keepActive: true });
        } catch (e) {
            toast(e && e.message ? e.message : '数据集导入失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function setBusy(busy, text = '') {
        const panel = document.querySelector('.data-analysis-panel');
        panel?.classList.toggle('is-busy', !!busy);
        if (text && typeof showToast === 'function') showToast(text);
    }

    function toast(message, type) {
        if (typeof showToast === 'function') showToast(message, type);
    }

    // 统一的按钮级保护：进行中禁用按钮并显示忙碌文案，捕获异常弹 toast，结束后复位，
    // 避免重复点击触发并发请求、以及失败时无任何反馈。
    async function guardButton(buttonId, busyText, fn) {
        const btn = buttonId ? document.getElementById(buttonId) : null;
        if (btn && btn.disabled) return;
        const textSpan = btn ? btn.querySelector('span') : null;
        const original = textSpan ? textSpan.textContent : (btn ? btn.textContent : '');
        if (btn) {
            btn.disabled = true;
            if (busyText) {
                if (textSpan) textSpan.textContent = busyText;
                else btn.textContent = busyText;
            }
        }
        try {
            return await fn();
        } catch (e) {
            toast(e && e.message ? e.message : '操作失败', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                if (busyText) {
                    if (textSpan) textSpan.textContent = original;
                    else btn.textContent = original;
                }
            }
        }
    }

    function render() {
        renderHeader();
        renderOverview();
        renderControls();
        renderChart();
        renderCompare();
        renderQueryFields();
        app.renderQuery?.();
        renderPivotControls();
        app.renderPivot?.();
        renderSemanticControls();
        app.renderAsyncQueryJobs?.();
        app.renderGovernance?.();
        app.renderDashboards?.();
    }

    app.showDataAnalysisApp = async function (options = {}) {
        await window.Pivot.moduleApi?.('apps.availability')?.ensureEnabled('data-analysis');
        const view = app.ensureView();
        if (!view) return;
        const requestedDatasetId = String(options?.datasetId || '').trim();
        const explicitTab = String(options?.tab || options?.view || '').trim();
        if (!explicitTab && state.modelingHostApp === 'data-modeling') {
            app.persistActiveTab?.(state.lastAnalysisTab || 'overview');
        }
        state.modelingHostApp = 'data-analysis';
        let requestedTab = normalizeTab(explicitTab || getStoredActiveTab());
        const availability = window.Pivot.moduleApi?.('apps.availability');
        if (requestedTab === 'modeling' && availability?.isEnabled && !availability.isEnabled('data-modeling')) requestedTab = 'overview';
        availability?.syncRelatedEntrances?.();
        resetAiWorkspace();
        if (requestedTab === 'governance') await app.loadGovernance?.('');
        if (requestedTab === 'assets') await app.loadAssets?.('');
        if (requestedDatasetId) state.activeId = requestedDatasetId;
        window.Pivot.legacy.setAppsSessionValue?.('pivot_apps_active_app', 'data-analysis');
        document.getElementById('apps-home-view')?.classList.add('hidden');
        document.getElementById('official-writing-view')?.classList.add('hidden');
        document.getElementById('regulations-view')?.classList.add('hidden');
        document.getElementById('ocr-view')?.classList.add('hidden');
        document.getElementById('pdf-tools-view')?.classList.add('hidden');
        document.getElementById('presentations-view')?.classList.add('hidden');
        document.getElementById('mindmaps-view')?.classList.add('hidden');
        view.classList.remove('hidden');
        document.getElementById('apps-back-btn')?.classList.remove('hidden');
        if (typeof setAppsTitle === 'function') {
            setAppsTitle('数据分析', '上传表格数据，完成字段画像、数据比对、统计分析、图表生成和智能分析洞察。');
        }
        await window.Pivot.legacy.PivotAppModels?.refresh?.('data-analysis', 'data-analysis-ai-model');
        if (typeof app.activateTab === 'function') app.activateTab(requestedTab);
        await loadDatasets({ keepActive: true, loadActiveDetail: !['governance', 'assets', 'modeling'].includes(requestedTab) || Boolean(requestedDatasetId) });
        if (requestedTab === 'governance') {
            if (state.governanceDatasetId) await app.loadGovernance?.(state.governanceDatasetId, { silent: true });
            else app.renderGovernance?.();
            await app.loadSemanticModels?.({ silent: true });
        }
        if (requestedTab === 'assets') {
            if (state.assetsDatasetId) await app.loadAssets?.(state.assetsDatasetId, { silent: true });
            else app.renderGovernance?.();
        }
        if (requestedTab === 'dashboards') await app.loadDashboards?.({ keepActive: true, silent: true });
        if (requestedTab === 'query') await app.loadAsyncQueryJobs?.({ silent: true });
        const selectedTab = app.getStoredActiveTab?.() || requestedTab;
        if (typeof app.activateTab === 'function') app.activateTab(selectedTab);
        if (selectedTab === 'cleaning') {
            await app.loadCleaningWorkspace?.(state.cleaningDatasetId || state.activeId, { resetPreview: true });
        }
        resumeAiWorkspace();
    };

    app.showDataModelingApp = async function (options = {}) {
        await window.Pivot.moduleApi?.('apps.availability')?.ensureEnabled('data-modeling');
        const view = app.ensureView();
        if (!view) return;
        window.Pivot.moduleApi?.('apps.availability')?.syncRelatedEntrances?.();
        state.modelingHostApp = 'data-modeling';
        resetAiWorkspace();
        window.Pivot.legacy.setAppsSessionValue?.('pivot_apps_active_app', 'data-modeling');
        document.getElementById('apps-home-view')?.classList.add('hidden');
        document.getElementById('official-writing-view')?.classList.add('hidden');
        document.getElementById('regulations-view')?.classList.add('hidden');
        document.getElementById('ocr-view')?.classList.add('hidden');
        document.getElementById('pdf-tools-view')?.classList.add('hidden');
        document.getElementById('presentations-view')?.classList.add('hidden');
        document.getElementById('mindmaps-view')?.classList.add('hidden');
        view.classList.remove('hidden');
        document.getElementById('apps-back-btn')?.classList.remove('hidden');
        if (typeof setAppsTitle === 'function') {
            setAppsTitle('数据建模', '通过可视化画布拖拽关联多表，统一定义事实粒度、分析维度与业务指标口径。');
        }
        if (typeof app.activateTab === 'function') app.activateTab('modeling');
        await loadDatasets({ keepActive: true, loadActiveDetail: false });
        if (options?.modelId && typeof app.modeling?.loadModel === 'function') {
            await app.modeling.loadModel(String(options.modelId));
        }
    };

    Object.assign(app, {
        fetchJson,
        loadDatasets,
        loadDatasetDetail,
        loadSummary,
        uploadDataset,
        setBusy,
        toast,
        guardButton,
        render
    });
})();
