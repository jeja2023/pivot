
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state } = app;
    const renderHeader = (...args) => app.renderHeader(...args);
    const renderOverview = (...args) => app.renderOverview(...args);
    const renderControls = (...args) => app.renderControls(...args);
    const renderChart = (...args) => app.renderChart(...args);
    const renderCompare = (...args) => app.renderCompare(...args);
    const renderQueryFields = (...args) => app.renderQueryFields(...args);
    const renderPivotControls = (...args) => app.renderPivotControls(...args);

    async function fetchJson(url, options = {}) {
        const res = await apiFetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data?.error?.message || data?.error || `请求失败：${res.status}`);
        }
        return data;
    }

    async function loadDatasets({ keepActive = true } = {}) {
        const data = await fetchJson(`${API}/datasets`);
        state.datasets = Array.isArray(data.datasets) ? data.datasets : [];
        if (!keepActive || !state.datasets.some(item => item.id === state.activeId)) {
            state.activeId = '';
        }
        if (!state.compareLeftId) state.compareLeftId = '';
        if (!state.compareRightId) state.compareRightId = '';
        render();
        if (state.activeId) await loadDatasetDetail(state.activeId);
    }

    async function loadDatasetDetail(id) {
        if (!id) {
            state.activeId = '';
            state.summary = null;
            state.chart = null;
            state.query = null;
            state.pivot = null;
            state.artifacts = [];
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
            return;
        }
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(id)}`);
        const index = state.datasets.findIndex(item => item.id === id);
        if (index >= 0) state.datasets[index] = data.dataset;
        state.activeId = id;
        state.summary = null;
        state.chart = null;
        state.query = null;
        state.pivot = null;
        state.artifacts = [];
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
    }

    async function loadSummary(id) {
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(id)}/summary`, { method: 'POST' });
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
            const data = await fetchJson(`${API}/datasets`, { method: 'POST', body: form });
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
        const original = btn ? btn.textContent : '';
        if (btn) {
            btn.disabled = true;
            if (busyText) btn.textContent = busyText;
        }
        try {
            await fn();
        } catch (e) {
            toast(e && e.message ? e.message : '操作失败', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                if (busyText) btn.textContent = original;
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
        renderPivotControls();
    }

    app.showDataAnalysisApp = async function (options = {}) {
        const view = app.ensureView();
        if (!view) return;
        const requestedDatasetId = String(options?.datasetId || '').trim();
        const requestedTab = String(options?.tab || options?.view || 'overview').trim() || 'overview';
        if (requestedDatasetId) state.activeId = requestedDatasetId;
        sessionStorage.setItem('pivot_apps_active_app', 'data-analysis');
        document.getElementById('apps-home-view')?.classList.add('hidden');
        document.getElementById('official-writing-view')?.classList.add('hidden');
        document.getElementById('regulations-view')?.classList.add('hidden');
        view.classList.remove('hidden');
        document.getElementById('apps-back-btn')?.classList.remove('hidden');
        if (typeof setAppsTitle === 'function') {
            setAppsTitle('数据分析', '上传表格数据，完成字段画像、数据比对、统计分析、图表生成和智能分析洞察。');
        }
        if (typeof app.activateTab === 'function') app.activateTab(requestedTab);
        await loadDatasets({ keepActive: true });
        if (typeof app.activateTab === 'function') app.activateTab(requestedTab);
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
