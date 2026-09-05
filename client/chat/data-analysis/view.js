
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber, activeDataset } = app;
    const fetchJson = (...args) => app.fetchJson(...args);
    const setBusy = (...args) => app.setBusy(...args);
    const toast = (...args) => app.toast(...args);
    const bindEvents = (...args) => app.bindEvents(...args);
    const renderVisualQueryControls = (...args) => app.renderVisualQueryControls(...args);
    const syncChartAggregationControls = (...args) => app.syncChartAggregationControls(...args);
    const syncChartTypeControls = (...args) => app.syncChartTypeControls(...args);

    function ensureView() {
        let view = document.getElementById('data-analysis-view');
        if (view) return view;
        const body = document.querySelector('.apps-workspace-body');
        if (!body) return null;
        view = document.createElement('div');
        view.id = 'data-analysis-view';
        view.className = 'data-analysis-view hidden';
        PivotSafeHtml.setHtml(view, `
            <div class="workspace-panel data-analysis-panel">
                <aside class="data-analysis-sidebar">
                    <nav class="data-analysis-tabs" role="tablist" aria-label="数据分析视图" aria-orientation="vertical">
                        <button class="data-analysis-tab active" type="button" data-data-analysis-tab="overview">数据总览</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="cleaning">数据清洗</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="chart">图表生成</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="compare">数据比对</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="query">数据查询</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="pivot">数据透视</button>
                        <button class="data-analysis-tab" type="button" data-data-analysis-tab="ai">智能分析</button>
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
                    <section id="data-analysis-cleaning-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-cleaning-header">
                            <div class="data-cleaning-header-left">
                                <div class="data-cleaning-header-icon-badge">
                                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"></path></svg>
                                </div>
                                <div class="data-cleaning-header-intro">
                                    <div class="data-cleaning-title-row">
                                        <h5>数据清洗工作台</h5>
                                        <span class="data-cleaning-badge-safe">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                                            非破坏性副本清洗 · 规则可追溯
                                        </span>
                                    </div>
                                    <p>先全面检查质量问题，再编排清洗流水线、实时演算预览行数与字段变更，安全生成派生数据集。原始数据永久保持不变。</p>
                                </div>
                            </div>
                            <div class="data-cleaning-header-actions">
                                <label class="data-cleaning-dataset-picker" title="选择需要进行清洗与体检的数据集">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
                                    <span class="data-cleaning-picker-label">分析数据集</span>
                                    <select id="data-analysis-cleaning-dataset" class="form-input data-cleaning-picker-select"></select>
                                </label>
                                <button id="data-cleaning-refresh" class="btn-secondary" type="button" title="刷新并重新体检当前数据集">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                                    <span>刷新质量报告</span>
                                </button>
                            </div>
                        </div>
                        <nav class="data-cleaning-tabs-nav" role="tablist">
                            <button type="button" class="data-cleaning-tab-btn active" data-cleaning-tab="rules" role="tab" aria-selected="true"><span class="data-cleaning-tab-step">1</span><div class="data-cleaning-tab-info"><span class="data-cleaning-tab-title">清洗规则编排</span><span class="data-cleaning-tab-sub">规则配置与建议</span></div><span class="data-cleaning-tab-badge" id="data-cleaning-tab-rules-badge">0 条</span></button>
                            <button type="button" class="data-cleaning-tab-btn" data-cleaning-tab="quality" role="tab" aria-selected="false"><span class="data-cleaning-tab-step">2</span><div class="data-cleaning-tab-info"><span class="data-cleaning-tab-title">数据质量体检</span><span class="data-cleaning-tab-sub">健康评分与完整率</span></div><span class="data-cleaning-tab-badge" id="data-cleaning-tab-quality-badge">待体检</span></button>
                            <button type="button" class="data-cleaning-tab-btn" data-cleaning-tab="preview" role="tab" aria-selected="false"><span class="data-cleaning-tab-step">3</span><div class="data-cleaning-tab-info"><span class="data-cleaning-tab-title">影响演算预览</span><span class="data-cleaning-tab-sub">行级比对与样本明细</span></div><span class="data-cleaning-tab-badge" id="data-cleaning-tab-preview-badge">待演算</span></button>
                            <button type="button" class="data-cleaning-tab-btn" data-cleaning-tab="runs" role="tab" aria-selected="false"><span class="data-cleaning-tab-step">4</span><div class="data-cleaning-tab-info"><span class="data-cleaning-tab-title">清洗记录谱系</span><span class="data-cleaning-tab-sub">历史版本与复跑</span></div><span class="data-cleaning-tab-badge" id="data-cleaning-tab-runs-badge">0 个</span></button>
                        </nav>

                        <!-- Tab Pane 1: Rules Studio (Default Active) -->
                        <div id="data-cleaning-pane-rules" class="data-cleaning-tab-pane active">
                            <div id="data-cleaning-quick-health-banner" class="data-cleaning-quick-health-banner"></div>
                            <div class="data-cleaning-layout">
                                <aside class="data-cleaning-recommendations">
                                    <div class="data-cleaning-section-heading">
                                        <div class="data-cleaning-section-title-wrap">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                                            <h6>质量建议</h6>
                                        </div>
                                        <span class="data-cleaning-section-tip">仅添加规则，不直接改动数据</span>
                                    </div>
                                    <div id="data-cleaning-recommendations-list" class="data-cleaning-recommendations-list"></div>
                                </aside>
                                <div class="data-cleaning-rules-panel">
                                    <div class="data-cleaning-section-heading">
                                        <div>
                                            <div class="data-cleaning-section-title-wrap">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>
                                                <h6>清洗规则编排流水线</h6>
                                            </div>
                                            <span>从上到下按次序依次执行清洗规则</span>
                                        </div>
                                        <button id="data-cleaning-add-rule" class="btn-secondary data-cleaning-add-btn" type="button">
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                            <span>添加规则</span>
                                        </button>
                                    </div>
                                    <div class="data-cleaning-templates-bar">
                                        <span class="data-cleaning-templates-label">常用快捷规则：</span>
                                        <button type="button" class="data-cleaning-template-btn" data-cleaning-template="trim" title="去除所有首尾多余空格"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>去除首尾空格</button>
                                        <button type="button" class="data-cleaning-template-btn" data-cleaning-template="normalize_empty" title="将全空格等纯空白文本转为标准 NULL"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>空白转标准空值</button>
                                        <button type="button" class="data-cleaning-template-btn" data-cleaning-template="fill_missing_0" title="为缺失字段填补默认固定值 0"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="12" cy="12" r="3"></circle></svg>缺失值补0</button>
                                        <button type="button" class="data-cleaning-template-btn" data-cleaning-template="deduplicate" title="基于所选字段识别并剔除重复记录"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>按字段去重</button>
                                        <button type="button" class="data-cleaning-template-btn" data-cleaning-template="remove_outliers" title="基于四分位距 IQR 剔除离群极值"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><circle cx="19" cy="5" r="2"></circle><circle cx="5" cy="19" r="2"></circle></svg>IQR离群值过滤</button>
                                    </div>
                                    <div id="data-cleaning-rules" class="data-cleaning-rules"></div>
                                    <div class="data-cleaning-actions">
                                        <label class="data-cleaning-name-label" title="输入清洗后生成的派生数据集名称">
                                            <span class="data-cleaning-name-tag"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg><span>派生数据集名称</span></span>
                                            <input id="data-cleaning-name" class="form-input data-cleaning-name-input" maxlength="120" placeholder="默认：原数据集（清洗后）">
                                        </label>
                                        <div class="data-cleaning-action-buttons">
                                            <button id="data-cleaning-preview-run" class="btn-secondary" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg><span>预览清洗影响</span></button>
                                            <button id="data-cleaning-apply" class="btn-primary" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><span>生成清洗后数据集</span></button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Tab Pane 2: Quality Report -->
                        <div id="data-cleaning-pane-quality" class="data-cleaning-tab-pane hidden">
                            <div id="data-cleaning-quality" class="data-cleaning-quality"></div>
                            <div class="data-cleaning-pane-bottom-cta">
                                <span class="data-cleaning-pane-cta-desc">质量体检已完成。可根据建议或业务需求配置针对性清洗流水线</span>
                                <button type="button" class="btn-primary" data-cleaning-switch-tab="rules">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="20" y1="21" x2="20" y2="16"></line></svg>
                                    <span>前往编排清洗规则 ➔</span>
                                </button>
                            </div>
                        </div>

                        <!-- Tab Pane 3: Impact Preview -->
                        <div id="data-cleaning-pane-preview" class="data-cleaning-tab-pane hidden">
                            <div id="data-cleaning-preview" class="data-cleaning-preview"></div>
                            <div class="data-cleaning-pane-bottom-cta">
                                <button type="button" class="btn-secondary" data-cleaning-switch-tab="rules">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
                                    <span>返回调整清洗规则</span>
                                </button>
                                <button type="button" class="btn-primary" id="data-cleaning-preview-apply-cta">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                    <span>效果满意，立即生成清洗后数据集</span>
                                </button>
                            </div>
                        </div>

                        <!-- Tab Pane 4: Runs & Lineage -->
                        <div id="data-cleaning-pane-runs" class="data-cleaning-tab-pane hidden">
                            <div class="data-cleaning-runs-panel">
                                <div class="data-cleaning-section-heading">
                                    <div>
                                        <div class="data-cleaning-section-title-wrap">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                            <h6>清洗记录与版本谱系</h6>
                                        </div>
                                        <span>随时载入原清洗规则并重新应用到源数据集</span>
                                    </div>
                                    <button id="data-cleaning-refresh-runs" class="btn-secondary" type="button">
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                                        <span>刷新记录</span>
                                    </button>
                                </div>
                                <div id="data-cleaning-runs" class="data-cleaning-runs"></div>
                            </div>
                        </div>
                    </section>
                    <section id="data-analysis-chart-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-form-grid data-analysis-chart-controls">
                            <label>分析数据集<select id="data-analysis-chart-dataset" class="form-input"></select></label>
                            <label>分类字段<select id="data-analysis-chart-x" class="form-input"></select></label>
                            <label>数值字段<select id="data-analysis-chart-y" class="form-input"></select></label>
                            <label data-data-analysis-chart-control="group">分组字段<select id="data-analysis-chart-group" class="form-input"></select></label>
                            <label>聚合<select id="data-analysis-chart-aggregation" class="form-input"><option value="sum">求和</option><option value="count">计数</option><option value="avg">平均</option><option value="min">最小</option><option value="max">最大</option></select></label>
                            <label>图表<select id="data-analysis-chart-type" class="form-input"><option value="bar">柱状图</option><option value="line">折线图</option><option value="area">面积图</option><option value="pie">饼图</option></select></label>
                            <label>显示前几位<input id="data-analysis-chart-limit" class="form-input" type="number" min="1" max="80" value="30"></label>
                            <label>排序<select id="data-analysis-chart-sort" class="form-input"><option value="value_desc">数值降序</option><option value="value_asc">数值升序</option><option value="label_asc">分类升序</option><option value="label_desc">分类降序</option></select></label>
                            <label>配色<select id="data-analysis-chart-palette" class="form-input"><option value="teal">经典青绿</option><option value="business">商务蓝绿</option><option value="soft">柔和多彩</option><option value="warm">暖色强调</option></select></label>
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
                        <div class="data-analysis-query-header">
                            <div class="data-analysis-dataset-selector-wrap">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="data-analysis-query-header-icon"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
                                <span>分析数据集</span>
                                <select id="data-analysis-query-dataset" class="form-input"></select>
                            </div>
                            <div class="data-analysis-query-mode-selector">
                                <button type="button" class="btn-secondary active" id="data-analysis-query-mode-visual">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
                                    <span>可视化查询</span>
                                </button>
                                <button type="button" class="btn-secondary" id="data-analysis-query-mode-sql">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
                                    <span>SQL 查询 (高级)</span>
                                </button>
                            </div>
                        </div>
                        
                        <!-- 可视化查询编辑器 -->
                        <div id="data-analysis-query-visual-box" class="data-analysis-query-visual-box">
                            <div class="data-analysis-query-toolbar-bar">
                                <div class="data-analysis-query-filter-header">
                                    <span class="data-analysis-query-filter-title">
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
                                        筛选条件
                                    </span>
                                    <div class="data-analysis-query-relation">
                                        <span>逻辑:</span>
                                        <select id="data-analysis-query-visual-op" class="form-input">
                                            <option value="AND">且 (AND)</option>
                                            <option value="OR">或 (OR)</option>
                                        </select>
                                    </div>
                                    <button type="button" id="data-analysis-query-visual-add" class="btn-secondary data-analysis-query-add-btn">
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                        <span>添加条件</span>
                                    </button>
                                </div>

                                <div class="data-analysis-query-settings-grid">
                                    <label class="data-analysis-query-setting-item">
                                        <span>排序:</span>
                                        <select id="data-analysis-query-visual-sort-field" class="form-input"></select>
                                        <select id="data-analysis-query-visual-sort-order" class="form-input">
                                            <option value="ASC">升序 (ASC)</option>
                                            <option value="DESC">降序 (DESC)</option>
                                        </select>
                                    </label>
                                    <label class="data-analysis-query-setting-item">
                                        <span>限制:</span>
                                        <input type="number" id="data-analysis-query-visual-limit" class="form-input" min="1" max="5000" value="100">
                                        <span class="data-analysis-query-unit">行</span>
                                    </label>
                                    <button id="data-analysis-run-query-visual" class="btn-primary data-analysis-query-run-btn" type="button">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                        <span>运行查询</span>
                                    </button>
                                </div>
                            </div>
                            
                            <div id="data-analysis-query-visual-filters" class="data-analysis-query-visual-filters">
                                <!-- 动态渲染筛选条件行 -->
                            </div>
                        </div>
                        
                        <!-- SQL 查询编辑器（高级） -->
                        <div id="data-analysis-query-sql-box" class="data-analysis-query-sql-box hidden">
                            <div class="data-analysis-query-sql-toolbar">
                                <div id="data-analysis-query-fields" class="data-analysis-query-fields"></div>
                                <button id="data-analysis-run-query" class="btn-primary data-analysis-query-run-btn" type="button">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                    <span>运行查询</span>
                                </button>
                            </div>
                            <textarea id="data-analysis-query-sql" class="form-input data-analysis-query-sql" spellcheck="false" placeholder="SELECT * FROM data LIMIT 100"></textarea>
                            <div class="data-analysis-query-sql-footer">
                                <span class="data-analysis-query-hint">只读 SQL 查询，表名固定为 <code>data</code>，点击字段名可快速插入。</span>
                            </div>
                        </div>
                        
                        <div id="data-analysis-query-result" class="data-analysis-query-result"></div>
                    </section>
                    <section id="data-analysis-pivot-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-pivot-workspace">
                            <div class="data-analysis-pivot-config">
                                <div class="data-analysis-pivot-config-main">
                                    <label class="data-analysis-pivot-field-item">
                                        <span class="data-analysis-pivot-field-title">分析数据集</span>
                                        <select id="data-analysis-pivot-dataset" class="form-input"></select>
                                    </label>
                                    <label class="data-analysis-pivot-field-item">
                                        <span class="data-analysis-pivot-field-title">行维度</span>
                                        <select id="data-analysis-pivot-row" class="form-input"></select>
                                    </label>
                                    <label class="data-analysis-pivot-field-item">
                                        <span class="data-analysis-pivot-field-title">列维度</span>
                                        <select id="data-analysis-pivot-col" class="form-input"></select>
                                    </label>
                                    <label class="data-analysis-pivot-field-item">
                                        <span class="data-analysis-pivot-field-title">值字段</span>
                                        <select id="data-analysis-pivot-value" class="form-input"></select>
                                    </label>
                                    <label class="data-analysis-pivot-field-item">
                                        <span class="data-analysis-pivot-field-title">聚合方式</span>
                                        <select id="data-analysis-pivot-aggregation" class="form-input">
                                            <option value="sum">求和 (SUM)</option>
                                            <option value="count">计数 (COUNT)</option>
                                            <option value="avg">平均 (AVG)</option>
                                            <option value="max">最大 (MAX)</option>
                                            <option value="min">最小 (MIN)</option>
                                        </select>
                                    </label>
                                </div>
                                <div class="data-analysis-pivot-config-sub">
                                    <div class="data-analysis-pivot-config-sub-filters">
                                        <label class="data-analysis-pivot-field-item pivot-field-sort">
                                            <span class="data-analysis-pivot-field-title">排序</span>
                                            <select id="data-analysis-pivot-sort" class="form-input">
                                                <option value="total_desc">按指标值降序</option>
                                                <option value="total_asc">按指标值升序</option>
                                                <option value="label_asc">按行名升序</option>
                                                <option value="label_desc">按行名降序</option>
                                            </select>
                                        </label>
                                        <label class="data-analysis-pivot-field-item pivot-field-percent">
                                            <span class="data-analysis-pivot-field-title">占比计算</span>
                                            <select id="data-analysis-pivot-percent-mode" class="form-input">
                                                <option value="none">不显示占比</option>
                                                <option value="row">行内百分比</option>
                                                <option value="column">列内百分比</option>
                                                <option value="total">总占比</option>
                                            </select>
                                        </label>
                                        <label class="data-analysis-pivot-field-item pivot-field-limit">
                                            <span class="data-analysis-pivot-field-title">行 Top N</span>
                                            <input id="data-analysis-pivot-row-limit" class="form-input" type="number" min="1" max="200" value="50">
                                        </label>
                                        <label class="data-analysis-pivot-field-item pivot-field-limit">
                                            <span class="data-analysis-pivot-field-title">列 Top N</span>
                                            <input id="data-analysis-pivot-col-limit" class="form-input" type="number" min="1" max="50" value="20">
                                        </label>
                                        <label class="data-analysis-pivot-field-item pivot-field-empty">
                                            <span class="data-analysis-pivot-field-title">空值替换</span>
                                            <input id="data-analysis-pivot-empty-label" class="form-input" type="text" value="(空值)" maxlength="40">
                                        </label>
                                    </div>
                                    <div class="data-analysis-pivot-toolbar">
                                        <span id="data-analysis-pivot-hint" class="data-analysis-pivot-hint hidden" title="透视提示">选择适合分组的维度，并用 Top N 控制大表展示规模。</span>
                                        <div class="data-analysis-pivot-toolbar-actions">
                                            <button id="data-analysis-pivot-recommend" class="btn-secondary" type="button" title="根据数据集字段画像智能推荐维度与指标">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px; vertical-align: -1px;"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                                                <span>推荐配置</span>
                                            </button>
                                            <button id="data-analysis-run-pivot" class="btn-primary" type="button" title="执行数据多维透视聚合计算">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px; vertical-align: -1px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                                <span>开始透视</span>
                                            </button>
                                            <button id="data-analysis-pivot-export-btn" class="btn-secondary hidden" type="button" title="导出当前透视表数据为 CSV">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px; vertical-align: -1px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                                <span>导出 CSV</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div id="data-analysis-pivot-result" class="data-analysis-pivot-result"></div>
                        </div>
                    </section>
                    <section id="data-analysis-ai-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-ai-header-bar">
                            <div class="data-analysis-subtabs-nav" role="tablist" aria-label="智能分析功能分类">
                                <button id="data-analysis-subtab-btn-chat" class="data-analysis-subtab active" type="button" data-ai-subtab="chat" role="tab" aria-selected="true">
                                    <span>即时 AI 探索与深度分析</span>
                                </button>
                                <button id="data-analysis-subtab-btn-semantic" class="data-analysis-subtab" type="button" data-ai-subtab="semantic" role="tab" aria-selected="false">
                                    <span>全量语义分析任务</span>
                                </button>
                            </div>
                            <div class="data-analysis-ai-header-dataset">
                                <div class="data-analysis-dataset-selector-wrap">
                                    <span>分析数据集</span>
                                    <select id="data-analysis-ai-dataset" class="form-input"></select>
                                </div>
                                <label class="data-analysis-dataset-selector-wrap data-analysis-ai-model-selector" for="data-analysis-ai-model">
                                    <span>模型</span>
                                    <select id="data-analysis-ai-model" class="form-input" aria-label="选择数据智能分析模型" disabled>
                                        <option value="">加载模型中…</option>
                                    </select>
                                </label>
                            </div>
                        </div>

                        <!-- 子面板 1：即时 AI 探索与深度分析 -->
                        <div id="data-analysis-ai-subpanel-chat" class="data-analysis-ai-subpanel">
                            <!-- 灵动智能输入中枢 -->
                            <div class="data-analysis-ai-box">
                                <div class="data-analysis-ai-input-wrap">
                                    <textarea id="data-analysis-ai-prompt" class="form-input" placeholder="输入你想探索的分析方向、核心疑问或业务诉求（Enter 发送，Shift+Enter 换行）…"></textarea>
                                    <button id="data-analysis-ai-clear-prompt" class="data-analysis-ai-clear-btn hidden" type="button" title="清空输入内容">
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                    </button>
                                </div>
                                <div class="data-analysis-ai-actions">
                                    <div class="data-analysis-ai-input-tip">
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                                        <span>可直接输入探索诉求，或在下方场景卡片中点击填入</span>
                                    </div>
                                    <div class="data-analysis-ai-right-controls">
                                        <label class="data-analysis-ai-toggle" title="开启后 AI 可编写 SQL 钻取实际数据并自动生成可视化图表">
                                            <input type="checkbox" id="data-analysis-ai-deep">
                                            <span class="data-analysis-ai-toggle-title">深度分析</span>
                                            <span class="data-analysis-ai-toggle-desc">（可查询数据/生成图表）</span>
                                        </label>
                                        <div class="data-analysis-ai-buttons">
                                            <button id="data-analysis-ai-stop" class="btn-danger-outline hidden" type="button">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 3px; vertical-align: -1px;"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
                                                <span>停止生成</span>
                                            </button>
                                            <button id="data-analysis-ai-run" class="btn-primary data-analysis-ai-run-btn" type="button">
                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: -1px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                                <span>生成建议</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- 智能分析主画布 -->
                            <div class="data-analysis-ai-canvas">
                                <!-- 冷启动引导看板：未生成时呈现，彻底消灭下方大块空白 -->
                                <div id="data-analysis-ai-landing" class="data-analysis-ai-landing">
                                    <div class="data-analysis-ai-landing-profile">
                                        <div class="data-analysis-ai-landing-card-header">
                                            <div class="landing-header-title">
                                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                                                <span>数据集特征画像概览</span>
                                            </div>
                                            <span id="data-analysis-ai-profile-name" class="data-analysis-ai-profile-name"></span>
                                        </div>
                                        <div id="data-analysis-ai-profile-content" class="data-analysis-ai-profile-content">
                                            <div class="data-analysis-ai-profile-empty">加载数据集中…</div>
                                        </div>
                                    </div>
                                    <div class="data-analysis-ai-landing-guide">
                                        <div class="data-analysis-ai-landing-card-header">
                                            <div class="landing-header-title">
                                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>
                                                <span>核心分析场景推荐</span>
                                            </div>
                                            <span class="landing-header-hint">点击卡片填入分析诉求</span>
                                        </div>
                                        <div class="data-analysis-ai-landing-scenarios">
                                            <div class="data-analysis-ai-scenario-card" data-prompt="全面分析本数据集的核心业务指标与总体分布特征，提炼关键结论与行动建议">
                                                <div class="scenario-icon scenario-icon-blue">
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                                                </div>
                                                <div class="scenario-body">
                                                    <h6>业务洞察与宏观结论</h6>
                                                    <p>自动提炼核心业务特征，输出结构化洞察报告。</p>
                                                </div>
                                            </div>
                                            <div class="data-analysis-ai-scenario-card" data-prompt="分析关键数值维度的集中趋势、极值分布与对比关联关系">
                                                <div class="scenario-icon scenario-icon-emerald">
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline><polyline points="16 7 22 7 22 13"></polyline></svg>
                                                </div>
                                                <div class="scenario-body">
                                                    <h6>分布趋势与多维钻取</h6>
                                                    <p>探查指标极值范围、集中区间与维度关联。</p>
                                                </div>
                                            </div>
                                            <div class="data-analysis-ai-scenario-card" data-prompt="排查数据中的离群值、空值缺失率及潜在数据质量异常">
                                                <div class="scenario-icon scenario-icon-amber">
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                                                </div>
                                                <div class="scenario-body">
                                                    <h6>数据质量与离群排查</h6>
                                                    <p>识别空值率偏高与异常波动，诊断质量风险。</p>
                                                </div>
                                            </div>
                                            <div class="data-analysis-ai-scenario-card" data-prompt="针对本数据集结构推荐最适用的可视化方案并生成图表展示">
                                                <div class="scenario-icon scenario-icon-purple">
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                                                </div>
                                                <div class="scenario-body">
                                                    <h6>自适应可视化图表</h6>
                                                    <p>根据字段画像自动生成适宜的图表展示。</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- 结果展示区（生成时展示，包含操作栏、答案、图表、SQL 依据） -->
                                <div id="data-analysis-ai-result-wrap" class="data-analysis-ai-result-wrap hidden">
                                    <div class="data-analysis-ai-result-toolbar">
                                        <div class="data-analysis-ai-result-meta">
                                            <span class="status-indicator"></span>
                                            <span id="data-analysis-ai-result-time">分析报告</span>
                                        </div>
                                        <div class="data-analysis-ai-result-actions">
                                            <button id="data-analysis-ai-copy-result" class="btn-secondary btn-sm" type="button" title="复制完整分析报告">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                                <span>复制报告</span>
                                            </button>
                                            <button id="data-analysis-ai-reset-view" class="btn-secondary btn-sm" type="button" title="清空并返回探索引导看板">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px;"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                                                <span>新探索</span>
                                            </button>
                                        </div>
                                    </div>
                                    <div id="data-analysis-ai-result" class="data-analysis-ai-result message-content"></div>
                                </div>
                            </div>
                        </div>

                        <!-- 子面板 2：全量语义分析任务 -->
                        <div id="data-analysis-ai-subpanel-semantic" class="data-analysis-ai-subpanel hidden">
                            <!-- 隐藏的数据集绑定元素，保障所有测试与向后兼容 -->
                            <select id="data-analysis-semantic-dataset" class="hidden" aria-hidden="true" tabindex="-1"></select>

                            <div class="data-analysis-semantic-box">
                                <div class="data-analysis-semantic-toolbar">
                                    <div class="data-analysis-semantic-history-group" aria-label="全量语义分析任务记录">
                                        <div class="data-analysis-semantic-toolbar-header">
                                            <div class="data-analysis-semantic-toolbar-title">
                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                                <label for="data-analysis-semantic-job">任务记录</label>
                                            </div>
                                            <div class="data-analysis-semantic-status-wrap">
                                                <span class="status-lbl">状态：</span>
                                                <span id="data-analysis-semantic-status" class="data-analysis-semantic-status">未选择分析数据集</span>
                                                <button id="data-analysis-semantic-refresh-jobs" class="btn-secondary btn-sm" type="button" title="刷新任务记录">刷新记录</button>
                                            </div>
                                        </div>
                                        <select id="data-analysis-semantic-job" class="form-input" aria-label="选择最近的全量语义分析任务记录"></select>
                                    </div>
                                </div>

                                <div class="data-analysis-form-grid data-analysis-semantic-controls">
                                    <label>文本分析字段<select id="data-analysis-semantic-field" class="form-input"></select></label>
                                    <label>记录标识字段（可选）<select id="data-analysis-semantic-id-field" class="form-input"></select></label>
                                    <label>每批 Token 预算<input id="data-analysis-semantic-batch-tokens" class="form-input" type="number" min="8000" max="60000" step="1000" value="24000"></label>
                                </div>

                                <textarea id="data-analysis-semantic-instruction" class="form-input data-analysis-semantic-instruction" placeholder="输入全量语义分析指令（例如：逐条提取主题、情感、风险和摘要，不得跳过任何记录，最后汇总主要问题与建议）…"></textarea>

                                <div class="data-analysis-semantic-actions">
                                    <button id="data-analysis-semantic-run" class="btn-primary" type="button">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: -1px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                        <span>启动全量任务</span>
                                    </button>
                                    <button id="data-analysis-semantic-cancel" class="btn-secondary hidden" type="button">取消任务</button>
                                    <button id="data-analysis-semantic-retry" class="btn-secondary hidden" type="button">重试失败任务</button>
                                </div>

                                <div id="data-analysis-semantic-progress" class="data-analysis-semantic-progress"></div>
                            </div>

                            <div class="data-analysis-semantic-result-wrap">
                                <div class="data-analysis-semantic-result-toolbar">
                                    <div class="data-analysis-semantic-result-header-title">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; color: var(--primary);"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                                        <span>全量语义分析报告</span>
                                    </div>
                                    <div class="data-analysis-semantic-result-actions">
                                        <button id="data-analysis-semantic-copy-report" class="btn-secondary btn-sm" type="button" title="复制全量分析报告" disabled>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                            <span>复制报告</span>
                                        </button>
                                    </div>
                                </div>
                                <div id="data-analysis-semantic-report" class="data-analysis-semantic-report message-content"></div>
                            </div>
                        </div>
                    </section>

                    <section id="data-analysis-history-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-dataset-selector-wrap" style="margin-bottom: 12px;">
                            <span>分析数据集</span>
                            <select id="data-analysis-history-dataset" class="form-input"></select>
                        </div>
                        <div class="table-container workspace-table-wrap data-analysis-history-table-wrap">
                            <div id="data-analysis-history-result" class="data-analysis-history-result"></div>
                        </div>
                        <div id="data-analysis-history-pagination" class="pagination workspace-pagination data-analysis-history-pagination"></div>
                    </section>
                </main>
            </div>

            <!-- 数据预览模态弹窗 -->
            <div id="data-analysis-preview-modal" class="modal-overlay hidden" style="z-index: 8000;">
                <div class="modal data-analysis-preview-modal-dialog">
                    <div class="data-analysis-preview-modal-header">
                        <div class="data-analysis-preview-title-group">
                            <h3 id="data-analysis-preview-modal-title">数据集数据预览</h3>
                            <span id="data-analysis-preview-modal-meta" class="data-analysis-preview-meta"></span>
                        </div>
                        <button id="data-analysis-preview-modal-close" class="btn-secondary data-analysis-preview-modal-close-btn" type="button">关闭</button>
                    </div>
                    <div id="data-analysis-preview-modal-content" class="data-analysis-preview"></div>
                    <div id="data-analysis-preview-modal-footer" class="data-analysis-preview-footer">
                        <div id="data-analysis-preview-pagination" class="data-analysis-preview-pagination"></div>
                    </div>
                </div>
            </div>

            <!-- 数据库导入模态弹窗 -->
            <div id="data-analysis-db-import-modal" class="modal-overlay hidden" style="z-index: 8000;">
                <div class="modal" style="width: min(500px, 92vw); max-height: 85vh; display: flex; flex-direction: column; padding: 24px; border-radius: 12px; background: rgba(255, 255, 255, 0.98); box-shadow: 0 20px 40px rgba(0,0,0,0.15); border: 1px solid rgba(148, 163, 184, 0.2);">
                    <div style="display: flex; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); padding-bottom: 10px;">
                        <h3 style="margin: 0; font-size: 1.05rem; font-weight: 800; color: var(--text-main);">从服务器可访问数据库导入数据集</h3>
                    </div>
                    <form id="data-analysis-db-import-form" style="display: flex; flex-direction: column; gap: 14px; overflow: auto; padding: 4px; text-align: left;">
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 0.82rem; font-weight: 700; color: var(--text-main);">服务器可访问数据库</label>
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

            <!-- 比对列表放大模态弹窗 -->
            <div id="data-analysis-compare-modal" class="modal-overlay hidden" style="z-index: 8000;">
                <div class="modal" style="width: min(640px, 92vw); max-height: 80vh; display: flex; flex-direction: column; padding: 24px; border-radius: 12px; background: rgba(255, 255, 255, 0.98); box-shadow: 0 20px 40px rgba(0,0,0,0.15); border: 1px solid rgba(148, 163, 184, 0.2);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); padding-bottom: 10px;">
                        <h3 id="data-analysis-compare-modal-title" style="margin: 0; font-size: 1.05rem; font-weight: 800; color: var(--text-main);">比对明细</h3>
                        <button id="data-analysis-compare-modal-close" class="btn-secondary" style="height: 32px; padding: 0 12px; border-radius: 7px; font-size: 0.8rem; border-color: rgba(148, 163, 184, 0.3); color: var(--text-main); font-weight: 700; cursor: pointer;" type="button">关闭</button>
                    </div>
                    <div id="data-analysis-compare-modal-content" class="data-analysis-compare-modal-content" style="flex: 1; overflow-y: auto; max-height: 55vh; padding-right: 4px;">
                    </div>
                </div>
            </div>

            <!-- 编辑数据集信息弹窗 -->
            <div id="data-analysis-edit-dataset-modal" class="modal-overlay hidden" style="z-index: 8000;">
                <div class="modal" style="width: min(500px, 92vw); padding: 22px; border-radius: 12px; background: rgba(255, 255, 255, 0.98); box-shadow: 0 20px 40px rgba(0,0,0,0.15); border: 1px solid rgba(148, 163, 184, 0.2);">
                    <div style="margin-bottom: 16px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); padding-bottom: 10px;">
                        <h3 style="margin: 0; font-size: 1.05rem; font-weight: 800; color: var(--text-main);">编辑数据集</h3>
                    </div>
                    <form id="data-analysis-edit-dataset-form" style="display: flex; flex-direction: column; gap: 14px;">
                        <input id="data-analysis-edit-dataset-id" type="hidden">
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 0.82rem; font-weight: 700; color: var(--text-main);">数据集名称 <span style="color: #ef4444;">*</span></label>
                            <input id="data-analysis-edit-dataset-name" class="form-input" type="text" maxlength="100" required style="width: 100%; height: 38px; border-radius: 8px; font-size: 0.85rem; padding: 0 12px; margin-bottom: 0;" placeholder="请输入数据集名称">
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="font-size: 0.82rem; font-weight: 700; color: var(--text-main);">原始文件名 / 来源备注</label>
                            <input id="data-analysis-edit-dataset-original-name" class="form-input" type="text" maxlength="255" style="width: 100%; height: 38px; border-radius: 8px; font-size: 0.85rem; padding: 0 12px; margin-bottom: 0;" placeholder="例如: 2026_Q1_sales.xlsx">
                        </div>
                        <div id="data-analysis-edit-dataset-meta" style="padding: 10px 12px; background: rgba(148, 163, 184, 0.08); border-radius: 8px; font-size: 0.78rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 4px;">
                        </div>
                        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; border-top: 1px solid rgba(148, 163, 184, 0.16); padding-top: 12px;">
                            <button id="data-analysis-edit-dataset-cancel" class="btn-secondary" style="height: 34px; padding: 0 14px; border-radius: 8px; font-size: 0.8rem; cursor: pointer;" type="button">取消</button>
                            <button id="data-analysis-edit-dataset-save" class="btn-primary" style="height: 34px; padding: 0 14px; border-radius: 8px; font-size: 0.8rem; font-weight: 700; cursor: pointer;" type="submit">保存修改</button>
                        </div>
                    </form>
                </div>
            </div>
        `);
        body.appendChild(view);
        bindEvents(view);
        return view;
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
            cleaning: {
                title: '数据清洗',
                desc: '识别缺失、重复、格式与离群问题，按可预览、可回放的规则生成新的清洗后数据集。'
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
                title: '智能分析',
                desc: '调用大语言模型智能分析数据集，提供分析方向、推荐图表与报告摘要等深度洞察。'
            },
            history: {
                title: '历史记录',
                desc: '查看当前数据集在图表生成、数据透视、数据比对、导出和 SQL 查询中的历史记录。'
            }
        };

        const header = headers[tab] || headers.overview;
        titleEl.textContent = header.title;
        metaEl.textContent = header.desc;
        if (actionsEl) {
            PivotSafeHtml.setHtml(actionsEl, tab === 'overview' ? `
                <label class="btn-secondary data-analysis-upload-action">
                    <input id="data-analysis-file" type="file" accept=".csv,.xlsx,.xls,.sqlite,.sqlite3,.db">
                    <span>上传 Excel / CSV / SQLite</span>
                </label>
                <button id="data-analysis-import-db" class="btn-secondary" type="button">从服务器可访问数据库导入</button>
                <button id="data-analysis-overview-refresh" class="btn-secondary" type="button">\u5237\u65b0\u5217\u8868</button>
            ` : '');
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
            PivotSafeHtml.setHtml(body, '<tr><td colspan="7" class="text-center data-analysis-empty-cell">\u6682\u65e0\u6570\u636e\u96c6\uff0c\u8bf7\u4e0a\u4f20\u6216\u5bfc\u5165\u3002</td></tr>');
            if (pager) PivotSafeHtml.setHtml(pager, '');
            return;
        }
        const startIndex = (state.overviewPage - 1) * pageSize;
        const pageRows = state.datasets.slice(startIndex, startIndex + pageSize);
        PivotSafeHtml.setHtml(body, pageRows.map((dataset, offset) => {
            const rowIndex = startIndex + offset;
            const scopeBadge = dataset.scopeUnknown
                ? `<span class="data-analysis-unknown-badge" title="${esc(dataset.truncationReason || '历史数据范围未知')}">范围未知</span>`
                : dataset.truncated
                ? `<span class="data-analysis-truncated-badge" title="${esc(dataset.truncationReason || '数据集已达到导入上限')}">已截断</span>`
                : '<span class="data-analysis-complete-badge">当前范围完整</span>';
            const fileTypeLabel = dataset.fileType === 'cleaned' ? '清洗后数据' : (dataset.fileType || '\u8868\u683c');
            return (
                '<tr>' +
                    '<td class="text-center data-analysis-row-index">' + (rowIndex + 1) + '</td>' +
                    '<td class="data-analysis-dataset-name" title="' + esc(dataset.name) + '">' + esc(dataset.name) + '</td>' +
                    '<td class="data-analysis-break-text" title="' + esc(dataset.originalName || '-') + '">' + esc(dataset.originalName || '-') + '</td>' +
                    '<td class="data-analysis-size-cell"><div class="data-analysis-size-wrapper"><span>' + fmtNumber(dataset.rowCount) + ' \u884c / ' + fmtNumber(dataset.columnCount) + ' \u5217</span>' + scopeBadge + '</div></td>' +
                    '<td><span class="data-analysis-file-type">' + esc(fileTypeLabel) + '</span></td>' +
                    '<td class="data-analysis-muted-cell">' + esc(dataset.createdAt || '-') + '</td>' +
                    '<td class="text-center"><div class="data-analysis-table-actions">' +
                        '<button class="btn-secondary data-analysis-table-btn" type="button" data-data-analysis-action-preview="' + esc(dataset.id) + '">\u9884\u89c8</button>' +
                        '<button class="btn-secondary data-analysis-table-btn" type="button" data-data-analysis-action-edit="' + esc(dataset.id) + '">\u7f16\u8f91</button>' +
                        '<button class="btn-secondary data-analysis-table-btn" type="button" data-data-analysis-action-export="' + esc(dataset.id) + '">\u5bfc\u51fa</button>' +
                        '<button class="btn-secondary data-analysis-table-btn is-danger" type="button" data-data-analysis-action-delete="' + esc(dataset.id) + '">\u5220\u9664</button>' +
                    '</div></td>' +
                '</tr>'
            );
        }).join(''));
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
        PivotSafeHtml.setHtml(pager, '');
    }

    async function previewDataset(id, page = 1, { silent = false } = {}) {
        const isModalOpen = !document.getElementById('data-analysis-preview-modal')?.classList.contains('hidden');
        if (!silent && !isModalOpen) {
            setBusy(true, '正在加载预览数据...');
        }
        try {
            const pageSize = state.previewPageSize || 25;
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(id)}?page=${page}&pageSize=${pageSize}`);
            const dataset = data?.dataset;
            if (!dataset) throw new Error('未能加载数据集详情');

            const index = state.datasets.findIndex(item => item.id === id);
            if (index >= 0) {
                state.datasets[index] = { ...state.datasets[index], ...dataset };
            }
            state.previewDatasetId = id;
            state.previewPage = page;

            renderPreviewModal(dataset, page, pageSize);
        } catch (e) {
            toast(e && e.message ? e.message : '预览数据加载失败', 'error');
        } finally {
            if (!silent && !isModalOpen) {
                setBusy(false);
            }
        }
    }

    function renderPreviewModal(dataset, page = 1, pageSize = 25) {
        const modal = document.getElementById('data-analysis-preview-modal');
        const title = document.getElementById('data-analysis-preview-modal-title');
        const meta = document.getElementById('data-analysis-preview-modal-meta');
        const content = document.getElementById('data-analysis-preview-modal-content');
        const pager = document.getElementById('data-analysis-preview-pagination');
        if (!modal || !content || !title) return;

        title.textContent = `数据预览 - ${dataset.name}`;
        const total = dataset.rowCount || dataset.previewTotal || (dataset.previewRows || []).length;
        const colCount = dataset.columns?.length || 0;
        if (meta) {
            meta.textContent = `共 ${fmtNumber(total)} 行数据 · ${colCount} 个字段`;
        }

        const startIndex = (page - 1) * pageSize;
        const rows = dataset.previewRows || [];
        const columns = dataset.columns || [];

        if (!rows.length || !columns.length) {
            PivotSafeHtml.setHtml(content, '<div class="data-analysis-empty">暂无预览数据</div>');
        } else {
            PivotSafeHtml.setHtml(content, `
                <table class="data-table compact-table data-analysis-result-table">
                    <thead>
                        <tr>
                            <th style="width: 40px; min-width: 40px; text-align: center;">#</th>
                            ${columns.map(column => `<th>${esc(column.name)}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((row, idx) => `
                            <tr>
                                <td style="text-align: center; color: #94a3b8; font-size: 0.70rem;">${startIndex + idx + 1}</td>
                                ${columns.map(column => {
                                    const val = row[column.key] ?? '';
                                    const strVal = String(val);
                                    return `<td data-cell-full="${esc(strVal)}">${esc(strVal)}</td>`;
                                }).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `);
        }

        if (pager && window.renderWorkspacePagination) {
            window.renderWorkspacePagination(pager, {
                total,
                page,
                limit: pageSize,
                onPageChange: targetPage => {
                    previewDataset(dataset.id, targetPage, { silent: true });
                }
            });
        }
        modal.classList.remove('hidden');
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
        PivotSafeHtml.setHtml(el, htmlText);
        if (Array.from(el.options).some(option => option.value === previous)) {
            el.value = previous;
        } else {
            el.value = '';
        }
    }

    function renderControls() {
        const dataset = activeDataset();
        const columns = dataset?.columns || [];
        setSelectOptions('data-analysis-chart-x', buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择分类字段' }));
        setSelectOptions('data-analysis-chart-y', buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择数值字段' }));
        setSelectOptions('data-analysis-chart-group', buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择分组字段' }));
        syncChartAggregationControls('auto');
        syncChartTypeControls('auto');
        
        const datasetOptions = `<option value="">请选择数据集</option>` + state.datasets.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
        setSelectOptions('data-analysis-compare-left', datasetOptions, state.compareLeftId);
        setSelectOptions('data-analysis-compare-right', datasetOptions, state.compareRightId);
        renderCompareKeyOptions();

        // 渲染各个具体分析页面的数据集选择框
        setSelectOptions('data-analysis-chart-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-cleaning-dataset', datasetOptions, state.cleaningDatasetId || state.activeId);
        setSelectOptions('data-analysis-query-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-pivot-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-ai-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-semantic-dataset', datasetOptions, state.semanticDatasetId || state.activeId || '');
        setSelectOptions('data-analysis-history-dataset', datasetOptions, state.activeId);
        
        // 渲染可视化查询编辑器
        renderVisualQueryControls();

        // 渲染智能分析数据集画像与引导看板
        app.renderAiDatasetProfile?.();
        app.renderSemanticControls?.();
        app.renderCleaning?.();
    }

    function renderCompareKeyOptions() {
        const leftId = document.getElementById('data-analysis-compare-left')?.value;
        const rightId = document.getElementById('data-analysis-compare-right')?.value;
        const left = state.datasets.find(item => item.id === leftId) || null;
        const right = state.datasets.find(item => item.id === rightId) || null;
        setSelectOptions('data-analysis-compare-left-key', buildOptions(left?.columns || [], { includeEmpty: true, emptyLabel: '请选择左侧主键' }));
        setSelectOptions('data-analysis-compare-right-key', buildOptions(right?.columns || [], { includeEmpty: true, emptyLabel: '请选择右侧主键' }));
        setSelectOptions('data-analysis-compare-field', buildOptions(left?.columns || [], { includeEmpty: true, emptyLabel: '请选择对比字段（留空仅比对主键）' }));
    }

    Object.assign(app, {
        ensureView,
        updateToolbarHeader,
        renderHeader,
        renderOverview,
        previewDataset,
        buildOptions,
        setSelectOptions,
        renderControls,
        renderCompareKeyOptions
    });
})();
