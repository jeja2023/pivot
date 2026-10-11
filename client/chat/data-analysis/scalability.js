(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber } = app;
    const fetchJson = (...args) => app.fetchJson(...args);
    const toast = (...args) => app.toast(...args);
    let eventsBound = false;

    function activeDatasetId() {
        return String(state.governanceDatasetId || state.activeId || '').trim();
    }

    function mountScalabilityPanel() {
        if (document.getElementById('data-analysis-scalability-panel')) return;
        const host = document.getElementById('data-analysis-governance-panel') || document.body;
        if (!host) return;
        const modal = document.createElement('div');
        modal.id = 'data-analysis-scalability-modal';
        modal.className = 'modal-overlay data-analysis-modal-overlay hidden';
        PivotSafeHtml.setHtml(modal, `
            <div class="modal data-analysis-dialog-modal data-analysis-scalability-modal-dialog data-analysis-modal-size-840-90">
                <div class="data-analysis-modal-header">
                    <div class="data-analysis-modal-title-group">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-modal-icon"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
                        <div>
                            <h3>规模化数据管道</h3>
                            <p class="data-analysis-modal-subtitle">开发环境使用受控本地存储：增量导入生成可回放版本，分区 Parquet 与物化聚合均绑定字段权限。</p>
                        </div>
                    </div>
                    <div class="data-analysis-inline-actions">
                        <button id="data-analysis-scale-refresh" class="btn-secondary btn-sm" type="button" title="刷新管道状态">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                            <span>刷新状态</span>
                        </button>
                    </div>
                </div>
                <div class="data-analysis-modal-body" id="data-analysis-scalability-panel">
                    <div class="data-analysis-scale-subtoolbar data-analysis-modal-mb-14">
                        <label class="data-analysis-dataset-picker">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
                            <span class="data-analysis-picker-label">目标数据集</span>
                            <select id="data-analysis-scale-dataset" class="form-input data-analysis-picker-select"></select>
                        </label>
                        <span id="data-analysis-scale-status" class="data-analysis-source-state"></span>
                    </div>
                    <div class="data-analysis-governance-grid">
                        <div class="data-analysis-pipe-box">
                            <div class="data-analysis-pipe-box-head">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                                <h6>增量导入</h6>
                            </div>
                            <div class="data-analysis-file-picker-row">
                                <label class="btn-secondary btn-sm data-analysis-file-btn" for="data-analysis-scale-increment-file">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                                    <span>选择文件</span>
                                </label>
                                <span id="data-analysis-scale-file-name" class="data-analysis-file-chosen-text">未选择任何文件</span>
                                <input id="data-analysis-scale-increment-file" class="data-analysis-hidden-file-input" type="file" accept=".csv,.xlsx,.xls,.sqlite,.sqlite3,.db">
                            </div>
                            <button id="data-analysis-scale-append" class="btn-secondary btn-sm" type="button">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                <span>追加为新版本</span>
                            </button>
                            <small>字段顺序必须与当前数据集一致；旧版本文件会保留用于回放。</small>
                        </div>
                        <div class="data-analysis-pipe-box">
                            <div class="data-analysis-pipe-box-head">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                                <h6>分区 Parquet</h6>
                            </div>
                            <select id="data-analysis-scale-partition-field" class="form-input data-analysis-pipe-select"></select>
                            <button id="data-analysis-scale-partition" class="btn-secondary btn-sm" type="button">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                <span>生成受控分区</span>
                            </button>
                            <small>分区副本保留在受控数据集目录，原始查询边界不变。</small>
                        </div>
                    </div>
                    <div class="data-analysis-governance-grid data-analysis-modal-mt-12">
                        <div class="data-analysis-pipe-box">
                            <div class="data-analysis-pipe-box-head">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                                <h6>物化聚合</h6>
                            </div>
                            <div class="data-analysis-pipe-form-grid">
                                <input id="data-analysis-scale-materialization-name" class="form-input data-analysis-pipe-input grid-span-full" maxlength="120" placeholder="例如：按区域销售额">
                                <select id="data-analysis-scale-materialization-group" class="form-input data-analysis-pipe-select"></select>
                                <select id="data-analysis-scale-materialization-field" class="form-input data-analysis-pipe-select"></select>
                                <select id="data-analysis-scale-materialization-aggregation" class="form-input data-analysis-pipe-select grid-span-full">
                                    <option value="sum">求和 (SUM)</option>
                                    <option value="count">计数 (COUNT)</option>
                                    <option value="avg">平均 (AVG)</option>
                                    <option value="min">最小 (MIN)</option>
                                    <option value="max">最大 (MAX)</option>
                                </select>
                            </div>
                            <button id="data-analysis-scale-materialization-save" class="btn-primary btn-sm" type="button">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                <span>创建物化聚合</span>
                            </button>
                        </div>
                        <div class="data-analysis-pipe-box">
                            <div class="data-analysis-pipe-box-head">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                                <h6>版本、分区与聚合资产</h6>
                            </div>
                            <div id="data-analysis-scale-assets" class="data-analysis-asset-list"></div>
                        </div>
                    </div>
                </div>
                <div class="data-analysis-modal-footer">
                    <button class="btn-secondary" type="button" data-analysis-modal-close="data-analysis-scalability-modal">取消</button>
                    <button class="btn-primary" type="button" data-analysis-modal-close="data-analysis-scalability-modal">完成</button>
                </div>
            </div>
        `);
        host.appendChild(modal);
    }

    function options(columns, emptyLabel) {
        return `<option value="">${esc(emptyLabel)}</option>${(columns || []).map(column => `<option value="${esc(column.key)}">${esc(column.name)}</option>`).join('')}`;
    }

    function selectedDataset() {
        const id = document.getElementById('data-analysis-scale-dataset')?.value || activeDatasetId();
        return (state.datasets || []).find(item => String(item.id) === String(id)) || null;
    }

    function listItem(value) {
        return `<li>${esc(value)}</li>`;
    }

    function renderScalability() {
        mountScalabilityPanel();
        const selector = document.getElementById('data-analysis-scale-dataset');
        if (!selector) return;
        const desired = state.scalabilityDatasetId || activeDatasetId();
        PivotSafeHtml.setHtml(selector, options(state.datasets || [], '请选择数据集'));
        selector.value = (state.datasets || []).some(item => item.id === desired) ? desired : '';
        const dataset = selectedDataset();
        const columns = dataset?.columns || [];
        ['data-analysis-scale-partition-field', 'data-analysis-scale-materialization-group', 'data-analysis-scale-materialization-field'].forEach((id, index) => {
            const element = document.getElementById(id);
            if (element) PivotSafeHtml.setHtml(element, options(columns, index === 1 ? '不分组（全局聚合）' : '请选择字段'));
        });
        const status = document.getElementById('data-analysis-scale-status');
        const assets = document.getElementById('data-analysis-scale-assets');
        if (!dataset) {
            if (status) status.textContent = '请选择数据集以配置规模化管道';
            if (assets) PivotSafeHtml.setHtml(assets, '<div class="data-analysis-empty">暂无可展示的版本或物化资产</div>');
            return;
        }
        const data = state.scalability || {};
        if (status) status.textContent = `当前版本 v${fmtNumber(data.sourceVersion || dataset.sourceVersion || 1)} · ${data.storageMode === 'managed_fs_partitioned' ? '已生成分区副本' : '托管本地 Parquet'}`;
        if (assets) {
            const versions = (data.versions || []).map(item => listItem(`v${fmtNumber(item.version)} · ${item.operation} · ${fmtNumber(item.rowCount)} 行`)).join('') || listItem('尚未创建版本记录');
            const partitions = (data.partitions || []).slice(0, 8).map(item => listItem(`${item.fieldKey}=${item.value} · ${fmtNumber(item.rowCount)} 行`)).join('') || listItem('尚未生成分区');
            const materializations = (data.materializations || []).map(item => listItem(`${item.name} · ${fmtNumber(item.rowCount)} 行 · 源版本 v${fmtNumber(item.sourceVersion)}`)).join('') || listItem('尚未创建物化聚合');
            PivotSafeHtml.setHtml(assets, `<div><strong>版本</strong><ul>${versions}</ul><strong>分区</strong><ul>${partitions}</ul><strong>物化聚合</strong><ul>${materializations}</ul></div>`);
        }
    }

    async function loadScalability(datasetId = activeDatasetId(), options = {}) {
        const id = String(datasetId || '').trim();
        state.scalabilityDatasetId = id;
        if (!id) { state.scalability = null; renderScalability(); return null; }
        try {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(id)}/scalability`);
            if (String(state.scalabilityDatasetId) !== id) return null;
            state.scalability = data;
            renderScalability();
            return data;
        } catch (error) {
            if (!options.silent) toast(error.message || '加载规模化数据管道失败', 'error');
            throw error;
        }
    }

    async function appendIncrement() {
        const dataset = selectedDataset();
        const file = document.getElementById('data-analysis-scale-increment-file')?.files?.[0];
        if (!dataset || !file) return toast('请选择数据集和增量文件', 'warning');
        const form = new FormData();
        form.append('file', file);
        const result = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/increments`, { method: 'POST', body: form });
        toast(`已追加 ${fmtNumber(result.appendedRows)} 行，生成版本 v${fmtNumber(result.sourceVersion)}`);
        const fileInput = document.getElementById('data-analysis-scale-increment-file');
        if (fileInput) fileInput.value = '';
        const nameEl = document.getElementById('data-analysis-scale-file-name');
        if (nameEl) {
            nameEl.textContent = '未选择任何文件';
            nameEl.title = '';
            nameEl.classList.remove('has-file');
        }
        await app.loadDatasets({ keepActive: true });
        await loadScalability(dataset.id, { silent: true });
    }

    async function partitionDataset() {
        const dataset = selectedDataset();
        const fieldKey = document.getElementById('data-analysis-scale-partition-field')?.value;
        if (!dataset || !fieldKey) return toast('请选择数据集和分区字段', 'warning');
        const result = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/partitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fieldKey }) });
        toast(`已生成 ${fmtNumber(result.partitionCount)} 个受控分区`);
        await loadScalability(dataset.id, { silent: true });
    }

    async function saveMaterialization() {
        const dataset = selectedDataset();
        const name = document.getElementById('data-analysis-scale-materialization-name')?.value.trim();
        const groupBy = document.getElementById('data-analysis-scale-materialization-group')?.value;
        const fieldKey = document.getElementById('data-analysis-scale-materialization-field')?.value;
        const aggregation = document.getElementById('data-analysis-scale-materialization-aggregation')?.value;
        if (!dataset || !name || (!fieldKey && aggregation !== 'count')) return toast('请填写名称并选择有效聚合字段', 'warning');
        const materialization = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/materializations`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, groupBy: groupBy ? [groupBy] : [], metrics: [{ name: aggregation === 'count' ? '记录数' : name, aggregation, fieldKey }] })
        });
        toast(`物化聚合已生成，共 ${fmtNumber(materialization.materialization?.rowCount)} 行`);
        await loadScalability(dataset.id, { silent: true });
    }

    function bindScalabilityEvents(root = document) {
        if (eventsBound) return;
        eventsBound = true;
        root.addEventListener('change', event => {
            if (event.target?.id === 'data-analysis-scale-dataset') void loadScalability(event.target.value, { silent: true });
            if (event.target?.id === 'data-analysis-scale-increment-file') {
                const nameEl = document.getElementById('data-analysis-scale-file-name');
                const file = event.target.files?.[0];
                if (nameEl) {
                    nameEl.textContent = file ? file.name : '未选择任何文件';
                    nameEl.title = file ? file.name : '';
                    nameEl.classList.toggle('has-file', Boolean(file));
                }
            }
        });
        root.addEventListener('click', event => {
            if (event.target.closest('#data-analysis-scale-refresh')) void loadScalability(activeDatasetId());
            if (event.target.closest('#data-analysis-scale-append')) void appendIncrement().catch(error => toast(error.message || '增量导入失败', 'error'));
            if (event.target.closest('#data-analysis-scale-partition')) void partitionDataset().catch(error => toast(error.message || '创建分区失败', 'error'));
            if (event.target.closest('#data-analysis-scale-materialization-save')) void saveMaterialization().catch(error => toast(error.message || '创建物化聚合失败', 'error'));
        });
    }

    Object.assign(app, { mountScalabilityPanel, renderScalability, loadScalability, bindScalabilityEvents });
})();
