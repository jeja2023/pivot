(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber } = app;
    const byId = id => document.getElementById(id);
    const fetchJson = (...args) => app.fetchJson(...args);
    const toast = (...args) => app.toast(...args);
    const guardButton = (...args) => app.guardButton(...args);
    let listSequence = 0;
    let modelSequence = 0;
    const cardinalityLabels = { one_to_one: '一对一', one_to_many: '一对多', many_to_one: '多对一', many_to_many: '多对多' };

    function governanceDataset() {
        const id = state.governanceDatasetId || '';
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
        for (const id of ['data-analysis-open-relation', 'data-analysis-model-edit', 'data-analysis-model-delete']) {
            byId(id)?.classList.toggle('hidden', !model.isOwner);
        }
        if (title) title.textContent = `模型关联：${model.name}`;
        const leftDataset = byId('data-analysis-relation-left-dataset');
        const rightDataset = byId('data-analysis-relation-right-dataset');
        if (leftDataset) PivotSafeHtml.setHtml(leftDataset, dataSetOptions(leftDataset.value));
        if (rightDataset) PivotSafeHtml.setHtml(rightDataset, dataSetOptions(rightDataset.value));
        renderRelationFieldOptions();
        const relations = model.relations || [];
        const datasetIds = new Set(relations.filter(relation => relation.status === 'active').flatMap(relation => [relation.leftDatasetId, relation.rightDatasetId]));
        const datasets = (state.datasets || []).filter(dataset => datasetIds.has(dataset.id));
        const options = '<option value="">请选择字段</option>' + datasets.flatMap(dataset => (dataset.columns || []).map(column => `<option value="${esc(JSON.stringify({ datasetId: dataset.id, fieldKey: column.key }))}">${esc(dataset.name)} · ${esc(column.name)}</option>`)).join('');
        for (const id of ['data-analysis-model-dimension', 'data-analysis-model-measure']) {
            const select = byId(id);
            if (select) {
                const previous = select.value;
                PivotSafeHtml.setHtml(select, options);
                select.value = previous;
                if (select.selectedIndex < 0) select.selectedIndex = 0;
            }
        }
        const renderRelation = relation => `
            <div class="data-analysis-asset-row">
                <div class="data-analysis-asset-info">
                    <strong>${esc((state.datasets || []).find(item => item.id === relation.leftDatasetId)?.name || relation.leftDatasetId)}.${esc((state.datasets || []).find(item => item.id === relation.leftDatasetId)?.columns?.find(field => field.key === relation.leftFieldKey)?.name || relation.leftFieldKey)} → ${esc((state.datasets || []).find(item => item.id === relation.rightDatasetId)?.name || relation.rightDatasetId)}.${esc((state.datasets || []).find(item => item.id === relation.rightDatasetId)?.columns?.find(field => field.key === relation.rightFieldKey)?.name || relation.rightFieldKey)}</strong>
                    <span>${esc(relation.joinType === 'inner' ? '内关联' : '左关联')} · ${esc(cardinalityLabels[relation.cardinality] || relation.cardinality)} · 左侧 ${fmtNumber(relation.quality?.leftRows || 0)} 行 / 右侧 ${fmtNumber(relation.quality?.rightRows || 0)} 行</span>
                    ${(relation.quality?.warnings || []).map(warning => `<span>${esc(warning)}</span>`).join('')}
                </div>
                <div class="data-analysis-inline-actions">
                <button class="btn-secondary btn-sm" type="button" data-analysis-model-run-relation="${esc(relation.id)}" title="预览关联数据样本">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    <span>预览</span>
                </button>
                ${model.isOwner ? `<button class="btn-secondary btn-sm" type="button" data-analysis-model-edit-relation="${esc(relation.id)}">编辑</button><button class="btn-danger btn-sm" type="button" data-analysis-model-delete-relation="${esc(relation.id)}">删除</button>` : ''}
                </div>
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
        for (const [field, dataset] of [[leftField, leftDataset], [rightField, rightDataset]]) {
            if (!field) continue;
            const previous = field.value;
            PivotSafeHtml.setHtml(field, fieldOptions(dataset, false));
            if ((dataset?.columns || []).some(column => column.key === previous)) field.value = previous;
        }
    }

    async function loadSemanticModels({ silent = false } = {}) {
        const sequence = ++listSequence;
        const dataset = governanceDataset();
        try {
            const [metrics, models] = await Promise.all([
                fetchJson(`${API}/metrics${dataset ? `?datasetId=${encodeURIComponent(dataset.id)}` : ''}`),
                fetchJson(`${API}/models`)
            ]);
            if (sequence !== listSequence) return;
            state.metrics = metrics.metrics || [];
            state.dataModels = models.models || [];
            const target = state.dataModels.some(item => item.id === state.activeDataModelId) ? state.activeDataModelId : state.dataModels[0]?.id || '';
            if (target) await loadDataModel(target, { silent: true });
            else { state.activeDataModelId = ''; state.activeDataModel = null; renderMetrics(); renderModels(); }
            renderMetrics();
        } catch (error) {
            if (sequence === listSequence && !silent) toast(error?.message || '加载指标与数据模型失败', 'error');
        }
    }

    async function loadDataModel(modelId, { silent = false } = {}) {
        const sequence = ++modelSequence;
        app.invalidateRequest('model-result');
        state.activeDataModelId = modelId;
        state.activeDataModel = null;
        renderModels();
        try {
            const data = await fetchJson(`${API}/models/${encodeURIComponent(modelId)}`);
            if (sequence !== modelSequence || state.activeDataModelId !== modelId) return;
            state.activeDataModelId = modelId;
            state.activeDataModel = data.model || null;
            if (byId('data-analysis-model-query-result')) byId('data-analysis-model-query-result').textContent = '';
            renderModels();
        } catch (error) {
            if (sequence === modelSequence && !silent) toast(error?.message || '加载数据模型失败', 'error');
        }
    }

    function resetModelForm(model = null) {
        state.editingModelId = model?.id || '';
        state.editingModelVersion = model?.version;
        byId('data-analysis-model-name').value = model?.name || '';
        byId('data-analysis-model-description').value = model?.description || '';
        byId('data-analysis-model-create').textContent = model ? '保存模型修改' : '创建模型';
        byId('data-analysis-model-form-title').textContent = model ? `修改模型：${model.name}` : '新建跨数据集模型';
    }

    function openRelationEditor(relationId = '') {
        app.invalidateRequest('relation-quality');
        const model = state.activeDataModel;
        if (!model?.isOwner) return;
        const relation = (model.relations || []).find(item => item.id === relationId);
        state.editingRelationId = relation?.id || '';
        state.relationModelId = model.id;
        state.relationModelVersion = model.version;
        for (const [side, datasetId] of [['left', relation?.leftDatasetId || ''], ['right', relation?.rightDatasetId || '']]) {
            const select = byId(`data-analysis-relation-${side}-dataset`);
            PivotSafeHtml.setHtml(select, dataSetOptions(datasetId)); select.value = datasetId;
        }
        renderRelationFieldOptions();
        if (relation) {
            byId('data-analysis-relation-left-field').value = relation.leftFieldKey;
            byId('data-analysis-relation-right-field').value = relation.rightFieldKey;
        }
        byId('data-analysis-relation-join-type').value = relation?.joinType || 'left';
        byId('data-analysis-relation-cardinality').value = relation?.cardinality || 'many_to_one';
        byId('data-analysis-relation-quality').textContent = '';
        app.openModal('data-analysis-relation-modal');
    }

    function relationPayload() {
        return {
            leftDatasetId: byId('data-analysis-relation-left-dataset')?.value || '', leftFieldKey: byId('data-analysis-relation-left-field')?.value || '',
            rightDatasetId: byId('data-analysis-relation-right-dataset')?.value || '', rightFieldKey: byId('data-analysis-relation-right-field')?.value || '',
            joinType: byId('data-analysis-relation-join-type')?.value || 'left', cardinality: byId('data-analysis-relation-cardinality')?.value || 'many_to_one',
            expectedVersion: state.relationModelVersion
        };
    }

    function qualityText(quality) {
        const match = quality.leftMatchRate == null ? '无左侧记录' : `左侧匹配率 ${(quality.leftMatchRate * 100).toFixed(1)}%`;
        return `${match}；关联后 ${fmtNumber(quality.joinedRows)} 行；左侧重复键 ${fmtNumber(quality.leftDuplicateKeys)} 个，右侧重复键 ${fmtNumber(quality.rightDuplicateKeys)} 个。${(quality.warnings || []).join('')}`;
    }

    async function previewRelation() {
        const modelId = state.relationModelId;
        const payload = relationPayload();
        const current = app.captureRequest('relation-quality', () => `${state.relationModelId}:${JSON.stringify(relationPayload())}`);
        const data = await fetchJson(`${API}/models/${encodeURIComponent(modelId)}/relations/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (current()) byId('data-analysis-relation-quality').textContent = qualityText(data.quality);
    }

    async function deleteModelRelation(relationId) {
        const model = state.activeDataModel;
        if (!model?.isOwner || !await window.Pivot.legacy.showConfirm?.('删除关联', '删除后会改变模型的关联范围。有关联依赖时，请先调整或删除依赖关系。')) return;
        await fetchJson(`${API}/models/${encodeURIComponent(model.id)}/relations/${encodeURIComponent(relationId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: model.version }) });
        if (state.activeDataModelId === model.id) await loadDataModel(model.id);
        toast('关联已删除。', 'success');
    }

    async function deleteModel() {
        const model = state.activeDataModel;
        if (!model?.isOwner || !await window.Pivot.legacy.showConfirm?.('删除数据模型', `确认删除“${model.name}”及其关联配置？源数据集将保留。`)) return;
        await fetchJson(`${API}/models/${encodeURIComponent(model.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: model.version }) });
        if (state.activeDataModelId === model.id) { state.activeDataModelId = ''; state.activeDataModel = null; }
        if (state.editingModelId === model.id) resetModelForm();
        await loadSemanticModels(); toast('数据模型已删除。', 'success');
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
        const editing = state.editingModelId;
        const data = await fetchJson(`${API}/models${editing ? `/${encodeURIComponent(editing)}` : ''}`, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: String(byId('data-analysis-model-description')?.value || '').trim(), expectedVersion: state.editingModelVersion }) });
        state.activeDataModelId = data.model?.id || '';
        resetModelForm();
        app.closeModal?.('data-analysis-model-modal');
        await loadSemanticModels({ silent: true });
        toast(editing ? '数据模型信息已保存。' : '数据模型已创建。', 'success');
    }

    async function saveModelRelation() {
        const model = state.activeDataModel;
        if (!model) throw new Error('请先创建或选择数据模型。');
        const modelId = state.relationModelId || model.id;
        const relationId = state.editingRelationId;
        const data = await fetchJson(`${API}/models/${encodeURIComponent(modelId)}/relations${relationId ? `/${encodeURIComponent(relationId)}` : ''}`, {
            method: relationId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(relationPayload())
        });
        app.closeModal?.('data-analysis-relation-modal');
        if (state.activeDataModelId === modelId) await loadDataModel(modelId, { silent: true });
        app.openModal?.('data-analysis-model-modal');
        toast(`关联已保存，左侧 ${fmtNumber(data.relation?.quality?.leftRows || 0)} 行。`, 'success');
    }

    function renderModelQueryResult(result) {
        const box = byId('data-analysis-model-query-result');
        if (!box) return;
        const rows = result.rows || [];
        const columns = result.columns || [];
        const notes = (result.warnings || []).map(warning => `<p class="data-analysis-muted-cell">${esc(warning)}</p>`).join('');
        const quality = result.relation?.quality ? `<p>${esc(qualityText(result.relation.quality))}</p>` : '';
        PivotSafeHtml.setHtml(box, notes + quality + (rows.length ? `${result.truncated ? '<p>结果超过显示上限，仅显示前 100 行。</p>' : ''}<div class="table-container"><table class="data-table compact-table"><thead><tr>${columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${esc(row[column] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="data-analysis-empty">关联没有返回记录。</div>'));
    }

    async function runModelRelation(relationId) {
        const model = state.activeDataModel;
        if (!model) return;
        const current = app.captureRequest('model-result', () => state.activeDataModelId);
        const result = await fetchJson(`${API}/models/${encodeURIComponent(model.id)}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relationId, limit: 100 }) });
        if (!current()) return;
        renderModelQueryResult(result);
    }

    async function runModelAnalysis() {
        const model = state.activeDataModel;
        if (!model) throw new Error('请先选择数据模型。');
        const dimensionValue = byId('data-analysis-model-dimension')?.value;
        const measureValue = byId('data-analysis-model-measure')?.value;
        const aggregation = byId('data-analysis-model-aggregation')?.value || 'count';
        if (!dimensionValue || (aggregation !== 'count' && !measureValue)) throw new Error('请选择分组字段和所需的数值字段。');
        const current = app.captureRequest('model-result', () => state.activeDataModelId);
        const result = await fetchJson(`${API}/models/${encodeURIComponent(model.id)}/analysis`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dimension: JSON.parse(dimensionValue), measure: measureValue ? JSON.parse(measureValue) : null, aggregation, limit: 100 })
        });
        if (current()) renderModelQueryResult(result);
    }

    function bindSemanticModelEvents(root) {
        if (!root || root.dataset.semanticModelEventsBound === 'true') return;
        root.dataset.semanticModelEventsBound = 'true';
        root.addEventListener('change', event => {
            if (['data-analysis-relation-left-dataset', 'data-analysis-relation-right-dataset'].includes(event.target?.id)) renderRelationFieldOptions();
            if (event.target?.id?.startsWith('data-analysis-relation-')) {
                app.invalidateRequest('relation-quality');
                if (byId('data-analysis-relation-quality')) byId('data-analysis-relation-quality').textContent = '';
            }
        });
        root.addEventListener('click', async event => {
            try {
                if (event.target.closest('#data-analysis-open-metric-modal')) { renderMetrics(); return; }
                if (event.target.closest('#data-analysis-metric-save')) { await guardButton('data-analysis-metric-save', '保存中…', saveMetric); return; }
                const metric = event.target.closest('[data-analysis-metric-evaluate]');
                if (metric) { await evaluateMetric(metric.dataset.analysisMetricEvaluate); return; }
                if (event.target.closest('#data-analysis-model-create')) { await guardButton('data-analysis-model-create', '创建中…', createDataModel); return; }
                const select = event.target.closest('[data-analysis-model-select]');
                if (select) { await loadDataModel(select.dataset.analysisModelSelect); return; }
                if (event.target.closest('#data-analysis-model-form-reset')) { resetModelForm(); return; }
                if (event.target.closest('#data-analysis-model-edit')) { resetModelForm(state.activeDataModel); return; }
                if (event.target.closest('#data-analysis-model-delete')) { await guardButton('data-analysis-model-delete', '删除中…', deleteModel); return; }
                if (event.target.closest('#data-analysis-open-relation')) { openRelationEditor(); return; }
                const edit = event.target.closest('[data-analysis-model-edit-relation]');
                if (edit) { openRelationEditor(edit.dataset.analysisModelEditRelation); return; }
                const remove = event.target.closest('[data-analysis-model-delete-relation]');
                if (remove) { await deleteModelRelation(remove.dataset.analysisModelDeleteRelation); return; }
                if (event.target.closest('#data-analysis-model-relation-run')) { await guardButton('data-analysis-model-relation-run', '检查中…', previewRelation); return; }
                if (event.target.closest('[data-analysis-modal-close="data-analysis-relation-modal"]')) { app.openModal?.('data-analysis-model-modal'); return; }
                if (event.target.closest('#data-analysis-model-relation-save')) { await guardButton('data-analysis-model-relation-save', '保存中…', saveModelRelation); return; }
                if (event.target.closest('#data-analysis-model-analyze')) { await guardButton('data-analysis-model-analyze', '汇总中…', runModelAnalysis); return; }
                const preview = event.target.closest('[data-analysis-model-run-relation]');
                if (preview) { await runModelRelation(preview.dataset.analysisModelRunRelation); return; }
            } catch (error) {
                toast(error?.message || '指标或数据模型操作失败', 'error');
            }
        });
    }

    Object.assign(app, { loadSemanticModels, bindSemanticModelEvents, renderMetrics, renderModels });
})();
