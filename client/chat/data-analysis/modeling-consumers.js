(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis, m = app.modeling;
    const { state, request, json, table } = m, { esc } = app;
    const byId = id => document.getElementById(id);
    const visible = () => !document.hidden && !byId('data-analysis-modeling-panel')?.classList.contains('hidden');
    let timer = null, resume = null;
    const stop = () => { clearTimeout(timer); timer = null; };
    const reset = m.reset;
    m.reset = () => { stop(); resume = null; reset(); };
    document.addEventListener('visibilitychange', () => { stop(); if (visible()) resume?.(); });
    const onTab = app.onDataAnalysisTabActivated;
    app.onDataAnalysisTabActivated = tab => { onTab?.(tab); stop(); if (tab === 'modeling') resume?.(); };
    const definition = () => state.run?.executionKind === 'model_trial' ? state.draft : state.analysisDefinition;
    const completed = () => { if (!state.run?.result || state.run.status !== 'succeeded') throw new Error('请先完成一次模型分析。'); return state.run; };
    const formal = () => { const run = completed(); if (run.executionKind !== 'model_query') throw new Error('草稿试算不能保存为正式资产或导出，请先发布并运行正式分析。'); return run; };
    const target = () => byId('modeling-consumer-result');

    async function querySourceChanged(event) {
        const current = m.capture('query-source');
        if (event.target.id === 'modeling-query-mode') state.queryMode = event.target.value;
        else state.analysisVersion = Number(event.target.value);
        if (state.queryMode === 'published') {
            const data = await request(`/models/${encodeURIComponent(state.selected.id)}/versions`);
            if (!current()) return;
            const version = data.versions.find(item => item.version === state.analysisVersion);
            if (!version?.definition) throw new Error('该发布版本的来源不可用，请选择其他版本或联系维护者。');
            state.analysisDefinition = version.definition;
        }
        state.run = null; state.resultPage = null; m.render();
    }

    function chartSpec(result, modelDefinition, metricId, chartType = 'bar') {
        const metric = modelDefinition.metrics.find(item => item.id === metricId);
        const rows = result.rows.slice(0, 80);
        return { type: 'pivot_chart', version: 1, numericContract: 'decimal_string', chartType, title: metric?.name || metricId,
            labels: rows.map(row => result.columns.dimensions.length ? result.columns.dimensions.map(id => row.members[id]?.unmatched ? '未匹配' : row.members[id]?.label ?? '空值').join(' / ') : '总体'),
            series: [{ name: `${metric?.name || metricId}${metric?.currency || metric?.unit ? `（${metric.currency || metric.unit}）` : ''}`, data: rows.map(row => row.values[metricId]?.value ?? null) }],
            xAxis: { label: result.columns.dimensions.map(id => modelDefinition.dimensions.find(item => item.id === id)?.name || id).join(' / ') || '总体' }, yAxis: { label: metric?.name || metricId },
            source: { runId: result.runId, manifestId: result.manifestId, publishedVersion: result.publishedVersion, queryHash: result.queryHash } };
    }

    function renderChartResult(run, metricId, chartType = 'bar') {
        const negative = run.result.rows.some(row => {
            return Number(row.values[metricId]?.value || 0) < 0;
        });
        if (chartType === 'pie' && negative) throw new Error('当前指标包含负数，请选择柱形图或折线图。');
        const spec = chartSpec(run.result, definition(), metricId, chartType);
        window.Pivot.legacy.teardownPivotCharts?.(target());
        m.html(target(), `<p>图表使用运行 ${esc(run.id)} 的精确数值，最多展示八十个分组；悬浮提示保留原始十进制字符串。总计见上方表格。</p><div class="pivot-echart-block" data-pivot-echart="${esc(JSON.stringify(spec))}"><div class="pivot-echart-title">${esc(spec.title)}</div><div class="pivot-echart-canvas"></div><canvas height="300"></canvas><pre class="pivot-echart-error-text"></pre></div>`);
        window.Pivot.legacy.renderPivotCharts?.(target());
    }

    function chart() {
        const run = completed();
        m.dialog('选择模型图表', `${m.select('metricId', '指标', run.result.columns.metrics.map(id => [id, definition().metrics.find(item => item.id === id)?.name || id]), run.result.columns.metrics[0])}${m.select('chartType', '图表类型', [['bar', '柱形图'], ['line', '折线图'], ['pie', '饼图']], 'bar')}`, form => { renderChartResult(run, m.value(form, 'metricId'), m.value(form, 'chartType')); });
    }

    function watch(ids, current, complete) {
        stop();
        const poll = async () => {
            if (!current()) { stop(); resume = null; return; }
            if (!visible()) return;
            try {
                const records = await Promise.all([...new Set(ids)].map(id => request(`/async-queries/${encodeURIComponent(id)}`)));
                if (!current()) return;
                const jobs = records.map(record => record.job || record);
                const failed = jobs.find(job => ['failed', 'cancelled'].includes(job.status));
                if (failed) throw new Error(failed.lastError || '任务失败，请检查来源后重试。');
                if (jobs.every(job => job.status === 'succeeded')) { resume = null; await complete(new Map(jobs.map(job => [job.id, job]))); return; }
                if (target()) target().textContent = '后台任务正在排队或执行，可切换页面；返回后继续查看。';
                timer = setTimeout(poll, 1500);
            } catch (error) { if (current()) { if (target()) target().textContent = error.message; app.toast(error.message, 'error'); } resume = null; }
        };
        resume = () => { void poll(); }; void poll();
    }

    const memberId = member => JSON.stringify({ key: member?.key, unmatched: member?.unmatched });
    const memberLabel = member => member?.unmatched ? '未匹配' : member?.label ?? '空值';
    const metricValue = value => value?.value ?? ({ zero_denominator: '分母为零', mixed_currency: '不同币种不可合计' })[value?.nullReason] ?? '无有效值';

    function renderPivotResult(pivot, jobs) {
        const cells = jobs.get(pivot.cell.id).result, rowsResult = jobs.get(pivot.rowTotals.id).result, columnsResult = pivot.columnTotals && jobs.get(pivot.columnTotals.id).result;
        const [rowId, columnId] = cells.columns.dimensions;
        const rowMembers = [...new Map(cells.rows.map(row => [memberId(row.members[rowId]), row.members[rowId]])).entries()].slice(0, 200);
        const columnMembers = columnId ? [...new Map(cells.rows.map(row => [memberId(row.members[columnId]), row.members[columnId]])).entries()].slice(0, 50) : [];
        const byCell = new Map(cells.rows.map(row => [`${memberId(row.members[rowId])}:${columnId ? memberId(row.members[columnId]) : ''}`, row]));
        const rowTotals = new Map(rowsResult.rows.map(row => [memberId(row.members[rowId]), row]));
        const columnTotals = new Map((columnsResult?.rows || []).map(row => [memberId(row.members[columnId]), row]));
        const tables = cells.columns.metrics.map(metricId => {
            const name = definition().metrics.find(metric => metric.id === metricId)?.name || metricId;
            const headers = [definition().dimensions.find(item => item.id === rowId)?.name || rowId, ...columnMembers.map(([, member]) => memberLabel(member)), '行总计'];
            const rows = rowMembers.map(([rowKey, member]) => `<tr><td>${esc(memberLabel(member))}</td>${columnMembers.map(([columnKey]) => `<td>${esc(byCell.has(`${rowKey}:${columnKey}`) ? metricValue(byCell.get(`${rowKey}:${columnKey}`).values[metricId]) : cells.truncated ? '未展示' : '无记录')}</td>`).join('')}<td>${esc(metricValue(rowTotals.get(rowKey)?.values[metricId]))}</td></tr>`);
            rows.push(`<tr><th>完整范围总计</th>${columnMembers.map(([key]) => `<td>${esc(metricValue(columnTotals.get(key)?.values[metricId]))}</td>`).join('')}<td>${esc(metricValue(cells.total.values[metricId]))}</td></tr>`);
            return `<h5>${esc(name)}</h5>${table(headers, rows)}`;
        });
        m.html(target(), `<p>固定发布版本 v${esc(pivot.publishedVersion)} · 来源清单 ${esc(pivot.manifestId)}。行列小计与总计分别在完整过滤范围计算，不叠加去重数、均值或比率。</p><p>最多展示二百行、五十列；${cells.truncated || rowMembers.length < rowsResult.rows.length ? '存在未展示分组，总计包含这些分组。' : '已展示当前结果范围。'}</p>${tables.join('')}`);
    }

    async function pivot() {
        const run = formal(), current = m.capture('pivot');
        const result = await request(`/async-queries/${encodeURIComponent(run.id)}/pivot`, json({ requestKey: m.key() }));
        if (!current()) return;
        watch([result.cell.id, result.rowTotals.id, ...(result.columnTotals ? [result.columnTotals.id] : [])], current, jobs => renderPivotResult(result, jobs));
    }

    async function exportResult(format) {
        const run = formal(), current = m.capture('export');
        const { job } = await request(`/async-queries/${encodeURIComponent(run.id)}/exports`, json({ format, requestKey: m.key() }));
        if (!current()) return;
        watch([job.id], current, async () => {
            const ticket = await request(`/async-queries/${encodeURIComponent(job.id)}/download-token`, json({}));
            if (!current()) return;
            const response = await apiFetch(`${app.API}/async-queries/${encodeURIComponent(job.id)}/export-content`, { headers: { 'X-Analysis-Download-Token': ticket.token } });
            if (!response.ok) throw new Error('下载权限已变化或文件不可用，请重新导出。');
            const blob = await response.blob();
            if (!current()) return;
            const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = ticket.fileName; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            if (target()) target().textContent = '完整导出已下载，文件包含口径、来源截止、单位和总计范围。';
        });
    }

    async function page(first) {
        const run = completed(), current = m.capture('result-page');
        let cursor = first ? '' : state.resultPage?.nextCursor;
        if (!first && !state.resultPage) {
            const initial = await request(`/async-queries/${encodeURIComponent(run.id)}/results?limit=100`);
            if (!current()) return;
            cursor = initial.nextCursor;
        }
        if (!first && !cursor) return;
        const result = await request(`/async-queries/${encodeURIComponent(run.id)}/results?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!current()) return;
        state.resultPage = result; m.renderRun();
    }

    async function saveView() {
        const run = formal(), current = m.capture('save-model-view');
        const [views, dashboards] = await Promise.all([request('/views'), request('/dashboards')]);
        if (!current()) return;
        const migrationViews = state.selected.migrationOrigin?.views || [];
        const existing = views.views.filter(view => view.isOwner && (view.sourceType === 'model' && view.modelId === run.modelId || migrationViews.some(item => item.id === view.id)));
        m.dialog('保存模型分析视图', `${m.input('viewName', '视图名称', state.selected.name, 'maxlength="120" required')}${m.input('description', '用途说明', '', 'maxlength="1000"')}${m.select('viewType', '视图类型', [['query', '表格'], ['chart', '图表'], ['pivot', '透视']], 'query')}${m.select('viewId', '新建或更新', [['', '创建新视图'], ...existing.map(view => [view.id, `${view.name}（${view.sourceType === 'model' ? `v${view.publishedVersion}` : '旧数据集视图'}）`])], '')}${m.checkbox('confirmUpgrade', '更新到不同模型版本时，已查看差异并明确确认升级')}${migrationViews.length ? m.checkbox('confirmMigration', '将所选旧视图切换至本次正式模型运行，并收窄为个人视图；其他视图和仪表盘不自动切换') : ''}${m.select('binding', '数据绑定', [['latest_checked', '该版本最新通过检查的数据'], ['historical', '固定本次历史清单']], 'latest_checked')}${m.select('dashboardId', '同时添加到我的仪表盘（可选）', [['', '暂不添加'], ...dashboards.dashboards.filter(item => item.isOwner).map(item => [item.id, item.name])], '')}<p>固定模型发布版本 v${esc(run.publishedVersion)}；默认个人视图。之后发布新模型不会自动升级此视图。</p>`, async form => {
            const viewId = m.value(form, 'viewId'), previous = existing.find(view => view.id === viewId);
            const body = { sourceRunId: run.id, name: m.value(form, 'viewName'), description: m.value(form, 'description'), viewType: m.value(form, 'viewType'), binding: { strategy: m.value(form, 'binding') }, confirmUpgrade: m.checked(form, 'confirmUpgrade'), confirmMigration: m.checked(form, 'confirmMigration'), ...(previous ? { expectedVersion: previous.version } : {}) };
            const result = await request(`/models/${encodeURIComponent(run.modelId)}/views${viewId ? `/${encodeURIComponent(viewId)}` : ''}`, json(body, viewId ? 'PUT' : 'POST'));
            if (!current()) return;
            const dashboardId = m.value(form, 'dashboardId');
            if (dashboardId) await request(`/dashboards/${encodeURIComponent(dashboardId)}/items`, json({ sourceType: 'model', savedViewId: result.view.id, title: result.view.name }));
            if (current()) app.toast('分析视图已保存，固定版本与数据绑定策略已记录。', 'success');
        });
    }

    async function openSavedModelRun(data) {
        const userId = m.owner();
        if (!await m.canLeave()) return;
        if (m.owner() !== userId) return;
        app.activateTab('modeling'); await m.loadModel(data.view.modelId, { force: true });
        if (m.owner() !== userId || state.selected?.id !== data.view.modelId) return;
        const current = m.capture('saved-model-run');
        const versions = await request(`/models/${encodeURIComponent(data.view.modelId)}/versions`);
        if (!current()) return;
        const selected = versions.versions.find(item => item.version === data.view.publishedVersion);
        if (!selected?.definition) throw new Error('固定模型版本不可用，请联系维护者。');
        state.analysisVersion = selected.version; state.analysisDefinition = selected.definition; state.queryMode = 'published'; state.drawerMode = 'trial'; state.drawerOpen = true; state.run = data.job; state.resultPage = null; m.render();
        await m.pollRun(data.job.id);
    }

    function semanticResultTable(result) {
        const dimensions = result.columns?.dimensions || [], metrics = result.columns?.metrics || [];
        const label = id => result.columnLabels?.dimensions[id] || result.columnLabels?.metrics[id] || id;
        const rows = result.rows.slice(0, 100).map(row => `<tr>${dimensions.map(id => `<td>${esc(memberLabel(row.members[id]))}</td>`).join('')}${metrics.map(id => `<td>${esc(metricValue(row.values[id]))}</td>`).join('')}</tr>`);
        if (dimensions.length) rows.push(`<tr>${dimensions.map((_id, index) => `<th>${index === 0 ? '完整范围总计' : ''}</th>`).join('')}${metrics.map(id => `<td>${esc(metricValue(result.total.values[id]))}</td>`).join('')}</tr>`);
        return `<p>运行 ${esc(result.runId)} · 模型 v${esc(result.publishedVersion)} · 清单 ${esc(result.manifestId)}</p><p>截止：${esc((result.dataTimes || []).map(item => item.updatedAt).join('；'))}；${result.truncated ? '总计包含未展示分组' : '总计覆盖完整过滤范围'}。</p>${m.cacheNotice(result)}${table([...dimensions.map(label), ...metrics.map(label)], rows)}`;
    }

    const previous = m.consumerAction;
    m.consumerAction = (action, id) => {
        if (action === 'chart-result') return chart();
        if (action === 'pivot-result') return pivot();
        if (action === 'save-view') return saveView();
        if (action === 'export-csv' || action === 'export-xlsx') return exportResult(action.slice(7));
        if (action === 'result-first-page' || action === 'result-next-page') return page(action === 'result-first-page');
        return previous?.(action, id);
    };
    Object.assign(m, { querySourceChanged, chartSpec, openSavedModelRun, semanticResultTable });
    document.addEventListener('click', event => {
        const run = event.target.closest('[data-analysis-model-item-run]'), view = event.target.closest('[data-analysis-model-item-result]'), history = event.target.closest('[data-analysis-model-item-history]');
        if (!run && !view && !history) return;
        event.preventDefault();
        const currentUser = m.owner();
        void (async () => {
            const dashboard = app.state.activeDashboard;
            if (!dashboard) return;
            let job;
            if (run) {
                const response = await request(`/dashboards/${encodeURIComponent(dashboard.id)}/items/${encodeURIComponent(run.dataset.analysisModelItemRun)}/model-run`, json({}));
                job = response.job;
                if (m.owner() !== currentUser) return;
                app.toast('已按当前身份创建模型分析任务。', 'success');
                await app.loadDashboard(dashboard.id, { silent: true });
                return;
            }
            const snapshot = view && dashboard.lastSnapshot?.items?.find(item => item.itemId === view.dataset.analysisModelItemResult);
            const jobId = history ? history.dataset.analysisModelItemHistory : snapshot?.runId;
            if (!jobId) throw new Error('当前组件尚无可用结果，请先运行。');
            const response = await request(`/async-queries/${encodeURIComponent(jobId)}`); job = response.job || response;
            if (m.owner() !== currentUser) return;
            if (job.resultExpired) throw new Error('该运行结果已过期，请在仪表盘中重新计算。');
            if (job.status !== 'succeeded' || !job.result) throw new Error(job.lastError || '任务仍在执行，请稍后刷新仪表盘。');
            m.mount();
            m.dialog(history ? '上次成功结果（历史）' : '模型仪表盘精确结果', semanticResultTable(job.result), null);
        })().catch(error => { if (m.owner() === currentUser) app.toast(error.message, 'error'); });
    });
})();
