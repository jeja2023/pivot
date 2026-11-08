(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber } = app;

    const byId = id => document.getElementById(id);
    const fetchJson = (...args) => app.fetchJson(...args);
    const toast = (...args) => app.toast(...args);
    const guardButton = (...args) => app.guardButton(...args);
    let governanceRequest = 0;
    let assetsRequest = 0;

    function dataSetOptions(selected = '', emptyLabel = '请选择数据集') {
        const items = [`<option value="">${esc(emptyLabel)}</option>`];
        (state.datasets || []).forEach(dataset => {
            items.push(`<option value="${esc(dataset.id)}"${dataset.id === selected ? ' selected' : ''}>${esc(dataset.name)}${dataset.scope === 'shared' ? '（共享）' : ''}</option>`);
        });
        return items.join('');
    }

    function currentGovernanceDatasetId() {
        return state.governanceDatasetId || '';
    }

    function currentAssetsDatasetId() {
        return state.assetsDatasetId || '';
    }

    function getInputValue(id) {
        return String(byId(id)?.value || '').trim();
    }

    function renderSourceState() {
        const node = byId('data-analysis-source-state');
        if (!node) return;
        const source = state.sourceState;
        if (!source) { node.textContent = ''; return; }
        if (source.state === 'available') {
            node.textContent = `源文件可用 · ${source.sourcePath} · ${fmtNumber(source.sourceBytes)} 字节`;
        } else {
            node.textContent = source.message || '当前数据集没有可直接刷新监控的原始文件。';
        }
    }

    function renderFieldGovernance() {
        const box = byId('data-analysis-field-governance');
        if (!box) return;
        const fields = state.fieldGovernance || [];
        if (!fields.length) {
            PivotSafeHtml.setHtml(box, '<div class="data-analysis-empty">请选择数据集后加载字段字典。</div>');
            return;
        }
        PivotSafeHtml.setHtml(box, `
            <div class="table-container data-analysis-governance-table-wrap">
                <table class="data-table compact-table data-analysis-governance-table">
                    <colgroup>
                        <col class="data-analysis-gov-col-field">
                        <col class="data-analysis-gov-col-name">
                        <col class="data-analysis-gov-col-type">
                        <col class="data-analysis-gov-col-role">
                        <col class="data-analysis-gov-col-format">
                        <col class="data-analysis-gov-col-sensitivity">
                        <col class="data-analysis-gov-col-def">
                    </colgroup>
                    <thead>
                        <tr>
                            <th class="data-analysis-gov-th-field">字段</th>
                            <th class="data-analysis-gov-th-name">显示名称</th>
                            <th class="data-analysis-gov-th-type">业务类型</th>
                            <th class="data-analysis-gov-th-role">角色</th>
                            <th class="data-analysis-gov-th-format">单位/日期格式</th>
                            <th class="data-analysis-gov-th-sensitivity">敏感级别</th>
                            <th class="data-analysis-gov-th-def">业务定义</th>
                        </tr>
                    </thead>
                    <tbody>
                    ${fields.map(field => `<tr data-analysis-governance-field="${esc(field.fieldKey)}">
                        <td><div class="data-analysis-gov-field-cell"><code class="data-analysis-gov-field-code">${esc(field.fieldKey)}</code><span class="data-analysis-field-source">${esc(field.sourceName || '')}</span></div></td>
                        <td><input class="form-input" data-governance-input="displayName" maxlength="80" value="${esc(field.displayName || field.sourceName || '')}" placeholder="显示名称"></td>
                        <td><select class="form-input" data-governance-input="logicalType"><option value="auto"${field.logicalType === 'auto' ? ' selected' : ''}>自动识别</option><option value="text"${field.logicalType === 'text' ? ' selected' : ''}>文本</option><option value="number"${field.logicalType === 'number' ? ' selected' : ''}>数值</option><option value="date"${field.logicalType === 'date' ? ' selected' : ''}>日期</option><option value="boolean"${field.logicalType === 'boolean' ? ' selected' : ''}>布尔</option></select></td>
                        <td><div class="data-analysis-governance-role-cell"><label class="data-analysis-governance-checkbox-label"><input type="checkbox" data-governance-input="isDimension"${field.isDimension ? ' checked' : ''}> 维度</label><label class="data-analysis-governance-checkbox-label"><input type="checkbox" data-governance-input="isMetric"${field.isMetric ? ' checked' : ''}> 指标</label></div></td>
                        <td><div class="data-analysis-governance-dual-input"><input class="form-input data-analysis-gov-input-unit" data-governance-input="unit" maxlength="40" value="${esc(field.unit || '')}" placeholder="单位"><input class="form-input data-analysis-gov-input-date" data-governance-input="dateFormat" maxlength="60" value="${esc(field.dateFormat || '')}" placeholder="日期格式"></div></td>
                        <td><select class="form-input" data-governance-input="sensitivity"><option value="public"${field.sensitivity === 'public' ? ' selected' : ''}>公开</option><option value="internal"${field.sensitivity === 'internal' ? ' selected' : ''}>内部</option><option value="confidential"${field.sensitivity === 'confidential' ? ' selected' : ''}>机密</option><option value="restricted"${field.sensitivity === 'restricted' ? ' selected' : ''}>受限</option></select></td>
                        <td><input class="form-input" data-governance-input="businessDefinition" maxlength="1000" value="${esc(field.businessDefinition || '')}" placeholder="业务含义与口径"></td>
                    </tr>`).join('')}
                    </tbody>
                </table>
            </div>`);
    }

    function renderCalculatedFields() {
        const box = byId('data-analysis-calculated-fields');
        if (!box) return;
        const fields = state.calculatedFields || [];
        PivotSafeHtml.setHtml(box, fields.length ? fields.map(field => `
            <div class="data-analysis-asset-row"><div><strong>${esc(field.name)}</strong><span><code>${esc(field.fieldKey)}</code> · ${esc(field.expression)} · v${fmtNumber(field.version)}</span></div><button class="btn-secondary" type="button" data-analysis-open-calculated-output="${esc(field.outputDatasetId)}">打开派生数据集</button></div>
        `).join('') : '<div class="data-analysis-empty">暂无计算字段。预览并生成后会在此保留版本和依赖。</div>');
    }

    function renderCalculatedPreview(data = null) {
        const box = byId('data-analysis-calc-preview-result');
        if (!box) return;
        if (!data) { PivotSafeHtml.setHtml(box, ''); return; }
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const columns = rows.length ? Object.keys(rows[0]) : [];
        PivotSafeHtml.setHtml(box, `
            <div class="data-analysis-calc-preview-head">表达式：<code>${esc(data.formula?.expression || '')}</code>；依赖：${(data.formula?.dependencies || []).map(esc).join('、') || '—'}</div>
            ${rows.length ? `<div class="table-container"><table class="data-table compact-table"><thead><tr>${columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${esc(row[column] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="data-analysis-empty">表达式没有返回可预览的记录。</div>'}`);
    }

    function currentViewConfig(type) {
        if (type === 'chart') {
            const config = {
                xField: getInputValue('data-analysis-chart-x'), yField: getInputValue('data-analysis-chart-y'), y2Field: getInputValue('data-analysis-chart-y2'),
                groupField: getInputValue('data-analysis-chart-group'), aggregation: getInputValue('data-analysis-chart-aggregation') || 'count',
                chartType: getInputValue('data-analysis-chart-type') || 'bar', limit: Number(getInputValue('data-analysis-chart-limit') || 30),
                sortBy: getInputValue('data-analysis-chart-sort') || 'value', colorPalette: getInputValue('data-analysis-chart-palette') || 'teal'
            };
            if (!config.xField) throw new Error('请先在图表生成页选择分类字段。');
            return config;
        }
        if (type === 'pivot') {
            const config = {
                rowField: getInputValue('data-analysis-pivot-row'), colField: getInputValue('data-analysis-pivot-col'),
                valueField: getInputValue('data-analysis-pivot-value'), aggregation: getInputValue('data-analysis-pivot-aggregation') || 'count',
                rowLimit: Number(getInputValue('data-analysis-pivot-row-limit') || 50), colLimit: Number(getInputValue('data-analysis-pivot-col-limit') || 20),
                sortBy: getInputValue('data-analysis-pivot-sort') || 'total_desc', emptyLabel: getInputValue('data-analysis-pivot-empty-label') || '(空值)'
            };
            if (!config.rowField) throw new Error('请先在数据透视页选择行维度。');
            return config;
        }
        const sql = state.queryMode === 'visual' ? app.buildSqlFromVisual?.() : getInputValue('data-analysis-query-sql');
        if (!sql) throw new Error('请先在数据查询页配置并运行查询。');
        return { sql, limit: Number(state.visualQuery?.limit || 100) };
    }

    function renderSavedViews() {
        const box = byId('data-analysis-saved-views');
        if (!box) return;
        if (!currentAssetsDatasetId()) {
            PivotSafeHtml.setHtml(box, '<div class="data-analysis-empty">请选择关联数据集后查看分析资产。</div>');
            return;
        }
        const views = state.savedViews || [];
        const typeLabels = { query: 'SQL 查询', pivot: '数据透视', chart: '可视化图表' };
        PivotSafeHtml.setHtml(box, views.length ? views.map(view => `
            <div class="data-analysis-asset-row">
                <div class="data-analysis-asset-info">
                    <div class="data-analysis-asset-title-line">
                        <strong>${esc(view.name)}</strong>
                        <span class="data-analysis-type-badge">${esc(typeLabels[view.viewType] || view.viewType)}</span>
                        <span class="data-analysis-scope-badge ${view.scope === 'shared' ? 'is-shared' : ''}">${view.scope === 'shared' ? '已共享' : '私有'}</span>
                    </div>
                    <span>${esc(view.description || '无补充说明')} · ${view.sourceType === 'model' ? `模型发布版本 v${esc(view.publishedVersion)}` : `数据集版本 v${fmtNumber(view.sourceVersion)}`}</span>
                </div>
                <div class="data-analysis-inline-actions">
                    <button class="btn-secondary btn-sm" type="button" data-analysis-view-run="${esc(view.id)}" title="载入并运行视图">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                        <span>运行</span>
                    </button>
                    ${view.isOwner ? `<button class="btn-secondary btn-sm is-danger" type="button" data-analysis-view-delete="${esc(view.id)}" title="删除视图">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        <span>删除</span>
                    </button>` : ''}
                </div>
            </div>
        `).join('') : '<div class="data-analysis-empty">暂无保存视图。可从当前查询、透视或图表配置创建。</div>');
    }

    function renderGovernance() {
        const governanceSelect = byId('data-analysis-governance-dataset');
        const assetsSelect = byId('data-analysis-assets-dataset');
        const selected = currentGovernanceDatasetId();
        if (governanceSelect) { PivotSafeHtml.setHtml(governanceSelect, dataSetOptions(selected)); governanceSelect.value = selected; }
        if (assetsSelect) { PivotSafeHtml.setHtml(assetsSelect, dataSetOptions(currentAssetsDatasetId())); assetsSelect.value = currentAssetsDatasetId(); }
        renderSourceState();
        renderFieldGovernance();
        renderCalculatedFields();
        renderSavedViews();
    }

    async function loadGovernance(datasetId = currentGovernanceDatasetId(), { silent = false } = {}) {
        const id = String(datasetId || '').trim();
        const request = ++governanceRequest;
        state.governanceDatasetId = id;
        state.fieldGovernance = [];
        state.calculatedFields = [];
        state.sourceState = null;
        renderGovernance();
        if (!id) {
            return;
        }
        try {
            const [fields, calculated, source] = await Promise.all([
                fetchJson(`${API}/datasets/${encodeURIComponent(id)}/fields`),
                fetchJson(`${API}/datasets/${encodeURIComponent(id)}/calculated-fields`),
                fetchJson(`${API}/datasets/${encodeURIComponent(id)}/source-state`)
            ]);
            if (request !== governanceRequest) return;
            state.fieldGovernance = fields.fields || [];
            state.calculatedFields = calculated.fields || [];
            state.sourceState = source || null;
            renderGovernance();
        } catch (error) {
            if (request === governanceRequest && !silent) toast(error?.message || '加载数据治理信息失败', 'error');
        }
    }

    async function loadAssets(datasetId = currentAssetsDatasetId(), { silent = false } = {}) {
        const id = String(datasetId || '').trim();
        const request = ++assetsRequest;
        state.assetsDatasetId = id;
        state.savedViews = [];
        renderGovernance();
        if (!id) {
            return;
        }
        try {
            const views = await fetchJson(`${API}/views?datasetId=${encodeURIComponent(id)}`);
            if (request !== assetsRequest) return;
            state.savedViews = views.views || [];
            renderGovernance();
        } catch (error) {
            if (request === assetsRequest && !silent) toast(error?.message || '加载分析资产失败', 'error');
        }
    }

    async function saveFieldGovernance() {
        const datasetId = currentGovernanceDatasetId();
        if (!datasetId) throw new Error('请先选择数据集。');
        const fields = Array.from(document.querySelectorAll('[data-analysis-governance-field]')).map(row => ({
            fieldKey: row.dataset.analysisGovernanceField,
            displayName: row.querySelector('[data-governance-input="displayName"]')?.value || '',
            logicalType: row.querySelector('[data-governance-input="logicalType"]')?.value || 'auto',
            unit: row.querySelector('[data-governance-input="unit"]')?.value || '',
            dateFormat: row.querySelector('[data-governance-input="dateFormat"]')?.value || '',
            sensitivity: row.querySelector('[data-governance-input="sensitivity"]')?.value || 'internal',
            businessDefinition: row.querySelector('[data-governance-input="businessDefinition"]')?.value || '',
            isDimension: Boolean(row.querySelector('[data-governance-input="isDimension"]')?.checked),
            isMetric: Boolean(row.querySelector('[data-governance-input="isMetric"]')?.checked)
        }));
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(datasetId)}/fields`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields })
        });
        state.fieldGovernance = data.fields || [];
        await app.loadDatasets?.({ keepActive: true });
        renderGovernance();
        toast('字段治理已保存；受限字段将从共享查询、图表和导出中排除。', 'success');
    }

    function calculatedPayload() {
        return {
            name: getInputValue('data-analysis-calc-name'), expression: getInputValue('data-analysis-calc-expression'),
            unit: getInputValue('data-analysis-calc-unit'), sensitivity: getInputValue('data-analysis-calc-sensitivity') || 'internal',
            datasetName: getInputValue('data-analysis-calc-dataset-name')
        };
    }

    async function previewCalculatedField() {
        const datasetId = currentGovernanceDatasetId();
        if (!datasetId) throw new Error('请先选择数据集。');
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(datasetId)}/calculated-fields/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calculatedPayload())
        });
        renderCalculatedPreview(data);
    }

    async function createCalculatedField() {
        const datasetId = currentGovernanceDatasetId();
        if (!datasetId) throw new Error('请先选择数据集。');
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(datasetId)}/calculated-fields`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calculatedPayload())
        });
        state.activeId = data.dataset?.id || state.activeId;
        renderCalculatedPreview(null);
        ['data-analysis-calc-name', 'data-analysis-calc-expression', 'data-analysis-calc-unit', 'data-analysis-calc-dataset-name'].forEach(id => { if (byId(id)) byId(id).value = ''; });
        app.closeModal?.('data-analysis-calc-modal');
        await app.loadDatasets?.({ keepActive: true });
        await loadGovernance(datasetId, { silent: true });
        toast(`已生成派生数据集「${data.dataset?.name || ''}」。`, 'success');
    }

    async function openDatasetShareModal() {
        const datasetId = currentGovernanceDatasetId();
        const dataset = (state.datasets || []).find(item => item.id === datasetId);
        if (!dataset) {
            toast('请先从顶部选择需要共享的数据集。', 'warning');
            return;
        }
        const curUser = (typeof currentUser !== 'undefined' && currentUser) || window.Pivot?.legacy?.currentUser || null;
        const isOwner = !dataset.userId || !curUser?.id || String(dataset.userId) === String(curUser.id);
        if (!isOwner) {
            toast('只有数据集所有者可以修改共享与协作者设置。', 'warning');
            return;
        }

        const modalEngine = window.Pivot?.modules?.['share.collaborators'] || window.Pivot?.legacy?.PivotShareCollabModal;
        if (!modalEngine) {
            toast('共享协作组件尚未就绪，请刷新重试。', 'error');
            return;
        }

        let targets = { units: [], users: [] };
        try {
            targets = await fetchJson(`${API}/share-targets`);
        } catch (_e) {
            targets = { units: [], users: [] };
        }

        const owner = curUser ? {
            id: curUser.id,
            username: curUser.username,
            nickname: curUser.nickname || curUser.username,
            unit: curUser.unit || '未分配单位'
        } : null;

        const existingUserIds = String(dataset.allowedUserIds || '')
            .split(',')
            .map(s => Number(s.trim()))
            .filter(Number.isSafeInteger);

        const initialCollaborators = existingUserIds.map(id => {
            const found = (targets.users || []).find(u => Number(u.id) === id);
            return {
                id,
                username: found?.username || `用户${id}`,
                nickname: found?.nickname || found?.username || `用户${id}`,
                unit: found?.unit || '未分配单位',
                role: 'viewer'
            };
        });

        const existingUnits = String(dataset.allowedUnits || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

        modalEngine.open({
            modalId: 'data-analysis-dataset-share-modal',
            title: '数据集协作者与共享',
            subtitle: '管理协同查看、分析与共享该数据集的成员与部门协作范围。',
            summaryTitle: dataset.name || '数据集',
            summaryDesc: '共享数据集时，标记为机密或受限的敏感字段将在被共享用户预览、查询和导出中被自动剔除。',
            owner,
            users: Array.isArray(targets.users) ? targets.users : [],
            units: Array.isArray(targets.units) ? targets.units : [],
            initialCollaborators,
            roles: [
                { value: 'viewer', label: '查看者（可浏览及使用受控脱敏数据）', shortLabel: '查看者' }
            ],
            defaultRole: 'viewer',
            onSave: async ({ collaborators, selectedBatchUnits }) => {
                const finalUserIds = (collaborators || []).map(c => Number(c.id)).filter(Number.isSafeInteger);
                const batchUnits = Array.isArray(selectedBatchUnits) && selectedBatchUnits.length
                    ? selectedBatchUnits
                    : existingUnits;
                const willShare = finalUserIds.length > 0 || batchUnits.length > 0;
                const scope = willShare ? app.SHARED_SCOPE : 'personal';

                const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        scope,
                        allowedUnits: batchUnits.join(','),
                        allowedUserIds: finalUserIds.join(',')
                    })
                });

                const index = state.datasets.findIndex(item => item.id === dataset.id);
                if (index >= 0) state.datasets[index] = { ...state.datasets[index], ...data.dataset };
                renderGovernance();
                toast(willShare ? '数据集共享与协作者设置已保存。' : '已取消数据集共享（已设为私有）。', 'success');
            }
        });
    }

    async function saveCurrentView() {
        const datasetId = currentAssetsDatasetId();
        const type = getInputValue('data-analysis-view-type') || 'chart';
        const name = getInputValue('data-analysis-view-name');
        if (!datasetId || !name) throw new Error('请选择数据集并填写分析资产名称。');
        const scope = byId('data-analysis-view-shared')?.checked ? app.SHARED_SCOPE : 'personal';
        const view = await fetchJson(`${API}/datasets/${encodeURIComponent(datasetId)}/views`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description: getInputValue('data-analysis-view-description'), viewType: type, config: currentViewConfig(type), scope, allowedUnits: getInputValue('data-analysis-view-shared-units') })
        });
        if (byId('data-analysis-view-name')) byId('data-analysis-view-name').value = '';
        app.closeModal?.('data-analysis-save-view-modal');
        await loadAssets(datasetId, { silent: true });
        toast(`已保存分析视图「${view.view?.name || name}」。`, 'success');
    }

    async function runSavedView(viewId) {
        const userId = String(window.Pivot.legacy.currentUser?.id || '');
        const data = await fetchJson(`${API}/views/${encodeURIComponent(viewId)}/run`, { method: 'POST' });
        if (String(window.Pivot.legacy.currentUser?.id || '') !== userId) return;
        if (data.sourceType === 'model') { await app.modeling.openSavedModelRun(data); return; }
        const type = data.view?.viewType;
        if (type === 'chart') {
            state.chart = data.result?.chart || null;
            app.activateTab?.('chart');
            app.renderChart?.();
        } else if (type === 'pivot') {
            state.pivot = data.result;
            app.activateTab?.('pivot');
            app.renderPivot?.();
        } else {
            state.query = data.result;
            state.queryPage = 1;
            app.activateTab?.('query');
            app.renderQuery?.();
        }
        toast('已运行保存视图。', 'success');
    }

    async function deleteSavedView(viewId) {
        await fetchJson(`${API}/views/${encodeURIComponent(viewId)}`, { method: 'DELETE' });
        await loadAssets(currentAssetsDatasetId(), { silent: true });
        toast('分析视图已删除。', 'success');
    }

    function bindGovernanceEvents(root) {
        if (!root || root.dataset.governanceEventsBound === 'true') return;
        root.dataset.governanceEventsBound = 'true';
        root.addEventListener('change', event => {
            if (event.target?.id === 'data-analysis-governance-dataset') {
                const datasetId = event.target.value;
                loadGovernance(datasetId).catch(error => toast(error?.message || '加载治理信息失败', 'error'));
                app.loadScalability?.(datasetId, { silent: true });
                app.loadSemanticModels?.({ silent: true });
            }
            if (event.target?.id === 'data-analysis-assets-dataset') {
                loadAssets(event.target.value).catch(error => toast(error?.message || '加载分析资产失败', 'error'));
            }
        });
        root.addEventListener('click', async event => {
            try {
                if (event.target.closest('#data-analysis-governance-refresh')) {
                    await loadGovernance(currentGovernanceDatasetId()); return;
                }
                if (event.target.closest('#data-analysis-assets-refresh')) {
                    await loadAssets(currentAssetsDatasetId()); return;
                }
                if (event.target.closest('#data-analysis-governance-save')) { await guardButton('data-analysis-governance-save', '保存中…', saveFieldGovernance); return; }
                if (event.target.closest('#data-analysis-calc-preview')) { await guardButton('data-analysis-calc-preview', '计算中…', previewCalculatedField); return; }
                if (event.target.closest('#data-analysis-calc-create')) { await guardButton('data-analysis-calc-create', '生成中…', createCalculatedField); return; }
                if (event.target.closest('#data-analysis-open-share-modal')) { await openDatasetShareModal(); return; }
                if (event.target.closest('#data-analysis-save-view')) { await guardButton('data-analysis-save-view', '保存中…', saveCurrentView); return; }
                const output = event.target.closest('[data-analysis-open-calculated-output]');
                if (output) { await app.loadDatasetDetail?.(output.dataset.analysisOpenCalculatedOutput); app.activateTab?.('overview'); return; }
                const run = event.target.closest('[data-analysis-view-run]');
                if (run) { await runSavedView(run.dataset.analysisViewRun); return; }
                const remove = event.target.closest('[data-analysis-view-delete]');
                if (remove) { await deleteSavedView(remove.dataset.analysisViewDelete); return; }
            } catch (error) {
                toast(error?.message || '数据治理操作失败', 'error');
            }
        });
    }

    Object.assign(app, {
        loadGovernance,
        loadAssets,
        renderGovernance,
        renderCalculatedPreview,
        openDatasetShareModal,
        bindGovernanceEvents,
        currentViewConfig,
        currentGovernanceDatasetId,
        currentAssetsDatasetId
    });
})();
