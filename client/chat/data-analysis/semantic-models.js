(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber } = app;
    const byId = id => document.getElementById(id);
    const fetchJson = (...args) => app.fetchJson(...args);
    const toast = (...args) => app.toast(...args);
    const guardButton = (...args) => app.guardButton(...args);

    function governanceDataset() {
        const id = state.governanceDatasetId || state.activeId || '';
        return (state.datasets || []).find(item => item.id === id) || null;
    }

    function fieldOptions(dataset, includeEmpty = true) {
        const prefix = includeEmpty ? '<option value="">记录数（无需字段）</option>' : '';
        return prefix + (dataset?.columns || []).map(field => `<option value="${esc(field.key)}">${esc(field.name)}</option>`).join('');
    }

    function dataSetOptions(selected = '') {
        return `<option value="">请选择数据集</option>${(state.datasets || []).map(dataset => `<option value="${esc(dataset.id)}"${dataset.id === selected ? ' selected' : ''}>${esc(dataset.name)}</option>`).join('')}`;
    }

    function renderMetrics() {
        const field = byId('data-analysis-metric-field');
        const box = byId('data-analysis-metrics');
        const dataset = governanceDataset();
        if (field) PivotSafeHtml.setHtml(field, fieldOptions(dataset));
        if (!box) return;
        const metrics = state.metrics || [];
        const renderMetric = metric => `
            <div class="data-analysis-asset-row">
                <div class="data-analysis-asset-info">
                    <strong>${esc(metric.name)}</strong>
                    <span>${esc(metric.metricConfig?.aggregation || 'count')} · ${esc(metric.metricConfig?.fieldKey || '记录数')} · 单位: ${esc(metric.unit || '无')} · v${fmtNumber(metric.version)}</span>
                </div>
                <button class="btn-secondary btn-sm" type="button" data-analysis-metric-evaluate="${esc(metric.id)}" title="计算并查看当前指标值">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                    <span>计算</span>
                </button>
            </div>`;
        PivotSafeHtml.setHtml(box, metrics.length ? metrics.map(renderMetric).join('') : '<div class="data-analysis-empty">暂无指标口径。</div>');
    }

    function renderModelRelations() {
        const panel = byId('data-analysis-model-relation-panel');
        const title = byId('data-analysis-model-relation-title');
        const list = byId('data-analysis-model-relations');
        const model = state.activeDataModel;
        if (!panel || !list) return;
        panel.classList.toggle('hidden', !model);
        if (!model) return;
        if (title) title.textContent = `模型关联：${model.name}`;
        const leftDataset = byId('data-analysis-relation-left-dataset');
        const rightDataset = byId('data-analysis-relation-right-dataset');
        if (leftDataset) PivotSafeHtml.setHtml(leftDataset, dataSetOptions(leftDataset.value));
        if (rightDataset) PivotSafeHtml.setHtml(rightDataset, dataSetOptions(rightDataset.value));
        renderRelationFieldOptions();
        const relations = model.relations || [];
        const renderRelation = relation => `
            <div class="data-analysis-asset-row">
                <div class="data-analysis-asset-info">
                    <strong>${esc(relation.leftDatasetId)}.${esc(relation.leftFieldKey)} → ${esc(relation.rightDatasetId)}.${esc(relation.rightFieldKey)}</strong>
                    <span>${esc(relation.joinType === 'inner' ? '内关联' : '左关联')} · ${esc(relation.cardinality)} · 左侧 ${fmtNumber(relation.quality?.leftRows || 0)} 行 / 右侧 ${fmtNumber(relation.quality?.rightRows || 0)} 行</span>
                </div>
                <button class="btn-secondary btn-sm" type="button" data-analysis-model-run-relation="${esc(relation.id)}" title="预览关联数据样本">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    <span>预览</span>
                </button>
            </div>`;
        PivotSafeHtml.setHtml(list, relations.length ? relations.map(renderRelation).join('') : '<div class="data-analysis-empty">暂未配置关联。点击“添加关联”配置。</div>');
    }

    function renderModels() {
        const box = byId('data-analysis-models');
        if (!box) return;
        const models = state.dataModels || [];
        const renderModel = model => `<button class="btn-secondary data-analysis-model-row${model.id === state.activeDataModelId ? ' active' : ''}" type="button" data-analysis-model-select="${esc(model.id)}"><strong>${esc(model.name)}</strong><span>${esc(model.description || '暂无说明')} · v${fmtNumber(model.version)}</span></button>`;
        PivotSafeHtml.setHtml(box, models.length ? models.map(renderModel).join('') : '<div class="data-analysis-empty">暂无跨数据集模型。</div>');
        renderModelRelations();
    }

    function renderRelationFieldOptions() {
        const leftDataset = (state.datasets || []).find(item => item.id === byId('data-analysis-relation-left-dataset')?.value);
        const rightDataset = (state.datasets || []).find(item => item.id === byId('data-analysis-relation-right-dataset')?.value);
        const leftField = byId('data-analysis-relation-left-field');
        const rightField = byId('data-analysis-relation-right-field');
        if (leftField) PivotSafeHtml.setHtml(leftField, fieldOptions(leftDataset, false));
        if (rightField) PivotSafeHtml.setHtml(rightField, fieldOptions(rightDataset, false));
    }

    async function loadSemanticModels({ silent = false } = {}) {
        const dataset = governanceDataset();
        try {
            const [metrics, models] = await Promise.all([
                fetchJson(`${API}/metrics${dataset ? `?datasetId=${encodeURIComponent(dataset.id)}` : ''}`),
                fetchJson(`${API}/models`)
            ]);
            state.metrics = metrics.metrics || [];
            state.dataModels = models.models || [];
            const target = state.dataModels.some(item => item.id === state.activeDataModelId) ? state.activeDataModelId : state.dataModels[0]?.id || '';
            if (target) await loadDataModel(target, { silent: true });
            else { state.activeDataModelId = ''; state.activeDataModel = null; renderMetrics(); renderModels(); }
            renderMetrics();
        } catch (error) {
            if (!silent) toast(error?.message || '加载指标与数据模型失败', 'error');
        }
    }

    async function loadDataModel(modelId, { silent = false } = {}) {
        try {
            const data = await fetchJson(`${API}/models/${encodeURIComponent(modelId)}`);
            state.activeDataModelId = modelId;
            state.activeDataModel = data.model || null;
            renderModels();
        } catch (error) {
            if (!silent) toast(error?.message || '加载数据模型失败', 'error');
        }
    }

    async function saveMetric() {
        const dataset = governanceDataset();
        const name = String(byId('data-analysis-metric-name')?.value || '').trim();
        if (!dataset || !name) throw new Error('请选择数据集并填写指标名称。');
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/metrics`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, unit: String(byId('data-analysis-metric-unit')?.value || '').trim(), metricConfig: { fieldKey: String(byId('data-analysis-metric-field')?.value || ''), aggregation: String(byId('data-analysis-metric-aggregation')?.value || 'count') } })
        });
        state.metrics = [...(state.metrics || []), data.metric].filter(Boolean);
        if (byId('data-analysis-metric-name')) byId('data-analysis-metric-name').value = '';
        app.closeModal?.('data-analysis-metric-modal');
        renderMetrics();
        toast('指标口径已保存。', 'success');
    }

    async function evaluateMetric(metricId) {
        const data = await fetchJson(`${API}/metrics/${encodeURIComponent(metricId)}/evaluate`, { method: 'POST' });
        toast(`指标「${data.metric?.name || ''}」当前值：${fmtNumber(data.result?.value)}${data.metric?.unit || ''}`, 'success');
    }

    async function createDataModel() {
        const name = String(byId('data-analysis-model-name')?.value || '').trim();
        if (!name) throw new Error('请填写数据模型名称。');
        const data = await fetchJson(`${API}/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: String(byId('data-analysis-model-description')?.value || '').trim() }) });
        state.activeDataModelId = data.model?.id || '';
        ['data-analysis-model-name', 'data-analysis-model-description'].forEach(id => { if (byId(id)) byId(id).value = ''; });
        app.closeModal?.('data-analysis-model-modal');
        await loadSemanticModels({ silent: true });
        toast('数据模型已创建。', 'success');
    }

    async function saveModelRelation() {
        const model = state.activeDataModel;
        if (!model) throw new Error('请先创建或选择数据模型。');
        const data = await fetchJson(`${API}/models/${encodeURIComponent(model.id)}/relations`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                leftDatasetId: String(byId('data-analysis-relation-left-dataset')?.value || ''), leftFieldKey: String(byId('data-analysis-relation-left-field')?.value || ''),
                rightDatasetId: String(byId('data-analysis-relation-right-dataset')?.value || ''), rightFieldKey: String(byId('data-analysis-relation-right-field')?.value || ''),
                joinType: String(byId('data-analysis-relation-join-type')?.value || 'left'), cardinality: String(byId('data-analysis-relation-cardinality')?.value || 'many_to_one')
            })
        });
        app.closeModal?.('data-analysis-relation-modal');
        await loadDataModel(model.id, { silent: true });
        toast(`关联已保存，左侧 ${fmtNumber(data.relation?.quality?.leftRows || 0)} 行。`, 'success');
    }

    function renderModelQueryResult(result) {
        const box = byId('data-analysis-model-query-result');
        if (!box) return;
        const rows = result.rows || [];
        const columns = result.columns || [];
        PivotSafeHtml.setHtml(box, rows.length ? `<div class="table-container"><table class="data-table compact-table"><thead><tr>${columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${esc(row[column] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="data-analysis-empty">关联没有返回记录。</div>');
    }

    async function runModelRelation(relationId) {
        const model = state.activeDataModel;
        if (!model) return;
        const result = await fetchJson(`${API}/models/${encodeURIComponent(model.id)}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relationId, limit: 100 }) });
        renderModelQueryResult(result);
    }

    function bindSemanticModelEvents(root) {
        if (!root || root.dataset.semanticModelEventsBound === 'true') return;
        root.dataset.semanticModelEventsBound = 'true';
        root.addEventListener('change', event => {
            if (['data-analysis-relation-left-dataset', 'data-analysis-relation-right-dataset'].includes(event.target?.id)) renderRelationFieldOptions();
        });
        root.addEventListener('click', async event => {
            try {
                if (event.target.closest('#data-analysis-metric-save')) { await guardButton('data-analysis-metric-save', '保存中…', saveMetric); return; }
                const metric = event.target.closest('[data-analysis-metric-evaluate]');
                if (metric) { await evaluateMetric(metric.dataset.analysisMetricEvaluate); return; }
                if (event.target.closest('#data-analysis-model-create')) { await guardButton('data-analysis-model-create', '创建中…', createDataModel); return; }
                const select = event.target.closest('[data-analysis-model-select]');
                if (select) { await loadDataModel(select.dataset.analysisModelSelect); return; }
                if (event.target.closest('#data-analysis-model-relation-save')) { await guardButton('data-analysis-model-relation-save', '保存中…', saveModelRelation); return; }
                const preview = event.target.closest('[data-analysis-model-run-relation]');
                if (preview) { await runModelRelation(preview.dataset.analysisModelRunRelation); return; }
            } catch (error) {
                toast(error?.message || '指标或数据模型操作失败', 'error');
            }
        });
    }

    Object.assign(app, { loadSemanticModels, bindSemanticModelEvents, renderMetrics, renderModels });
})();
