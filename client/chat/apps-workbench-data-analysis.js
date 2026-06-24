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
        query: null,
        pivot: null,
        artifacts: [],
        overviewPage: 1,
        overviewPageSize: 10,
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
                    <nav class="data-analysis-tabs" role="tablist" aria-label="数据分析视图" aria-orientation="vertical">
                        <button class="data-analysis-tab active" type="button" data-data-analysis-tab="overview">数据总览</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="chart">图表生成</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="compare">数据比对</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="query">数据查询</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="pivot">数据透视</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="ai">AI辅助</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="history">历史记录</button>
                    </nav>
                </aside>
                <main class="data-analysis-main">
                    <div class="data-analysis-toolbar">
                        <div>
                            <h4 id="data-analysis-title">数据分析</h4>
                            <span id="data-analysis-meta">请选择或上传数据集</span>
                        </div>
                        <div class="data-analysis-toolbar-actions"></div>
                    </div>

                    <section id="data-analysis-overview-panel" class="data-analysis-tab-panel">
                        <div class="table-container workspace-table-wrap data-analysis-dataset-table-wrap">
                            <table class="data-table compact-table data-analysis-dataset-table">
                                <colgroup>
                                    <col class="col-index">
                                    <col class="col-name">
                                    <col class="col-source">
                                    <col class="col-size">
                                    <col class="col-type">
                                    <col class="col-created">
                                    <col class="col-actions">
                                </colgroup>
                                <thead>
                                    <tr>
                                        <th class="col-index text-center">序号</th>
                                        <th>数据集名称</th>
                                        <th>原始文件名</th>
                                        <th class="col-size">数据大小</th>
                                        <th class="col-type">文件类型</th>
                                        <th class="col-created">导入时间</th>
                                        <th class="col-actions text-center">操作</th>
                                    </tr>
                                </thead>
                                <tbody id="data-analysis-dataset-table-body">
                                    <!-- 动态渲染数据集列表 -->
                                </tbody>
                            </table>
                        </div>
                        <div id="data-analysis-dataset-pagination" class="pagination workspace-pagination"></div>
                    </section>
                    <section id="data-analysis-chart-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-form-grid data-analysis-chart-controls">
                            <label>分析数据集<select id="data-analysis-chart-dataset" class="form-input"></select></label>
                            <label>分类字段<select id="data-analysis-chart-x" class="form-input"></select></label>
                            <label>数值字段<select id="data-analysis-chart-y" class="form-input"></select></label>
                            <label data-data-analysis-chart-control="group">分组字段<select id="data-analysis-chart-group" class="form-input"></select></label>
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
                            <label>显示前几位<input id="data-analysis-chart-limit" class="form-input" type="number" min="1" max="80" value="30"></label>
                            <label>排序<select id="data-analysis-chart-sort" class="form-input">
                                <option value="value_desc">数值降序</option>
                                <option value="value_asc">数值升序</option>
                                <option value="label_asc">分类升序</option>
                                <option value="label_desc">分类降序</option>
                            </select></label>
                            <label>配色<select id="data-analysis-chart-palette" class="form-input">
                                <option value="teal">经典青绿</option>
                                <option value="business">商务蓝绿</option>
                                <option value="soft">柔和多彩</option>
                                <option value="warm">暖色强调</option>
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
                    <section id="data-analysis-query-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-form-grid data-analysis-query-controls" style="margin-bottom: 8px;">
                            <label>分析数据集<select id="data-analysis-query-dataset" class="form-input"></select></label>
                        </div>
                        <div class="data-analysis-query-box">
                            <div id="data-analysis-query-fields" class="data-analysis-query-fields"></div>
                            <textarea id="data-analysis-query-sql" class="form-input data-analysis-query-sql" spellcheck="false" placeholder="SELECT * FROM data LIMIT 100"></textarea>
                            <div class="data-analysis-query-actions">
                                <span class="data-analysis-query-hint">只读查询，表名固定为 <code>data</code>，列名为字段名。</span>
                                <button id="data-analysis-run-query" class="btn-primary" type="button">运行查询</button>
                            </div>
                        </div>
                        <div id="data-analysis-query-result" class="data-analysis-query-result"></div>
                    </section>
                    <section id="data-analysis-pivot-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-form-grid data-analysis-pivot-controls">
                            <label>分析数据集<select id="data-analysis-pivot-dataset" class="form-input"></select></label>
                            <label>行维度<select id="data-analysis-pivot-row" class="form-input"></select></label>
                            <label>列维度<select id="data-analysis-pivot-col" class="form-input"></select></label>
                            <label>值字段<select id="data-analysis-pivot-value" class="form-input"></select></label>
                            <label>聚合<select id="data-analysis-pivot-aggregation" class="form-input">
                                <option value="sum">求和</option>
                                <option value="count">计数</option>
                                <option value="avg">平均</option>
                                <option value="min">最小</option>
                                <option value="max">最大</option>
                            </select></label>
                            <button id="data-analysis-run-pivot" class="btn-primary" type="button">生成透视表</button>
                        </div>
                        <div id="data-analysis-pivot-result" class="data-analysis-pivot-result"></div>
                    </section>
                    <section id="data-analysis-ai-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-form-grid data-analysis-ai-controls" style="margin-bottom: 8px;">
                            <label>分析数据集<select id="data-analysis-ai-dataset" class="form-input"></select></label>
                        </div>
                        <div class="data-analysis-ai-box">
                            <textarea id="data-analysis-ai-prompt" class="form-input" placeholder="询问这个数据集的分析方向、风险点、推荐图表或报告摘要"></textarea>
                            <div class="data-analysis-ai-actions">
                                <label class="data-analysis-ai-toggle"><input type="checkbox" id="data-analysis-ai-deep"> 深度分析（可查询数据 / 生成图表）</label>
                                <button id="data-analysis-ai-run" class="btn-primary" type="button">生成建议</button>
                            </div>
                        </div>
                        <div id="data-analysis-ai-result" class="data-analysis-ai-result"></div>
                    </section>

                    <section id="data-analysis-history-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-form-grid data-analysis-history-controls" style="margin-bottom: 8px;">
                            <label>分析数据集<select id="data-analysis-history-dataset" class="form-input"></select></label>
                        </div>
                        <div id="data-analysis-history-result" class="data-analysis-history-result"></div>
                    </section>
                </main>
            </div>

            <!-- 数据预览模态弹窗 -->
            <div id="data-analysis-preview-modal" class="modal-overlay hidden" style="z-index: 8000;">
                <div class="modal" style="width: min(1000px, 92vw); max-height: 85vh; display: flex; flex-direction: column; padding: 24px; border-radius: 12px; background: rgba(255, 255, 255, 0.98);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); padding-bottom: 10px;">
                        <h3 id="data-analysis-preview-modal-title" style="margin: 0; font-size: 1.05rem; font-weight: 800; color: var(--text-main);">数据集数据预览</h3>
                        <button id="data-analysis-preview-modal-close" class="btn-secondary" style="height: 32px; padding: 0 12px; border-radius: 7px; font-size: 0.8rem; border-color: rgba(239, 68, 68, 0.35); color: var(--danger); font-weight: 700; cursor: pointer;" type="button">关闭</button>
                    </div>
                    <div id="data-analysis-preview-modal-content" class="data-analysis-preview" style="flex: 1; overflow: auto; min-height: 0;">
                    </div>
                </div>
            </div>

            <!-- 数据库导入模态弹窗 -->
            <div id="data-analysis-db-import-modal" class="modal-overlay hidden" style="z-index: 8000;">
                <div class="modal" style="width: min(500px, 92vw); max-height: 85vh; display: flex; flex-direction: column; padding: 24px; border-radius: 12px; background: rgba(255, 255, 255, 0.98); box-shadow: 0 20px 40px rgba(0,0,0,0.15); border: 1px solid rgba(148, 163, 184, 0.2);">
                    <div style="display: flex; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); padding-bottom: 10px;">
                        <h3 style="margin: 0; font-size: 1.05rem; font-weight: 800; color: var(--text-main);">从数据库导入数据集</h3>
                    </div>
                    <form id="data-analysis-db-import-form" style="display: flex; flex-direction: column; gap: 14px; overflow: auto; padding: 4px; text-align: left;">
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 0.82rem; font-weight: 700; color: var(--text-main);">数据库连接</label>
                            <select id="data-analysis-db-conn" class="form-input" style="width: 100%; height: 38px; border-radius: 8px; font-size: 0.85rem; padding: 0 10px; margin-bottom: 0;" required></select>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 0.82rem; font-weight: 700; color: var(--text-main);">只读 SQL 查询 (可选)</label>
                            <textarea id="data-analysis-db-sql" class="form-input" style="width: 100%; height: 75px; font-family: monospace; border-radius: 8px; font-size: 0.85rem; padding: 8px 12px; margin-bottom: 0; resize: vertical;" placeholder="例如: SELECT * FROM my_table LIMIT 100 (留空则从下方表名导入)"></textarea>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 0.82rem; font-weight: 700; color: var(--text-main);">数据表名 (若未填写 SQL 查询)</label>
                            <input id="data-analysis-db-table" class="form-input" type="text" style="width: 100%; height: 38px; border-radius: 8px; font-size: 0.85rem; padding: 0 12px; margin-bottom: 0;" placeholder="例如: my_table">
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 0.82rem; font-weight: 700; color: var(--text-main);">导入后的数据集名称 (可选)</label>
                            <input id="data-analysis-db-name" class="form-input" type="text" style="width: 100%; height: 38px; border-radius: 8px; font-size: 0.85rem; padding: 0 12px; margin-bottom: 0;" placeholder="留空则自动生成名称">
                        </div>
                        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px; border-top: 1px solid rgba(148, 163, 184, 0.16); padding-top: 12px;">
                            <button id="data-analysis-db-import-modal-cancel" class="btn-secondary" style="height: 34px; padding: 0 14px; border-radius: 8px; font-size: 0.8rem; cursor: pointer;" type="button">取消</button>
                            <button id="data-analysis-db-import-submit" class="btn-primary" style="height: 34px; padding: 0 14px; border-radius: 8px; font-size: 0.8rem; font-weight: 700; cursor: pointer;" type="button">开始导入</button>
                        </div>
                    </form>
                </div>
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
        state.query = null;
        state.pivot = null;
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
        renderHeader();
        renderOverview();
        renderControls();
        renderChart();
        renderCompare();
        renderQueryFields();
        renderPivotControls();
    }

    function updateToolbarHeader(tab) {
        const titleEl = document.getElementById('data-analysis-title');
        const metaEl = document.getElementById('data-analysis-meta');
        const actionsEl = document.querySelector('.data-analysis-toolbar-actions');
        if (!titleEl || !metaEl) return;

        const headers = {
            overview: {
                title: '\u6570\u636e\u603b\u89c8',
                desc: '\u4e0a\u4f20\u8868\u683c\u6570\u636e\uff0c\u5bfc\u5165\u6570\u636e\u96c6\uff0c\u5e76\u5bf9\u6570\u636e\u96c6\u8fdb\u884c\u9884\u89c8\u548c\u7ba1\u7406\u3002'
            },
            chart: {
                title: '图表生成',
                desc: '选择分类与数值字段，自适应聚合生成柱状图、折线图、面积图或饼图。'
            },
            compare: {
                title: '数据比对',
                desc: '选择两个不同的数据集及对应主键，进行存在性比对与字段差异分析。'
            },
            query: {
                title: '数据查询',
                desc: '使用只读 SQL 语句对当前数据集进行自定义数据查询与高级筛选。'
            },
            pivot: {
                title: '数据透视',
                desc: '配置行维度、列维度及值字段对数据进行多维交叉聚合与透视分析。'
            },
            ai: {
                title: 'AI辅助',
                desc: '调用大语言模型智能分析数据集，提供分析方向、推荐图表与报告摘要等深度洞察。'
            },
            history: {
                title: '历史记录',
                desc: '查看当前数据集在图表生成、数据比对、导出和 SQL 查询中的历史记录。'
            }
        };

        const header = headers[tab] || headers.overview;
        titleEl.textContent = header.title;
        metaEl.textContent = header.desc;
        if (actionsEl) {
            actionsEl.innerHTML = tab === 'overview' ? `
                <label class="btn-secondary data-analysis-upload-action">
                    <input id="data-analysis-file" type="file" accept=".csv,.xlsx,.xls">
                    <span>\u4e0a\u4f20 Excel / CSV</span>
                </label>
                <button id="data-analysis-import-db" class="btn-secondary" type="button">\u4ece\u6570\u636e\u5e93\u5bfc\u5165</button>
                <button id="data-analysis-overview-refresh" class="btn-secondary" type="button">\u5237\u65b0\u5217\u8868</button>
            ` : '';
        }
    }

    function renderHeader() {
        const activeTabEl = document.querySelector('.data-analysis-tab.active');
        const activeTabName = activeTabEl?.dataset.dataAnalysisTab || 'overview';
        updateToolbarHeader(activeTabName);
    }

    function renderOverview() {
        const body = document.getElementById('data-analysis-dataset-table-body');
        const pager = document.getElementById('data-analysis-dataset-pagination');
        if (!body) return;
        const total = state.datasets.length;
        const pageSize = Math.max(Number(state.overviewPageSize) || 10, 1);
        const pageCount = Math.max(Math.ceil(total / pageSize), 1);
        state.overviewPage = Math.min(Math.max(Number(state.overviewPage) || 1, 1), pageCount);
        if (!total) {
            body.innerHTML = '<tr><td colspan="7" class="text-center data-analysis-empty-cell">\u6682\u65e0\u6570\u636e\u96c6\uff0c\u8bf7\u4e0a\u4f20\u6216\u5bfc\u5165\u3002</td></tr>';
            if (pager) pager.innerHTML = '';
            return;
        }
        const startIndex = (state.overviewPage - 1) * pageSize;
        const pageRows = state.datasets.slice(startIndex, startIndex + pageSize);
        body.innerHTML = pageRows.map((dataset, offset) => {
            const rowIndex = startIndex + offset;
            return (
                '<tr>' +
                    '<td class="text-center data-analysis-row-index">' + (rowIndex + 1) + '</td>' +
                    '<td class="data-analysis-dataset-name">' + esc(dataset.name) + '</td>' +
                    '<td class="data-analysis-break-text">' + esc(dataset.originalName || '-') + '</td>' +
                    '<td>' + fmtNumber(dataset.rowCount) + ' \u884c / ' + fmtNumber(dataset.columnCount) + ' \u5217</td>' +
                    '<td><span class="data-analysis-file-type">' + esc(dataset.fileType || '\u8868\u683c') + '</span></td>' +
                    '<td class="data-analysis-muted-cell">' + esc(dataset.createdAt || '-') + '</td>' +
                    '<td class="text-center"><div class="data-analysis-table-actions">' +
                        '<button class="btn-secondary data-analysis-table-btn" type="button" data-data-analysis-action-preview="' + esc(dataset.id) + '">\u9884\u89c8</button>' +
                        '<button class="btn-secondary data-analysis-table-btn" type="button" data-data-analysis-action-export="' + esc(dataset.id) + '">\u5bfc\u51fa</button>' +
                        '<button class="btn-secondary data-analysis-table-btn is-danger" type="button" data-data-analysis-action-delete="' + esc(dataset.id) + '">\u5220\u9664</button>' +
                    '</div></td>' +
                '</tr>'
            );
        }).join('');
        if (!pager) return;
        if (typeof window.renderWorkspacePagination === 'function') {
            window.renderWorkspacePagination(pager, {
                total,
                page: state.overviewPage,
                limit: pageSize,
                onPageChange: targetPage => {
                    state.overviewPage = targetPage;
                    renderOverview();
                }
            });
            return;
        }
        pager.innerHTML = '';
    }

    async function previewDataset(id) {
        let dataset = state.datasets.find(item => item.id === id);
        if (!dataset || !dataset.previewRows) {
            setBusy(true, '正在加载预览数据...');
            try {
                const data = await fetchJson(`${API}/datasets/${encodeURIComponent(id)}`);
                const index = state.datasets.findIndex(item => item.id === id);
                if (index >= 0) {
                    state.datasets[index] = data.dataset;
                    dataset = data.dataset;
                }
            } catch (e) {
                toast(e && e.message ? e.message : '预览数据加载失败', 'error');
                return;
            } finally {
                setBusy(false);
            }
        }
        if (dataset) {
            const modal = document.getElementById('data-analysis-preview-modal');
            const title = document.getElementById('data-analysis-preview-modal-title');
            const content = document.getElementById('data-analysis-preview-modal-content');
            if (modal && content && title) {
                title.textContent = `数据预览 - ${dataset.name}`;
                content.innerHTML = buildTable(dataset.previewRows || [], dataset.columns || []);
                modal.classList.remove('hidden');
            }
        }
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

    function chartNumericFields(dataset = activeDataset()) {
        return (dataset?.profile || []).filter(item => item.type === 'number').map(item => item.key);
    }

    function selectHasOption(select, value) {
        return Array.from(select?.options || []).some(option => option.value === value);
    }

    function syncChartAggregationControls(source = 'auto', notify = false) {
        const yEl = document.getElementById('data-analysis-chart-y');
        const aggregationEl = document.getElementById('data-analysis-chart-aggregation');
        if (!yEl || !aggregationEl) return;
        const aggregation = aggregationEl.value || 'sum';
        if (yEl.value || aggregation === 'count') return;

        if (source === 'aggregation') {
            const fallback = chartNumericFields().find(key => selectHasOption(yEl, key));
            if (fallback) {
                yEl.value = fallback;
                return;
            }
        }

        aggregationEl.value = 'count';
        if (notify) toast('未选择数值字段，已自动切换为计数。', 'warning');
    }

    function syncChartTypeControls(source = 'auto') {
        const typeEl = document.getElementById('data-analysis-chart-type');
        const groupEl = document.getElementById('data-analysis-chart-group');
        const sortEl = document.getElementById('data-analysis-chart-sort');
        const groupControl = document.querySelector('[data-data-analysis-chart-control="group"]');
        const chartType = typeEl?.value || 'bar';
        const isPie = chartType === 'pie';
        groupControl?.classList.toggle('hidden', isPie);
        if (isPie && groupEl) groupEl.value = '';
        if (!sortEl || !['auto', 'type'].includes(source)) return;

        const isTrendChart = chartType === 'line' || chartType === 'area';
        if (isTrendChart && ['value_desc', 'value_asc'].includes(sortEl.value)) {
            sortEl.value = 'label_asc';
        } else if (!isTrendChart && ['label_asc', 'label_desc'].includes(sortEl.value)) {
            sortEl.value = 'value_desc';
        }
    }
    function renderControls() {
        const dataset = activeDataset();
        const columns = dataset?.columns || [];
        const numeric = chartNumericFields(dataset);
        setSelectOptions('data-analysis-chart-x', buildOptions(columns), columns[0]?.key || '');
        setSelectOptions('data-analysis-chart-y', buildOptions(columns, { includeEmpty: true, emptyLabel: '计数' }), numeric[0] || '');
        setSelectOptions('data-analysis-chart-group', buildOptions(columns, { includeEmpty: true, emptyLabel: '不分组' }), '');
        syncChartAggregationControls('auto');
        syncChartTypeControls('auto');
        const datasetOptions = state.datasets.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
        setSelectOptions('data-analysis-compare-left', datasetOptions, state.compareLeftId || state.activeId);
        setSelectOptions('data-analysis-compare-right', datasetOptions, state.compareRightId);
        renderCompareKeyOptions();

        // 渲染各个具体分析页面的数据集选择框
        setSelectOptions('data-analysis-chart-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-query-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-pivot-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-ai-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-history-dataset', datasetOptions, state.activeId);
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
            <table class="data-table compact-table data-analysis-result-table">
                <thead><tr>${columns.map(column => `<th>${esc(column.name)}</th>`).join('')}</tr></thead>
                <tbody>
                    ${rows.slice(0, 80).map(row => `
                        <tr>${columns.map(column => `<td>${esc(row[column.key] ?? '')}</td>`).join('')}</tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    // 通用表渲染：columns 为列名字符串数组，rows 为按列名取值的对象数组。
    function buildTableFromRows(columns = [], rows = []) {
        if (!columns.length) return '<div class="data-analysis-empty">无结果</div>';
        return `
            <table class="data-table compact-table data-analysis-result-table">
                <thead><tr>${columns.map(name => `<th>${esc(name)}</th>`).join('')}</tr></thead>
                <tbody>
                    ${rows.slice(0, 5000).map(row => `
                        <tr>${columns.map(name => `<td>${esc(row[name] ?? '')}</td>`).join('')}</tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    function renderQueryFields() {
        const box = document.getElementById('data-analysis-query-fields');
        if (!box) return;
        const dataset = activeDataset();
        const columns = dataset?.columns || [];
        if (!columns.length) {
            box.innerHTML = '';
            return;
        }
        box.innerHTML = `<span class="data-analysis-query-fields-label">可用字段：</span>${columns.map(column => `<button type="button" class="data-analysis-query-field" data-data-analysis-query-field="${esc(column.name)}">${esc(column.name)}</button>`).join('')}`;
    }

    async function runQuery() {
        const dataset = activeDataset();
        if (!dataset) {
            toast('请先选择数据集', 'warning');
            return;
        }
        const sql = document.getElementById('data-analysis-query-sql')?.value.trim();
        if (!sql) {
            toast('请输入查询语句', 'warning');
            return;
        }
        await guardButton('data-analysis-run-query', '查询中…', async () => {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql })
            });
            state.query = data;
            renderQuery();
        });
    }

    function renderQuery() {
        const box = document.getElementById('data-analysis-query-result');
        if (!box) return;
        if (!state.query) {
            box.innerHTML = '<div class="data-analysis-empty">编写并运行查询后在此查看结果</div>';
            return;
        }
        const result = state.query;
        box.innerHTML = `
            <div class="data-analysis-query-meta">返回 ${fmtNumber(result.rowCount)} 行${result.truncated ? `（已截断至前 ${fmtNumber(result.rowCount)} 行）` : ''}</div>
            <div class="data-analysis-query-table" style="margin-bottom: 12px;">${buildTableFromRows(result.columns || [], result.rows || [])}</div>
            <div style="display: flex; justify-content: flex-end;">
                <button id="data-analysis-query-export-btn" class="btn-secondary" type="button" style="height: 30px; padding: 0 12px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; border: 1px solid rgba(148, 163, 184, 0.3); cursor: pointer;">导出查询结果 (CSV)</button>
            </div>
        `;
    }

    function renderPivotControls() {
        const dataset = activeDataset();
        const columns = dataset?.columns || [];
        const numeric = (dataset?.profile || []).filter(item => item.type === 'number').map(item => item.key);
        setSelectOptions('data-analysis-pivot-row', buildOptions(columns), columns[0]?.key || '');
        setSelectOptions('data-analysis-pivot-col', buildOptions(columns, { includeEmpty: true, emptyLabel: '不分列' }), '');
        setSelectOptions('data-analysis-pivot-value', buildOptions(columns, { includeEmpty: true, emptyLabel: '计数' }), numeric[0] || '');
    }

    async function runPivot() {
        const dataset = activeDataset();
        if (!dataset) {
            toast('请先选择数据集', 'warning');
            return;
        }
        await guardButton('data-analysis-run-pivot', '生成中…', async () => {
            const payload = {
                rowField: document.getElementById('data-analysis-pivot-row')?.value || '',
                colField: document.getElementById('data-analysis-pivot-col')?.value || '',
                valueField: document.getElementById('data-analysis-pivot-value')?.value || '',
                aggregation: document.getElementById('data-analysis-pivot-aggregation')?.value || 'sum'
            };
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/pivot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            state.pivot = data;
            renderPivot();
        });
    }

    function renderPivot() {
        const box = document.getElementById('data-analysis-pivot-result');
        if (!box) return;
        const result = state.pivot;
        if (!result) {
            box.innerHTML = '<div class="data-analysis-empty">选择行维度、列维度与值后生成透视表</div>';
            return;
        }
        const cols = result.columns || [];
        const head = `<tr><th>${esc(result.rowField?.name || '行')}</th>${cols.map(col => `<th>${esc(col)}</th>`).join('')}<th>合计</th></tr>`;
        const body = (result.rows || []).map(row => `
            <tr>
                <th>${esc(row.label)}</th>
                ${cols.map(col => `<td>${fmtNumber(row.values?.[col] || 0)}</td>`).join('')}
                <td class="data-analysis-pivot-total">${fmtNumber(row.total || 0)}</td>
            </tr>
        `).join('');
        const footer = `
            <tr class="data-analysis-pivot-total-row">
                <th>合计</th>
                ${cols.map(col => `<td>${fmtNumber(result.colTotals?.[col] || 0)}</td>`).join('')}
                <td class="data-analysis-pivot-total">${fmtNumber(result.grandTotal || 0)}</td>
            </tr>
        `;
        box.innerHTML = `
            ${result.truncated ? '<div class="data-analysis-query-meta">维度过多，行/列已截断展示。</div>' : ''}
            <div class="data-analysis-pivot-table" style="margin-bottom: 12px;">
                <table class="data-table compact-table data-analysis-result-table">
                    <thead>${head}</thead>
                    <tbody>${body || ''}${footer}</tbody>
                </table>
            </div>
            <div style="display: flex; justify-content: flex-end;">
                <button id="data-analysis-pivot-export-btn" class="btn-secondary" type="button" style="height: 30px; padding: 0 12px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; border: 1px solid rgba(148, 163, 184, 0.3); cursor: pointer;">导出透视结果 (CSV)</button>
            </div>
        `;
    }

    async function buildChart() {
        const dataset = activeDataset();
        if (!dataset) return;
        await guardButton('data-analysis-build-chart', '生成中…', async () => {
            syncChartAggregationControls('build', true);
            syncChartTypeControls('build');
            const sortValue = document.getElementById('data-analysis-chart-sort')?.value || 'value_desc';
            const [sortBy, sortOrder] = sortValue.split('_');
            const payload = {
                xField: document.getElementById('data-analysis-chart-x')?.value || '',
                yField: document.getElementById('data-analysis-chart-y')?.value || '',
                groupField: document.getElementById('data-analysis-chart-group')?.value || '',
                aggregation: document.getElementById('data-analysis-chart-aggregation')?.value || 'sum',
                chartType: document.getElementById('data-analysis-chart-type')?.value || 'bar',
                limit: document.getElementById('data-analysis-chart-limit')?.value || '30',
                sortBy: sortBy || 'value',
                sortOrder: sortOrder || 'desc',
                colorPalette: document.getElementById('data-analysis-chart-palette')?.value || 'teal'
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
            <div class="data-analysis-chart-actions">
                <button id="data-analysis-chart-png" class="btn-secondary" type="button">保存为图片</button>
                <button id="data-analysis-chart-data-csv" class="btn-secondary" type="button">导出图表数据 (CSV)</button>
            </div>
            <div class="pivot-echart-block" data-pivot-echart="${html.escapeAttr(JSON.stringify(state.chart))}">
                <div class="pivot-echart-title">图表预览</div>
                <div class="pivot-echart-canvas"></div>
                <canvas height="300"></canvas>
                <pre class="pivot-echart-error-text"></pre>
            </div>
        `;
        window.renderPivotCharts?.(box);
    }

    // 把当前图表块导出为 PNG：优先用 ECharts 实例的 getDataURL，回退到 2D canvas 的 toDataURL。
    function downloadChartPng() {
        const box = document.getElementById('data-analysis-chart-result');
        const block = box?.querySelector('.pivot-echart-block');
        if (!block) return;
        let dataUrl = '';
        try {
            if (block._pivotEchart && typeof block._pivotEchart.getDataURL === 'function') {
                dataUrl = block._pivotEchart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
            } else {
                const canvas = block.querySelector('canvas');
                if (canvas && !canvas.hidden) dataUrl = canvas.toDataURL('image/png');
            }
        } catch (_e) { dataUrl = ''; }
        if (!dataUrl) {
            toast('图表尚未渲染完成，请稍后再试', 'warning');
            return;
        }
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${(state.chart?.title || 'chart').replace(/[<>:"/\\|?*]/g, '_').slice(0, 60)}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // 将 HTML 表格数据前端导出为 CSV (包含 UTF-8 BOM 防乱码)
    function exportTableToCsv(tableElement, filename) {
        if (!tableElement) return;
        const rows = Array.from(tableElement.querySelectorAll('tr'));
        const csvContent = rows.map(row => {
            const cells = Array.from(row.querySelectorAll('th, td'));
            return cells.map(cell => {
                let text = cell.textContent || '';
                text = text.replace(/"/g, '""');
                return `"${text}"`;
            }).join(',');
        }).join('\n');

        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename || 'export.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // 智能解析 ECharts 选项数据并导出为 CSV
    function exportChartDataToCsv() {
        const chart = state.chart;
        if (!chart) return;

        let csvContent = '\uFEFF';

        // 优先尝试读取 dataset.source
        if (chart.dataset && Array.isArray(chart.dataset.source)) {
            const source = chart.dataset.source;
            csvContent += source.map(row => {
                return row.map(cell => {
                    let text = String(cell ?? '');
                    text = text.replace(/"/g, '""');
                    return `"${text}"`;
                }).join(',');
            }).join('\n');
        }
        // 读取传统的 xAxis.data 和 series
        else if (chart.xAxis && chart.xAxis.data && Array.isArray(chart.series)) {
            const xData = chart.xAxis.data;
            const seriesList = chart.series;
            
            const headers = ['分类字段', ...seriesList.map(s => s.name || '数值')];
            csvContent += headers.map(h => `"${h.replace(/"/g, '""')}"`).join(',') + '\n';
            
            xData.forEach((xVal, rowIndex) => {
                const row = [String(xVal)];
                seriesList.forEach(s => {
                    const val = s.data?.[rowIndex] ?? '';
                    row.push(String(val));
                });
                csvContent += row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',') + '\n';
            });
        }
        // 读取饼图类型的单 series.data 键值对
        else if (Array.isArray(chart.series) && chart.series[0] && Array.isArray(chart.series[0].data)) {
            const data = chart.series[0].data;
            csvContent += '"名称","数值"\n';
            data.forEach(item => {
                const name = String(item.name || '');
                const val = String(item.value ?? '');
                csvContent += `"${name.replace(/"/g, '""')}","${val.replace(/"/g, '""')}"\n`;
            });
        } else {
            toast('图表数据格式暂不支持导出', 'warning');
            return;
        }

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `${(chart.title?.text || 'chart_data').replace(/[<>:"/\\|?*]/g, '_').slice(0, 60)}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // 将数据比对结果导出为差异 CSV
    function exportCompareToCsv() {
        const result = state.compare;
        if (!result) return;
        
        let csvContent = '\uFEFF';
        csvContent += '"差异类型","主键","左侧值","右侧值"\n';
        
        (result.onlyLeft || []).forEach(row => {
            csvContent += `"仅左侧存在","${(row.key || '').replace(/"/g, '""')}",,""\n`;
        });
        (result.onlyRight || []).forEach(row => {
            csvContent += `"仅右侧存在","${(row.key || '').replace(/"/g, '""')}",,""\n`;
        });
        (result.changed || []).forEach(row => {
            const key = (row.key || '').replace(/"/g, '""');
            const leftVal = (row.leftValue || '').replace(/"/g, '""');
            const rightVal = (row.rightValue || '').replace(/"/g, '""');
            csvContent += `"字段差异","${key}","${leftVal}","${rightVal}"\n`;
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', '数据比对差异结果.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
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
            <div style="display: flex; justify-content: flex-end; margin: 12px 0;">
                <button id="data-analysis-compare-export-btn" class="btn-secondary" type="button" style="height: 30px; padding: 0 12px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; border: 1px solid rgba(148, 163, 184, 0.3); cursor: pointer;">导出比对差异结果 (CSV)</button>
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
        const typeLabel = { chart: '图表', comparison: '比对', export: '导出', query: '查询' };
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

    // 深度分析：调用后端 ReAct 工具调用接口，渲染答案 + 执行过程 + 内联图表。
    async function runAiAgent(dataset, prompt, model, result) {
        state.aiBusy = true;
        if (result) result.innerHTML = '<div class="data-analysis-ai-thinking">AI 正在查询数据并分析…</div>';
        await guardButton('data-analysis-ai-run', '分析中…', async () => {
            try {
                const data = await fetchJson(`${API}/ai`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'agent', datasetId: dataset.id, prompt, model })
                });
                renderAgentResult(result, data);
            } catch (e) {
                if (result) result.innerHTML = `<div class="data-analysis-empty">深度分析失败：${esc(e && e.message ? e.message : '请稍后重试')}</div>`;
                toast(e && e.message ? e.message : '深度分析失败', 'error');
            } finally {
                state.aiBusy = false;
            }
        });
    }

    function renderAgentResult(box, data) {
        if (!box) return;
        const steps = data.steps || [];
        const charts = data.charts || [];
        const toolLabel = { run_sql: 'SQL 查询', make_chart: '生成图表' };
        const stepsHtml = steps.length ? `
            <details class="data-analysis-ai-steps">
                <summary>执行过程（${steps.length} 步）</summary>
                ${steps.map(step => `
                    <div class="data-analysis-ai-step">
                        <span class="data-analysis-ai-step-tool">${esc(toolLabel[step.tool] || step.tool)}</span>
                        <code>${esc(step.input?.sql || JSON.stringify(step.input || {}))}</code>
                        <em>${esc(step.summary || '')}</em>
                    </div>
                `).join('')}
            </details>
        ` : '';
        const chartsHtml = charts.length ? `<div class="data-analysis-ai-charts">${charts.map(chart => `
            <div class="pivot-echart-block" data-pivot-echart="${html.escapeAttr(JSON.stringify(chart))}">
                <div class="pivot-echart-title">${esc(chart.title || '图表')}</div>
                <div class="pivot-echart-canvas"></div>
                <canvas height="300"></canvas>
                <pre class="pivot-echart-error-text"></pre>
            </div>
        `).join('')}</div>` : '';
        box.innerHTML = `
            <div class="data-analysis-ai-answer">${esc(data.answer || 'AI 未返回有效内容')}</div>
            ${chartsHtml}
            ${stepsHtml}
        `;
        if (charts.length) window.renderPivotCharts?.(box);
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
        const deep = document.getElementById('data-analysis-ai-deep')?.checked;
        if (deep) {
            await runAiAgent(dataset, prompt, model, result);
            return;
        }
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

    async function importFromDatabase() {
        let connections = [];
        try {
            const data = await fetchJson('/api/mcp/servers');
            connections = (Array.isArray(data.data) ? data.data : []).filter(item => item.server_type === 'database');
        } catch (_e) { /* 空处理 */ }
        if (!connections.length) {
            toast('没有可用的数据库连接，请先在「工具服务」中配置数据库连接', 'warning');
            return;
        }

        // 渲染连接下拉选项
        const connSelect = document.getElementById('data-analysis-db-conn');
        if (connSelect) {
            connSelect.innerHTML = connections.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
        }

        // 重置/清除表单输入内容
        const sqlText = document.getElementById('data-analysis-db-sql');
        if (sqlText) sqlText.value = 'SELECT * FROM ';
        const tableNameInput = document.getElementById('data-analysis-db-table');
        if (tableNameInput) tableNameInput.value = '';
        const datasetNameInput = document.getElementById('data-analysis-db-name');
        if (datasetNameInput) datasetNameInput.value = '';

        // 显示自定义导入弹窗
        document.getElementById('data-analysis-db-import-modal')?.classList.remove('hidden');
    }

    // 提交数据库导入请求
    async function submitDatabaseImport() {
        const connSelect = document.getElementById('data-analysis-db-conn');
        const sqlText = document.getElementById('data-analysis-db-sql');
        const tableNameInput = document.getElementById('data-analysis-db-table');
        const datasetNameInput = document.getElementById('data-analysis-db-name');

        const mcpServerId = connSelect?.value;
        const sql = sqlText?.value || '';
        const table = tableNameInput?.value || '';
        const name = datasetNameInput?.value || '';

        if (!mcpServerId) {
            toast('请选择数据库连接', 'warning');
            return;
        }
        if (!sql.trim() && !table.trim()) {
            toast('请输入只读 SQL 查询或数据表名', 'warning');
            return;
        }

        // 默认命名规则：优先使用自定义名称 -> 表名 -> 连接原名
        const selectedConnText = connSelect.options[connSelect.selectedIndex]?.text || '';
        const finalName = name.trim() || table.trim() || selectedConnText;

        // 关闭导入弹窗并进入忙碌状态
        document.getElementById('data-analysis-db-import-modal')?.classList.add('hidden');
        setBusy(true, '正在从数据库导入...');
        try {
            const data = await fetchJson(`${API}/import-database`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mcpServerId,
                    sql: sql.trim(),
                    table: table.trim(),
                    name: finalName.trim()
                })
            });
            state.activeId = data.dataset?.id || '';
            toast('数据库数据已导入');
            await loadDatasets({ keepActive: true });
        } catch (e) {
            toast(e && e.message ? e.message : '数据库导入失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function activateTab(tab) {
        document.querySelectorAll('.data-analysis-tab').forEach(button => {
            button.classList.toggle('active', button.dataset.dataAnalysisTab === tab);
        });
        document.querySelectorAll('.data-analysis-tab-panel').forEach(panel => {
            panel.classList.toggle('hidden', panel.id !== `data-analysis-${tab}-panel`);
        });
        // 切换 Tab 时同步更新顶部标题和简介
        updateToolbarHeader(tab);
    }

    function bindEvents(root) {
        root.addEventListener('change', async event => {
            if (event.target?.id === 'data-analysis-file') {
                uploadDataset(event.target.files?.[0]);
                event.target.value = '';
                return;
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
            if (event.target?.id === 'data-analysis-chart-type') {
                syncChartTypeControls('type');
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
                await loadDatasetDetail(targetDatasetId);
                const activeTabEl = document.querySelector('.data-analysis-tab.active');
                const activeTabName = activeTabEl?.dataset.dataAnalysisTab;
                if (activeTabName === 'history') loadArtifacts();
            }
        });
        root.addEventListener('click', async event => {
            // 数据集行内“预览”按钮
            const previewBtn = event.target.closest('[data-data-analysis-action-preview]');
            if (previewBtn) {
                await previewDataset(previewBtn.dataset.dataAnalysisActionPreview);
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
                    }
                    await loadDatasets({ keepActive: false });
                } catch (e) {
                    toast(e && e.message ? e.message : '删除失败', 'error');
                } finally {
                    setBusy(false);
                }
                return;
            }
            // 关闭预览弹窗按钮
            if (event.target.closest('#data-analysis-preview-modal-close')) {
                document.getElementById('data-analysis-preview-modal')?.classList.add('hidden');
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
            const tab = event.target.closest('[data-data-analysis-tab]');
            if (tab) {
                const name = tab.dataset.dataAnalysisTab;
                activateTab(name);
                if (name === 'history') loadArtifacts();
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
                exportCompareToCsv();
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
                const table = document.querySelector('.data-analysis-query-table table');
                exportTableToCsv(table, '数据查询结果.csv');
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
