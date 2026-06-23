(function () {
    const API = '/api/apps/data-analysis';
    const state = {
        datasets: [],
        activeId: '',
        compareLeftId: '',
        compareRightId: '',
        chart: null,
        summary: null,
        compare: null,
        artifacts: [],
        aiBusy: false
    };

    const html = window.PivotSafeHtml || {
        escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },
        escapeAttr(value) {
            return this.escapeHtml(value);
        }
    };

    function esc(value) {
        return html.escapeHtml(value);
    }

    function fmtNumber(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        return num.toLocaleString('zh-CN');
    }

    function fmtPercent(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        return `${(num * 100).toFixed(1)}%`;
    }

    // 统计量格式化：保留至多 2 位小数后本地化，避免浮点长尾。
    function fmtStat(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        return (Math.round(num * 100) / 100).toLocaleString('zh-CN');
    }

    function activeDataset() {
        return state.datasets.find(item => item.id === state.activeId) || state.datasets[0] || null;
    }

    function ensureView() {
        let view = document.getElementById('data-analysis-view');
        if (view) return view;
        const body = document.querySelector('.apps-workspace-body');
        if (!body) return null;
        view = document.createElement('div');
        view.id = 'data-analysis-view';
        view.className = 'data-analysis-view hidden';
        view.innerHTML = `
            <div class="workspace-panel data-analysis-panel">
                <aside class="data-analysis-sidebar">
                    <div class="data-analysis-upload">
                        <strong>数据集</strong>
                        <label class="data-analysis-upload-drop" for="data-analysis-file">
                            <input id="data-analysis-file" type="file" accept=".csv,.xlsx,.xls">
                            <span>上传 Excel / CSV</span>
                        </label>
                    </div>
                    <div id="data-analysis-dataset-list" class="data-analysis-dataset-list"></div>
                </aside>
                <main class="data-analysis-main">
                    <div class="data-analysis-toolbar">
                        <div>
                            <h4 id="data-analysis-title">数据分析</h4>
                            <span id="data-analysis-meta">请选择或上传数据集</span>
                        </div>
                        <div class="data-analysis-toolbar-actions">
                            <button id="data-analysis-refresh" class="btn-secondary" type="button">刷新</button>
                            <button id="data-analysis-export" class="btn-secondary" type="button">导出 CSV</button>
                            <button id="data-analysis-delete" class="btn-secondary" type="button">删除</button>
                        </div>
                    </div>
                    <div class="data-analysis-tabs" role="tablist" aria-label="数据分析视图">
                        <button class="data-analysis-tab active" type="button" data-data-analysis-tab="overview">总览</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="chart">图表</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="compare">比对</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="ai">AI 辅助</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="history">历史</button>
                    </div>
                    <section id="data-analysis-overview-panel" class="data-analysis-tab-panel">
                        <div id="data-analysis-kpis" class="data-analysis-kpis"></div>
                        <div class="data-analysis-split">
                            <section class="data-analysis-section">
                                <div class="data-analysis-section-head">
                                    <strong>字段画像</strong>
                                </div>
                                <div id="data-analysis-profile" class="data-analysis-profile"></div>
                            </section>
                            <section class="data-analysis-section">
                                <div class="data-analysis-section-head">
                                    <strong>数据预览</strong>
                                </div>
                                <div id="data-analysis-preview" class="data-analysis-preview"></div>
                            </section>
                        </div>
                    </section>
                    <section id="data-analysis-chart-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-form-grid">
                            <label>分类字段<select id="data-analysis-chart-x" class="form-input"></select></label>
                            <label>数值字段<select id="data-analysis-chart-y" class="form-input"></select></label>
                            <label>分组字段<select id="data-analysis-chart-group" class="form-input"></select></label>
                            <label>聚合<select id="data-analysis-chart-aggregation" class="form-input">
                                <option value="sum">求和</option>
                                <option value="count">计数</option>
                                <option value="avg">平均</option>
                                <option value="min">最小</option>
                                <option value="max">最大</option>
                            </select></label>
                            <label>图表<select id="data-analysis-chart-type" class="form-input">
                                <option value="bar">柱状图</option>
                                <option value="line">折线图</option>
                                <option value="area">面积图</option>
                                <option value="pie">饼图</option>
                            </select></label>
                            <button id="data-analysis-build-chart" class="btn-primary" type="button">生成图表</button>
                        </div>
                        <div id="data-analysis-chart-result" class="data-analysis-chart-result"></div>
                    </section>
                    <section id="data-analysis-compare-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-form-grid data-analysis-compare-controls">
                            <label>左侧数据集<select id="data-analysis-compare-left" class="form-input"></select></label>
                            <label>左侧主键<select id="data-analysis-compare-left-key" class="form-input"></select></label>
                            <label>右侧数据集<select id="data-analysis-compare-right" class="form-input"></select></label>
                            <label>右侧主键<select id="data-analysis-compare-right-key" class="form-input"></select></label>
                            <label>对比字段<select id="data-analysis-compare-field" class="form-input"></select></label>
                            <button id="data-analysis-run-compare" class="btn-primary" type="button">开始比对</button>
                        </div>
                        <div id="data-analysis-compare-result" class="data-analysis-compare-result"></div>
                    </section>
                    <section id="data-analysis-ai-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-ai-box">
                            <textarea id="data-analysis-ai-prompt" class="form-input" placeholder="询问这个数据集的分析方向、风险点、推荐图表或报告摘要"></textarea>
                            <button id="data-analysis-ai-run" class="btn-primary" type="button">生成建议</button>
                        </div>
                        <div id="data-analysis-ai-result" class="data-analysis-ai-result"></div>
                    </section>
                    <section id="data-analysis-history-panel" class="data-analysis-tab-panel hidden">
                        <div id="data-analysis-history-result" class="data-analysis-history-result"></div>
                    </section>
                </main>
            </div>
        `;
        body.appendChild(view);
        bindEvents(view);
        return view;
    }

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
            state.activeId = state.datasets[0]?.id || '';
        }
        if (!state.compareLeftId) state.compareLeftId = state.activeId;
        if (!state.compareRightId) state.compareRightId = state.datasets.find(item => item.id !== state.activeId)?.id || state.activeId;
        render();
        if (state.activeId) await loadDatasetDetail(state.activeId);
    }

    async function loadDatasetDetail(id) {
        const data = await fetchJson(`${API}/datasets/${encodeURIComponent(id)}`);
        const index = state.datasets.findIndex(item => item.id === id);
        if (index >= 0) state.datasets[index] = data.dataset;
        state.activeId = id;
        state.summary = null;
        state.chart = null;
        state.artifacts = [];
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
        renderDatasets();
        renderHeader();
        renderOverview();
        renderControls();
        renderChart();
        renderCompare();
    }

    function renderDatasets() {
        const list = document.getElementById('data-analysis-dataset-list');
        if (!list) return;
        if (!state.datasets.length) {
            list.innerHTML = '<div class="data-analysis-empty">还没有数据集</div>';
            return;
        }
        list.innerHTML = state.datasets.map(dataset => `
            <button class="data-analysis-dataset-item ${dataset.id === state.activeId ? 'active' : ''}" type="button" data-data-analysis-dataset="${esc(dataset.id)}">
                <strong>${esc(dataset.name)}</strong>
                <span>${fmtNumber(dataset.rowCount)} 行 / ${fmtNumber(dataset.columnCount)} 列</span>
                <small>${esc(dataset.originalName || '')}</small>
            </button>
        `).join('');
    }

    function renderHeader() {
        const dataset = activeDataset();
        const title = document.getElementById('data-analysis-title');
        const meta = document.getElementById('data-analysis-meta');
        const exportBtn = document.getElementById('data-analysis-export');
        const deleteBtn = document.getElementById('data-analysis-delete');
        if (title) title.textContent = dataset ? dataset.name : '数据分析';
        if (meta) {
            meta.textContent = dataset
                ? `${fmtNumber(dataset.rowCount)} 行 / ${fmtNumber(dataset.columnCount)} 列 / ${dataset.fileType || '表格'}`
                : '请选择或上传数据集';
        }
        if (exportBtn) exportBtn.disabled = !dataset;
        if (deleteBtn) deleteBtn.disabled = !dataset;
    }

    function renderOverview() {
        const dataset = activeDataset();
        const kpis = document.getElementById('data-analysis-kpis');
        const profile = document.getElementById('data-analysis-profile');
        const preview = document.getElementById('data-analysis-preview');
        if (!dataset) {
            if (kpis) kpis.innerHTML = '<div class="data-analysis-empty">上传数据后开始分析</div>';
            if (profile) profile.innerHTML = '';
            if (preview) preview.innerHTML = '';
            return;
        }
        const highlights = state.summary?.highlights || [];
        if (kpis) {
            kpis.innerHTML = [
                { label: '行数', value: fmtNumber(dataset.rowCount) },
                { label: '列数', value: fmtNumber(dataset.columnCount) },
                { label: '工作表', value: dataset.sheetName || '-' },
                { label: '提示', value: highlights[1] || '字段画像已生成' }
            ].map(item => `
                <div class="data-analysis-kpi">
                    <span>${esc(item.label)}</span>
                    <strong>${esc(item.value)}</strong>
                </div>
            `).join('');
        }
        if (profile) {
            const rows = dataset.profile || [];
            profile.innerHTML = rows.map(column => `
                <div class="data-analysis-profile-row">
                    <strong>${esc(column.name)}</strong>
                    <span>${esc(column.type)} · 填充 ${fmtPercent(column.fillRate)} · ${fmtNumber(column.distinct)} 类值</span>
                    ${column.numeric ? `<small class="data-analysis-profile-stats">中位数 ${fmtStat(column.numeric.median)} · 均值 ${fmtStat(column.numeric.avg)} · 标准差 ${fmtStat(column.numeric.stddev)} · 范围 ${fmtStat(column.numeric.min)}~${fmtStat(column.numeric.max)}</small>` : ''}
                    <em>${esc((column.samples || []).join(' / '))}</em>
                </div>
            `).join('') || '<div class="data-analysis-empty">暂无字段画像</div>';
        }
        if (preview) preview.innerHTML = buildTable(dataset.previewRows || [], dataset.columns || []);
    }

    function buildOptions(columns = [], { includeEmpty = false, emptyLabel = '无' } = {}) {
        const options = includeEmpty ? [`<option value="">${esc(emptyLabel)}</option>`] : [];
        columns.forEach(column => {
            options.push(`<option value="${esc(column.key)}">${esc(column.name)}</option>`);
        });
        return options.join('');
    }

    function setSelectOptions(id, htmlText, value) {
        const el = document.getElementById(id);
        if (!el) return;
        const previous = value !== undefined ? value : el.value;
        el.innerHTML = htmlText;
        if (previous && Array.from(el.options).some(option => option.value === previous)) el.value = previous;
    }

    function renderControls() {
        const dataset = activeDataset();
        const columns = dataset?.columns || [];
        const numeric = (dataset?.profile || []).filter(item => item.type === 'number').map(item => item.key);
        setSelectOptions('data-analysis-chart-x', buildOptions(columns), columns[0]?.key || '');
        setSelectOptions('data-analysis-chart-y', buildOptions(columns, { includeEmpty: true, emptyLabel: '计数' }), numeric[0] || '');
        setSelectOptions('data-analysis-chart-group', buildOptions(columns, { includeEmpty: true, emptyLabel: '不分组' }), '');
        const datasetOptions = state.datasets.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
        setSelectOptions('data-analysis-compare-left', datasetOptions, state.compareLeftId || state.activeId);
        setSelectOptions('data-analysis-compare-right', datasetOptions, state.compareRightId);
        renderCompareKeyOptions();
    }

    function renderCompareKeyOptions() {
        const left = state.datasets.find(item => item.id === document.getElementById('data-analysis-compare-left')?.value) || activeDataset();
        const right = state.datasets.find(item => item.id === document.getElementById('data-analysis-compare-right')?.value) || state.datasets[0];
        setSelectOptions('data-analysis-compare-left-key', buildOptions(left?.columns || []), left?.columns?.[0]?.key || '');
        setSelectOptions('data-analysis-compare-right-key', buildOptions(right?.columns || []), right?.columns?.[0]?.key || '');
        setSelectOptions('data-analysis-compare-field', buildOptions(left?.columns || [], { includeEmpty: true, emptyLabel: '只比对主键存在性' }), '');
    }

    function buildTable(rows = [], columns = []) {
        if (!rows.length || !columns.length) return '<div class="data-analysis-empty">暂无预览数据</div>';
        return `
            <table>
                <thead><tr>${columns.map(column => `<th>${esc(column.name)}</th>`).join('')}</tr></thead>
                <tbody>
                    ${rows.slice(0, 80).map(row => `
                        <tr>${columns.map(column => `<td>${esc(row[column.key] ?? '')}</td>`).join('')}</tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    async function buildChart() {
        const dataset = activeDataset();
        if (!dataset) return;
        await guardButton('data-analysis-build-chart', '生成中…', async () => {
            const payload = {
                xField: document.getElementById('data-analysis-chart-x')?.value || '',
                yField: document.getElementById('data-analysis-chart-y')?.value || '',
                groupField: document.getElementById('data-analysis-chart-group')?.value || '',
                aggregation: document.getElementById('data-analysis-chart-aggregation')?.value || 'sum',
                chartType: document.getElementById('data-analysis-chart-type')?.value || 'bar'
            };
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/chart`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            state.chart = data.chart;
            renderChart();
        });
    }

    function renderChart() {
        const box = document.getElementById('data-analysis-chart-result');
        if (!box) return;
        if (!state.chart) {
            const suggestions = state.summary?.suggestions || [];
            box.innerHTML = suggestions.length ? `
                <div class="data-analysis-suggestions">
                    ${suggestions.map((item, index) => `
                        <button type="button" data-data-analysis-chart-suggestion="${index}">
                            <strong>${esc(item.title)}</strong>
                            <span>${esc(item.chartType)} / ${esc(item.aggregation)}</span>
                        </button>
                    `).join('')}
                </div>
            ` : '<div class="data-analysis-empty">选择字段后生成图表</div>';
            return;
        }
        box.innerHTML = `
            <div class="pivot-echart-block" data-pivot-echart="${html.escapeAttr(JSON.stringify(state.chart))}">
                <div class="pivot-echart-title">图表预览</div>
                <div class="pivot-echart-canvas"></div>
                <canvas height="300"></canvas>
                <pre class="pivot-echart-error-text"></pre>
            </div>
        `;
        window.renderPivotCharts?.(box);
    }

    async function runCompare() {
        await guardButton('data-analysis-run-compare', '比对中…', async () => {
            const payload = {
                leftDatasetId: document.getElementById('data-analysis-compare-left')?.value || '',
                rightDatasetId: document.getElementById('data-analysis-compare-right')?.value || '',
                leftKey: document.getElementById('data-analysis-compare-left-key')?.value || '',
                rightKey: document.getElementById('data-analysis-compare-right-key')?.value || '',
                compareField: document.getElementById('data-analysis-compare-field')?.value || ''
            };
            const data = await fetchJson(`${API}/compare`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            state.compare = data;
            renderCompare();
        });
    }

    function renderCompare() {
        const box = document.getElementById('data-analysis-compare-result');
        if (!box) return;
        if (!state.compare) {
            box.innerHTML = '<div class="data-analysis-empty">选择两个数据集和主键后开始比对</div>';
            return;
        }
        const result = state.compare;
        box.innerHTML = `
            <div class="data-analysis-compare-kpis">
                <div><span>匹配主键</span><strong>${fmtNumber(result.matched)}</strong></div>
                <div><span>仅左侧存在</span><strong>${fmtNumber(result.onlyLeft?.length || 0)}</strong></div>
                <div><span>仅右侧存在</span><strong>${fmtNumber(result.onlyRight?.length || 0)}</strong></div>
                <div><span>字段差异</span><strong>${fmtNumber(result.changed?.length || 0)}</strong></div>
            </div>
            ${renderDuplicateKeys(result)}
            <div class="data-analysis-compare-lists">
                ${renderCompareList('仅左侧存在', result.onlyLeft)}
                ${renderCompareList('仅右侧存在', result.onlyRight)}
                ${renderChangedList(result.changed)}
            </div>
        `;
    }

    function renderDuplicateKeys(result = {}) {
        const left = result.duplicateLeft || [];
        const right = result.duplicateRight || [];
        if (!left.length && !right.length) return '';
        const renderItems = rows => rows.slice(0, 12).map(row => `<span>${esc(row.key)} (${fmtNumber(row.count)})</span>`).join('');
        return `
            <div class="data-analysis-compare-warning">
                <strong>主键存在重复值，已按主键聚合后比对</strong>
                <div>
                    ${left.length ? `<section><em>左侧重复</em>${renderItems(left)}</section>` : ''}
                    ${right.length ? `<section><em>右侧重复</em>${renderItems(right)}</section>` : ''}
                </div>
            </div>
        `;
    }

    function renderCompareList(title, rows = []) {
        return `
            <section>
                <strong>${esc(title)}</strong>
                <div>${rows.slice(0, 30).map(row => `<span>${esc(row.key)}</span>`).join('') || '<em>无</em>'}</div>
            </section>
        `;
    }

    function renderChangedList(rows = []) {
        return `
            <section>
                <strong>字段差异</strong>
                <div>${rows.slice(0, 30).map(row => `
                    <span>${esc(row.key)}：${esc(row.leftValue)} → ${esc(row.rightValue)}</span>
                `).join('') || '<em>无</em>'}</div>
            </section>
        `;
    }

    async function loadArtifacts() {
        const dataset = activeDataset();
        const box = document.getElementById('data-analysis-history-result');
        if (!dataset) {
            state.artifacts = [];
            renderHistory();
            return;
        }
        if (box) box.innerHTML = '<div class="data-analysis-empty">加载中…</div>';
        try {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/artifacts?limit=30`);
            state.artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
            renderHistory();
        } catch (e) {
            state.artifacts = [];
            if (box) box.innerHTML = `<div class="data-analysis-empty">历史加载失败：${esc(e && e.message ? e.message : '请稍后重试')}</div>`;
        }
    }

    function renderHistory() {
        const box = document.getElementById('data-analysis-history-result');
        if (!box) return;
        const items = state.artifacts || [];
        if (!items.length) {
            box.innerHTML = '<div class="data-analysis-empty">暂无历史记录，生成图表 / 比对 / 导出后会显示在这里</div>';
            return;
        }
        const typeLabel = { chart: '图表', comparison: '比对', export: '导出' };
        box.innerHTML = items.map((item, index) => {
            const clickable = item.type === 'chart' && item.chart;
            const attrs = clickable ? `data-data-analysis-history="${index}" role="button" tabindex="0"` : '';
            return `
                <div class="data-analysis-history-item${clickable ? ' is-chart' : ''}" ${attrs}>
                    <span class="data-analysis-history-type data-analysis-history-type-${esc(item.type)}">${esc(typeLabel[item.type] || item.type)}</span>
                    <strong>${esc(item.title)}</strong>
                    <small>${esc(item.createdAt || '')}${clickable ? ' · 点击重新查看' : ''}</small>
                </div>
            `;
        }).join('');
    }

    async function runAi() {
        const dataset = activeDataset();
        const prompt = document.getElementById('data-analysis-ai-prompt')?.value.trim();
        if (!dataset || !prompt) {
            toast('请选择数据集并输入问题', 'warning');
            return;
        }
        if (state.aiBusy) return;
        const result = document.getElementById('data-analysis-ai-result');
        const model = document.getElementById('model-selector')?.value || '';
        // 环境支持时走 SSE 流式逐字输出，否则回退一次性请求。
        const useStream = typeof createBrowserSseParser === 'function' && typeof apiFetch === 'function';
        state.aiBusy = true;
        if (result) result.textContent = 'AI 正在分析...';
        await guardButton('data-analysis-ai-run', '分析中…', async () => {
            try {
                if (!useStream) {
                    const data = await fetchJson(`${API}/ai`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ datasetId: dataset.id, prompt, model })
                    });
                    if (result) result.textContent = data.content || 'AI 未返回有效内容';
                    return;
                }
                const res = await apiFetch(`${API}/ai`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                    body: JSON.stringify({ datasetId: dataset.id, prompt, model, stream: true })
                });
                if (!res.ok || !res.body) {
                    const data = await res.clone().json().catch(() => ({}));
                    throw new Error(data?.error?.message || `AI 请求失败（${res.status}）`);
                }
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let full = '';
                const parser = createBrowserSseParser({
                    onData(p) {
                        let data = null;
                        try { data = JSON.parse(p); } catch (_e) { return; }
                        const chunk = data?.content ?? data?.choices?.[0]?.delta?.content ?? '';
                        if (chunk) {
                            full += chunk;
                            if (result) result.textContent = full;
                        }
                    }
                });
                while (!parser.isDone()) {
                    const { done, value } = await reader.read();
                    if (done) {
                        parser.write(decoder.decode());
                        parser.end();
                        break;
                    }
                    parser.write(decoder.decode(value, { stream: true }));
                }
                if (result) result.textContent = full.trim() || 'AI 未返回有效内容';
            } catch (e) {
                if (result) result.textContent = `AI 分析失败：${e && e.message ? e.message : '请稍后重试'}`;
                toast(e && e.message ? e.message : 'AI 分析失败', 'error');
            } finally {
                state.aiBusy = false;
            }
        });
    }

    function activateTab(tab) {
        document.querySelectorAll('.data-analysis-tab').forEach(button => {
            button.classList.toggle('active', button.dataset.dataAnalysisTab === tab);
        });
        document.querySelectorAll('.data-analysis-tab-panel').forEach(panel => {
            panel.classList.toggle('hidden', panel.id !== `data-analysis-${tab}-panel`);
        });
    }

    function bindEvents(root) {
        root.addEventListener('change', event => {
            if (event.target?.id === 'data-analysis-file') {
                uploadDataset(event.target.files?.[0]);
                event.target.value = '';
                return;
            }
            if (['data-analysis-compare-left', 'data-analysis-compare-right'].includes(event.target?.id)) {
                renderCompareKeyOptions();
            }
        });
        root.addEventListener('click', async event => {
            const datasetBtn = event.target.closest('[data-data-analysis-dataset]');
            if (datasetBtn) {
                await loadDatasetDetail(datasetBtn.dataset.dataAnalysisDataset);
                return;
            }
            const tab = event.target.closest('[data-data-analysis-tab]');
            if (tab) {
                const name = tab.dataset.dataAnalysisTab;
                activateTab(name);
                if (name === 'history') loadArtifacts();
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
                    await buildChart();
                }
                return;
            }
            if (event.target.closest('#data-analysis-refresh')) {
                await loadDatasets({ keepActive: true });
                return;
            }
            if (event.target.closest('#data-analysis-build-chart')) {
                await buildChart();
                return;
            }
            if (event.target.closest('#data-analysis-run-compare')) {
                await runCompare();
                return;
            }
            if (event.target.closest('#data-analysis-ai-run')) {
                await runAi();
                return;
            }
            if (event.target.closest('#data-analysis-export')) {
                const dataset = activeDataset();
                if (dataset) window.location.href = `${API}/datasets/${encodeURIComponent(dataset.id)}/export.csv`;
                return;
            }
            if (event.target.closest('#data-analysis-delete')) {
                const dataset = activeDataset();
                if (!dataset || !confirm(`删除数据集「${dataset.name}」？`)) return;
                await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}`, { method: 'DELETE' });
                state.activeId = '';
                await loadDatasets({ keepActive: false });
            }
        });
    }

    window.showDataAnalysisApp = async function () {
        const view = ensureView();
        if (!view) return;
        sessionStorage.setItem('pivot_apps_active_app', 'data-analysis');
        document.getElementById('apps-home-view')?.classList.add('hidden');
        document.getElementById('official-writing-view')?.classList.add('hidden');
        view.classList.remove('hidden');
        document.getElementById('apps-back-btn')?.classList.remove('hidden');
        if (typeof setAppsTitle === 'function') {
            setAppsTitle('数据分析', '上传表格数据，完成字段画像、数据比对、统计分析、图表生成和 AI 辅助洞察。');
        }
        await loadDatasets({ keepActive: true });
    };
})();
