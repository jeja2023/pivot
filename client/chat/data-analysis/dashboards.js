(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber, activeDataset } = app;
    const byId = id => document.getElementById(id);
    const fetchJson = (...args) => app.fetchJson(...args);
    const toast = (...args) => app.toast(...args);
    const guardButton = (...args) => app.guardButton(...args);
    const viewTypeLabel = value => ({ chart: '图表', pivot: '透视', query: '查询' }[String(value || '')] || '未知类型');
    const scheduleFrequencyLabel = value => ({ interval: '按间隔', cron: '按计划表达式', manual: '手动' }[String(value || '')] || '未知频率');
    const scheduleStatusLabel = value => ({ succeeded: '成功', failed: '失败', never: '尚未运行' }[String(value || '')] || '等待执行');
    const aggregationLabel = value => ({ sum: '求和', count: '计数', avg: '平均', min: '最小', max: '最大' }[String(value || '')] || '计数');

    function activeDashboard() {
        return state.activeDashboard || null;
    }

    function selectedDataset() {
        return activeDataset() || state.datasets?.[0] || null;
    }

    function renderDashboardList() {
        const box = byId('data-analysis-dashboard-list');
        if (!box) return;
        const dashboards = state.dashboards || [];
        PivotSafeHtml.setHtml(box, dashboards.length ? dashboards.map(dashboard => `
            <button class="btn-secondary data-analysis-dashboard-list-item${dashboard.id === state.activeDashboardId ? ' active' : ''}" type="button" data-analysis-dashboard-select="${esc(dashboard.id)}">
                <div class="data-analysis-dashboard-list-item-header">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"></rect><rect x="14" y="3" width="7" height="5"></rect><rect x="14" y="12" width="7" height="9"></rect><rect x="3" y="16" width="7" height="5"></rect></svg>
                    <strong>${esc(dashboard.name)}</strong>
                    <span class="data-analysis-scope-badge ${dashboard.scope === app.SHARED_SCOPE ? 'is-shared' : ''}">${dashboard.scope === app.SHARED_SCOPE ? '已共享' : '私有'}</span>
                </div>
                <span>${esc(dashboard.description || '无用途说明')} · v${fmtNumber(dashboard.version)}</span>
            </button>
        `).join('') : '<div class="data-analysis-empty">暂无仪表盘。点击右上角“新建”创建。</div>');
    }

    function renderDashboardViews() {
        const select = byId('data-analysis-dashboard-view-select');
        if (!select) return;
        const options = ['<option value="">选择已保存视图</option>'];
        const renderOption = view => `<option value="${esc(view.id)}">${esc(view.name)} · ${esc(viewTypeLabel(view.viewType))}</option>`;
        (state.savedViews || []).forEach(view => options.push(renderOption(view)));
        PivotSafeHtml.setHtml(select, options.join(''));
    }

    function renderDashboardItems() {
        const box = byId('data-analysis-dashboard-items');
        const title = byId('data-analysis-dashboard-title');
        const meta = byId('data-analysis-dashboard-meta');
        const dashboard = activeDashboard();
        if (title) title.textContent = dashboard?.name || '请选择仪表盘';
        if (meta) meta.textContent = dashboard ? `${dashboard.description || '暂无说明'} · v${fmtNumber(dashboard.version)} · ${dashboard.scope === app.SHARED_SCOPE ? '已共享' : '仅自己可见'}` : '可以添加保存视图或当前分析配置，并设置周期刷新和阈值告警。';
        if (!box) return;
        if (!dashboard) { PivotSafeHtml.setHtml(box, '<div class="data-analysis-empty">请先从左侧选择或创建一个仪表盘。</div>'); return; }
        const items = dashboard.items || [];
        const typeLabels = { chart: '图表', pivot: '透视', query: '查询', metric: '指标', restricted: '权限受限' };
        PivotSafeHtml.setHtml(box, items.length ? items.map(item => `
            <div class="data-analysis-dashboard-item${item.accessDenied ? ' restricted' : ''}">
                <div class="data-analysis-asset-info">
                    <div class="data-analysis-asset-title-line">
                        <strong>${esc(item.title || '未命名项目')}</strong>
                        <span class="data-analysis-type-badge">${esc(typeLabels[item.itemType] || item.itemType)}</span>
                    </div>
                    <span>关联数据集: ${esc(item.datasetId)}</span>
                </div>
                ${item.accessDenied ? '<span class="data-analysis-warning-text">当前无查看该项目数据的权限</span>' : `<button class="btn-secondary btn-sm is-danger" type="button" data-analysis-dashboard-item-delete="${esc(item.id)}" title="从看板移除该项">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    <span>删除</span>
                </button>`}
            </div>
        `).join('') : '<div class="data-analysis-empty">尚未添加项目。请从上方选择已保存视图并点击“添加保存视图”。</div>');
    }

    function renderDashboardSnapshot() {
        const box = byId('data-analysis-dashboard-snapshot');
        if (!box) return;
        const snapshot = activeDashboard()?.lastSnapshot;
        if (!snapshot?.items?.length) { PivotSafeHtml.setHtml(box, ''); return; }
        PivotSafeHtml.setHtml(box, `<div class="data-analysis-dashboard-snapshot-head">最近刷新：${esc(snapshot.refreshedAt || '—')}</div>${snapshot.items.map(item => `<div class="data-analysis-dashboard-snapshot-row"><strong>${esc(item.title || item.itemId)}</strong><span class="${item.status === 'succeeded' ? 'is-success' : 'is-error'}">${item.status === 'succeeded' ? '已刷新' : esc(item.error || '刷新失败')}</span></div>`).join('')}`);
    }

    function renderSchedulesAndAlerts() {
        const scheduleBox = byId('data-analysis-refresh-schedules');
        const alertBox = byId('data-analysis-alerts');
        const renderSchedule = schedule => `
            <div class="data-analysis-asset-row">
                <div class="data-analysis-asset-info">
                    <strong>${esc(schedule.name)}</strong>
                    <span>${esc(scheduleFrequencyLabel(schedule.frequency))} · 下次执行: ${esc(schedule.nextRunAt || '手动')}</span>
                </div>
                <span class="data-analysis-status-tag ${schedule.lastStatus === 'succeeded' ? 'is-success' : (schedule.lastStatus === 'failed' ? 'is-danger' : '')}">
                    ${esc(scheduleStatusLabel(schedule.lastStatus))}
                </span>
            </div>`;
        const renderAlert = alert => `
            <div class="data-analysis-asset-row">
                <div class="data-analysis-asset-info">
                    <strong>${esc(alert.name)}</strong>
                    <span>${esc(aggregationLabel(alert.metricConfig?.aggregation))} ${esc(alert.operator)} ${esc(alert.threshold)}</span>
                </div>
                <span class="data-analysis-status-tag">
                    最近值: ${alert.lastValue === null ? '—' : esc(alert.lastValue)}
                </span>
            </div>`;
        if (scheduleBox) PivotSafeHtml.setHtml(scheduleBox, (state.refreshSchedules || []).length ? state.refreshSchedules.map(renderSchedule).join('') : '<div class="data-analysis-empty">暂无刷新计划。点击“添加计划”创建。</div>');
        if (alertBox) PivotSafeHtml.setHtml(alertBox, (state.alerts || []).length ? state.alerts.map(renderAlert).join('') : '<div class="data-analysis-empty">暂无阈值告警。点击“添加告警”创建。</div>');
    }

    function renderAlertFields() {
        const select = byId('data-analysis-alert-field');
        if (!select) return;
        const dataset = selectedDataset();
        const fields = dataset?.columns || [];
        PivotSafeHtml.setHtml(select, [`<option value="">记录数（无需字段）</option>`, ...fields.map(field => `<option value="${esc(field.key)}">${esc(field.name)}</option>`)].join(''));
    }

    function renderDashboards() {
        renderDashboardList();
        renderDashboardViews();
        renderDashboardItems();
        renderDashboardSnapshot();
        renderSchedulesAndAlerts();
        renderAlertFields();
    }

    async function loadDashboard(dashboardId, { silent = false } = {}) {
        const id = String(dashboardId || '').trim();
        if (!id) { state.activeDashboardId = ''; state.activeDashboard = null; renderDashboards(); return; }
        try {
            const [dashboardData, schedules, alerts] = await Promise.all([
                fetchJson(`${API}/dashboards/${encodeURIComponent(id)}`),
                fetchJson(`${API}/refresh-schedules?dashboardId=${encodeURIComponent(id)}`),
                fetchJson(`${API}/alerts`)
            ]);
            state.activeDashboardId = id;
            state.activeDashboard = dashboardData.dashboard || null;
            state.refreshSchedules = schedules.schedules || [];
            state.alerts = alerts.alerts || [];
            renderDashboards();
        } catch (error) {
            if (!silent) toast(error?.message || '加载仪表盘失败', 'error');
        }
    }

    async function loadDashboards({ keepActive = true, silent = false } = {}) {
        try {
            const [dashboardsData, viewsData] = await Promise.all([
                fetchJson(`${API}/dashboards`),
                fetchJson(`${API}/views?limit=200`)
            ]);
            state.dashboards = dashboardsData.dashboards || [];
            state.savedViews = viewsData.views || state.savedViews || [];
            const targetId = keepActive && state.dashboards.some(item => item.id === state.activeDashboardId)
                ? state.activeDashboardId
                : state.dashboards[0]?.id || '';
            if (targetId) await loadDashboard(targetId, { silent: true });
            else { state.activeDashboardId = ''; state.activeDashboard = null; renderDashboards(); }
        } catch (error) {
            if (!silent) toast(error?.message || '加载仪表盘列表失败', 'error');
        }
    }

    async function createDashboard() {
        const name = String(byId('data-analysis-dashboard-name')?.value || '').trim();
        if (!name) throw new Error('请填写仪表盘名称。');
        const scope = byId('data-analysis-dashboard-shared')?.checked ? app.SHARED_SCOPE : 'personal';
        const data = await fetchJson(`${API}/dashboards`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description: String(byId('data-analysis-dashboard-description')?.value || '').trim(), scope, allowedUnits: String(byId('data-analysis-dashboard-shared-units')?.value || '').trim() })
        });
        ['data-analysis-dashboard-name', 'data-analysis-dashboard-description', 'data-analysis-dashboard-shared-units'].forEach(id => { if (byId(id)) byId(id).value = ''; });
        if (byId('data-analysis-dashboard-shared')) byId('data-analysis-dashboard-shared').checked = false;
        state.activeDashboardId = data.dashboard?.id || '';
        app.closeModal?.('data-analysis-create-dashboard-modal');
        await loadDashboards({ keepActive: true, silent: true });
        toast('仪表盘已创建。', 'success');
    }

    async function addSavedViewToDashboard() {
        const dashboard = activeDashboard();
        const viewId = String(byId('data-analysis-dashboard-view-select')?.value || '').trim();
        const view = (state.savedViews || []).find(item => item.id === viewId);
        if (!dashboard || !view) throw new Error('请先选择仪表盘和已保存的分析视图。');
        await fetchJson(`${API}/dashboards/${encodeURIComponent(dashboard.id)}/items`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: view.name, itemType: view.viewType, datasetId: view.datasetId, savedViewId: view.id, config: view.config, position: { y: (dashboard.items || []).length * 4 } })
        });
        app.closeModal?.('data-analysis-add-view-modal');
        await loadDashboard(dashboard.id, { silent: true });
        toast('已添加保存视图到仪表盘。', 'success');
    }

    async function refreshActiveDashboard() {
        const dashboard = activeDashboard();
        if (!dashboard) throw new Error('请先选择仪表盘。');
        const data = await fetchJson(`${API}/dashboards/${encodeURIComponent(dashboard.id)}/refresh`, { method: 'POST' });
        await loadDashboard(dashboard.id, { silent: true });
        const failed = (data.snapshot?.items || []).filter(item => item.status !== 'succeeded').length;
        toast(failed ? `仪表盘已刷新，${failed} 个项目失败，请查看快照。` : '仪表盘已完成刷新。', failed ? 'warning' : 'success');
    }

    async function deleteDashboardItem(itemId) {
        const dashboard = activeDashboard();
        if (!dashboard) return;
        await fetchJson(`${API}/dashboards/${encodeURIComponent(dashboard.id)}/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
        await loadDashboard(dashboard.id, { silent: true });
        toast('仪表盘项目已删除。', 'success');
    }

    async function saveRefreshSchedule() {
        const dashboard = activeDashboard();
        if (!dashboard) throw new Error('请先选择仪表盘。');
        const data = await fetchJson(`${API}/refresh-schedules`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dashboardId: dashboard.id, name: String(byId('data-analysis-refresh-name')?.value || '').trim() || `${dashboard.name} 刷新`,
                frequency: String(byId('data-analysis-refresh-frequency')?.value || 'interval'),
                intervalMinutes: Number(byId('data-analysis-refresh-interval')?.value || 60), cronExpression: String(byId('data-analysis-refresh-cron')?.value || '').trim()
            })
        });
        state.refreshSchedules = [...(state.refreshSchedules || []).filter(item => item.id !== data.schedule?.id), data.schedule].filter(Boolean);
        ['data-analysis-refresh-name', 'data-analysis-refresh-cron'].forEach(id => { if (byId(id)) byId(id).value = ''; });
        app.closeModal?.('data-analysis-schedule-modal');
        renderSchedulesAndAlerts();
        toast('刷新计划已保存。', 'success');
    }

    async function saveAlert() {
        const dataset = selectedDataset();
        if (!dataset) throw new Error('请先选择数据集。');
        const threshold = Number(byId('data-analysis-alert-threshold')?.value);
        if (!Number.isFinite(threshold)) throw new Error('请输入有效的告警阈值。');
        const data = await fetchJson(`${API}/alerts`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dashboardId: activeDashboard()?.id || '', datasetId: dataset.id,
                name: String(byId('data-analysis-alert-name')?.value || '').trim() || `${dataset.name} 阈值告警`,
                metricConfig: { fieldKey: String(byId('data-analysis-alert-field')?.value || ''), aggregation: String(byId('data-analysis-alert-aggregation')?.value || 'count') },
                operator: String(byId('data-analysis-alert-operator')?.value || 'gt'), threshold
            })
        });
        state.alerts = [...(state.alerts || []).filter(item => item.id !== data.alert?.id), data.alert].filter(Boolean);
        ['data-analysis-alert-name', 'data-analysis-alert-threshold'].forEach(id => { if (byId(id)) byId(id).value = ''; });
        app.closeModal?.('data-analysis-alert-modal');
        renderSchedulesAndAlerts();
        toast('阈值告警已保存。', 'success');
    }

    function bindDashboardEvents(root) {
        if (!root || root.dataset.dashboardEventsBound === 'true') return;
        root.dataset.dashboardEventsBound = 'true';
        root.addEventListener('click', async event => {
            try {
                const select = event.target.closest('[data-analysis-dashboard-select]');
                if (select) { await loadDashboard(select.dataset.analysisDashboardSelect); return; }
                if (event.target.closest('#data-analysis-dashboard-create')) { await guardButton('data-analysis-dashboard-create', '创建中…', createDashboard); return; }
                if (event.target.closest('#data-analysis-dashboard-add-view')) { await guardButton('data-analysis-dashboard-add-view', '添加中…', addSavedViewToDashboard); return; }
                if (event.target.closest('#data-analysis-dashboard-refresh')) { await guardButton('data-analysis-dashboard-refresh', '刷新中…', refreshActiveDashboard); return; }
                const remove = event.target.closest('[data-analysis-dashboard-item-delete]');
                if (remove) { await deleteDashboardItem(remove.dataset.analysisDashboardItemDelete); return; }
                if (event.target.closest('#data-analysis-refresh-schedule-save')) { await guardButton('data-analysis-refresh-schedule-save', '保存中…', saveRefreshSchedule); return; }
                if (event.target.closest('#data-analysis-alert-save')) { await guardButton('data-analysis-alert-save', '保存中…', saveAlert); return; }
            } catch (error) {
                toast(error?.message || '仪表盘操作失败', 'error');
            }
        });
    }

    Object.assign(app, { loadDashboards, loadDashboard, renderDashboards, bindDashboardEvents });
})();
