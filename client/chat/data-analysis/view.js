
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber, activeDataset } = app;
    const fetchJson = (...args) => app.fetchJson(...args);
    const setBusy = (...args) => app.setBusy(...args);
    const toast = (...args) => app.toast(...args);
    const bindEvents = (...args) => app.bindEvents(...args);
    const buildTable = (...args) => app.buildTable(...args);
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
                        <div class="data-analysis-query-header">
                            <div class="data-analysis-dataset-selector-wrap">
                                <span>分析数据集</span>
                                <select id="data-analysis-query-dataset" class="form-input"></select>
                            </div>
                            <div class="data-analysis-query-mode-selector">
                                <button type="button" class="btn-secondary active" id="data-analysis-query-mode-visual">可视化查询</button>
                                <button type="button" class="btn-secondary" id="data-analysis-query-mode-sql">SQL 查询 (高级)</button>
                            </div>
                        </div>
                        
                        <!-- 可视化查询编辑器 -->
                        <div id="data-analysis-query-visual-box" class="data-analysis-query-visual-box">
                            <div style="margin-bottom: 14px;">
                                <div class="data-analysis-query-filter-header">
                                    <span class="data-analysis-query-filter-title">筛选条件</span>
                                    <div class="data-analysis-query-relation">
                                        <span>条件关系:</span>
                                        <select id="data-analysis-query-visual-op" class="form-input">
                                            <option value="AND">且 (AND)</option>
                                            <option value="OR">或 (OR)</option>
                                        </select>
                                    </div>
                                </div>
                                <div id="data-analysis-query-visual-filters" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px;">
                                    <!-- 动态渲染筛选条件行 -->
                                </div>
                                <button type="button" id="data-analysis-query-visual-add" class="btn-secondary data-analysis-query-add-btn">+ 添加筛选条件</button>
                            </div>
                            
                            <div class="data-analysis-query-settings-grid">
                                <label>
                                    排序字段
                                    <select id="data-analysis-query-visual-sort-field" class="form-input"></select>
                                </label>
                                <label>
                                    排序方式
                                    <select id="data-analysis-query-visual-sort-order" class="form-input">
                                        <option value="ASC">升序 (ASC)</option>
                                        <option value="DESC">降序 (DESC)</option>
                                    </select>
                                </label>
                                <label>
                                    限制行数
                                    <input type="number" id="data-analysis-query-visual-limit" class="form-input" min="1" max="5000" value="100">
                                </label>
                            </div>
                            
                            <div class="data-analysis-query-actions">
                                <span class="data-analysis-query-hint">通过可视化选项配置快速筛选数据。</span>
                                <button id="data-analysis-run-query-visual" class="btn-primary" type="button">运行查询</button>
                            </div>
                        </div>
                        
                        <!-- SQL 查询编辑器（高级） -->
                        <div id="data-analysis-query-sql-box" class="data-analysis-query-sql-box hidden">
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
                        <div class="data-analysis-pivot-workspace">
                            <div class="data-analysis-pivot-config">
                                <div class="data-analysis-pivot-config-main">
                                    <label>分析数据集<select id="data-analysis-pivot-dataset" class="form-input"></select></label>
                                    <label>行维度<select id="data-analysis-pivot-row" class="form-input"></select></label>
                                    <label>列维度<select id="data-analysis-pivot-col" class="form-input"></select></label>
                                    <label>值字段<select id="data-analysis-pivot-value" class="form-input"></select></label>
                                    <label>聚合<select id="data-analysis-pivot-aggregation" class="form-input">
                                        <option value="sum">求和 (SUM)</option>
                                        <option value="count">计数 (COUNT)</option>
                                        <option value="avg">平均 (AVG)</option>
                                        <option value="max">最大 (MAX)</option>
                                        <option value="min">最小 (MIN)</option>
                                    </select></label>
                                </div>
                                <div class="data-analysis-pivot-config-sub">
                                    <label>排序<select id="data-analysis-pivot-sort" class="form-input">
                                        <option value="total_desc">按指标值降序</option>
                                        <option value="total_asc">按指标值升序</option>
                                        <option value="label_asc">按行名升序</option>
                                        <option value="label_desc">按行名降序</option>
                                    </select></label>
                                    <label>占比显示<select id="data-analysis-pivot-percent-mode" class="form-input">
                                        <option value="none">不显示单元格占比</option>
                                        <option value="row">行内百分比</option>
                                        <option value="column">列内百分比</option>
                                        <option value="total">总占比</option>
                                    </select></label>
                                    <label>行 Top N<input id="data-analysis-pivot-row-limit" class="form-input" type="number" min="1" max="200" value="50"></label>
                                    <label>列 Top N<input id="data-analysis-pivot-col-limit" class="form-input" type="number" min="1" max="50" value="20"></label>
                                    <label>空值名称<input id="data-analysis-pivot-empty-label" class="form-input" type="text" value="(空值)" maxlength="40"></label>
                                </div>
                                <div class="data-analysis-pivot-toolbar">
                                    <span id="data-analysis-pivot-hint" class="data-analysis-pivot-hint">选择适合分组的维度，并用 Top N 控制大表展示规模。</span>
                                    <div class="data-analysis-pivot-toolbar-actions">
                                        <button id="data-analysis-pivot-recommend" class="btn-secondary" type="button">推荐配置</button>
                                        <button id="data-analysis-run-pivot" class="btn-primary" type="button">开始透视</button>
                                        <button id="data-analysis-pivot-export-btn" class="btn-secondary hidden" type="button">导出 CSV</button>
                                    </div>
                                </div>
                            </div>
                            <div id="data-analysis-pivot-result" class="data-analysis-pivot-result"></div>
                        </div>
                    </section>
                    <section id="data-analysis-ai-panel" class="data-analysis-tab-panel hidden">
                        <!-- 智能分析二级 Sub-Tab 切换 -->
                        <div class="data-analysis-subtabs-nav">
                            <button id="data-analysis-subtab-btn-chat" class="data-analysis-subtab active" type="button" data-ai-subtab="chat">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                                <span>即时 AI 探索与深度分析</span>
                            </button>
                            <button id="data-analysis-subtab-btn-semantic" class="data-analysis-subtab" type="button" data-ai-subtab="semantic">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2 2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                                <span>全量语义分析任务</span>
                            </button>
                        </div>

                        <!-- 子面板 1：即时 AI 探索与深度分析 (全宽展示) -->
                        <div id="data-analysis-ai-subpanel-chat" class="data-analysis-ai-subpanel">
                            <div class="data-analysis-dataset-selector-wrap" style="margin-bottom: 10px;">
                                <span>分析数据集</span>
                                <select id="data-analysis-ai-dataset" class="form-input"></select>
                            </div>
                            <div class="data-analysis-ai-box">
                                <textarea id="data-analysis-ai-prompt" class="form-input" placeholder="询问这个数据集的分析方向、风险点、推荐图表或报告摘要"></textarea>
                                <div class="data-analysis-ai-actions">
                                    <label class="data-analysis-ai-toggle"><input type="checkbox" id="data-analysis-ai-deep"> 深度分析（可查询数据 / 生成图表）</label>
                                    <div class="data-analysis-ai-buttons">
                                        <button id="data-analysis-ai-stop" class="btn-danger-outline hidden" type="button">停止生成</button>
                                        <button id="data-analysis-ai-run" class="btn-primary" type="button">生成建议</button>
                                    </div>
                                </div>
                            </div>
                            <div id="data-analysis-ai-result" class="data-analysis-ai-result message-content"></div>
                        </div>

                        <!-- 子面板 2：全量语义分析任务 (全宽展示) -->
                        <div id="data-analysis-ai-subpanel-semantic" class="data-analysis-ai-subpanel hidden">
                            <div class="data-analysis-semantic-box">
                                <div class="data-analysis-semantic-heading">
                                    <div class="data-analysis-ai-col-title-group">
                                        <h5>全量语义分析任务</h5>
                                        <p>按 Token 分批处理所选文本字段，所有记录完成后生成汇总报告。</p>
                                    </div>
                                    <span id="data-analysis-semantic-status" class="data-analysis-semantic-status">未选择分析数据集</span>
                                </div>
                                <div class="data-analysis-dataset-selector-wrap" style="margin-bottom: 10px;">
                                    <span>分析数据集</span>
                                    <select id="data-analysis-semantic-dataset" class="form-input"></select>
                                </div>
                                <div class="data-analysis-form-grid data-analysis-semantic-controls">
                                    <label>文本字段<select id="data-analysis-semantic-field" class="form-input"></select></label>
                                    <label>记录标识字段（可选）<select id="data-analysis-semantic-id-field" class="form-input"></select></label>
                                    <label>每批 Token 预算<input id="data-analysis-semantic-batch-tokens" class="form-input" type="number" min="8000" max="60000" step="1000" value="24000"></label>
                                </div>
                                <textarea id="data-analysis-semantic-instruction" class="form-input data-analysis-semantic-instruction" placeholder="例如：逐条提取主题、情感、风险和摘要；不得跳过任何记录，最后汇总主要问题与建议。"></textarea>
                                <div class="data-analysis-semantic-actions">
                                    <button id="data-analysis-semantic-run" class="btn-primary" type="button">启动全量任务</button>
                                    <button id="data-analysis-semantic-cancel" class="btn-secondary hidden" type="button">取消任务</button>
                                    <button id="data-analysis-semantic-retry" class="btn-secondary hidden" type="button">重试失败任务</button>
                                </div>
                                <div id="data-analysis-semantic-progress" class="data-analysis-semantic-progress"></div>
                                <div id="data-analysis-semantic-report" class="data-analysis-semantic-report message-content"></div>
                            </div>
                        </div>
                    </section>

                    <section id="data-analysis-history-panel" class="data-analysis-tab-panel hidden">
                        <div class="data-analysis-dataset-selector-wrap" style="margin-bottom: 12px;">
                            <span>分析数据集</span>
                            <select id="data-analysis-history-dataset" class="form-input"></select>
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
            return (
                '<tr>' +
                    '<td class="text-center data-analysis-row-index">' + (rowIndex + 1) + '</td>' +
                    '<td class="data-analysis-dataset-name">' + esc(dataset.name) + '</td>' +
                    '<td class="data-analysis-break-text">' + esc(dataset.originalName || '-') + '</td>' +
                    '<td>' + fmtNumber(dataset.rowCount) + ' \u884c / ' + fmtNumber(dataset.columnCount) + ' \u5217<br>' + scopeBadge + '</td>' +
                    '<td><span class="data-analysis-file-type">' + esc(dataset.fileType || '\u8868\u683c') + '</span></td>' +
                    '<td class="data-analysis-muted-cell">' + esc(dataset.createdAt || '-') + '</td>' +
                    '<td class="text-center"><div class="data-analysis-table-actions">' +
                        '<button class="btn-secondary data-analysis-table-btn" type="button" data-data-analysis-action-preview="' + esc(dataset.id) + '">\u9884\u89c8</button>' +
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
                PivotSafeHtml.setHtml(content, buildTable(dataset.previewRows || [], dataset.columns || []));
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
        setSelectOptions('data-analysis-query-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-pivot-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-ai-dataset', datasetOptions, state.activeId);
        setSelectOptions('data-analysis-semantic-dataset', datasetOptions, state.semanticDatasetId || '');
        setSelectOptions('data-analysis-history-dataset', datasetOptions, state.activeId);
        
        // 渲染可视化查询编辑器
        renderVisualQueryControls();
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
