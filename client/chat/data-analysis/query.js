
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber, activeDataset } = app;
    const buildOptions = (...args) => app.buildOptions(...args);
    const setSelectOptions = (...args) => app.setSelectOptions(...args);
    const fetchJson = (...args) => app.fetchJson(...args);
    const guardButton = (...args) => app.guardButton(...args);
    const toast = (...args) => app.toast(...args);

    function renderVisualQueryControls() {
        const dataset = activeDataset();
        const columns = dataset?.columns || [];
        
        // 逻辑关系下拉框设置
        const opEl = document.getElementById('data-analysis-query-visual-op');
        if (opEl) opEl.value = state.visualQuery.logicalOperator || 'AND';
        
        // 限制条数设置
        const limitEl = document.getElementById('data-analysis-query-visual-limit');
        if (limitEl) limitEl.value = state.visualQuery.limit || 100;
        
        // 排序方式下拉框设置
        const orderEl = document.getElementById('data-analysis-query-visual-sort-order');
        if (orderEl) orderEl.value = state.visualQuery.sortOrder || 'ASC';
        
        // 渲染排序字段下拉框
        setSelectOptions('data-analysis-query-visual-sort-field', buildOptions(columns, { includeEmpty: true, emptyLabel: '不排序' }), state.visualQuery.sortField);
        
        // 渲染筛选行条件列表
        renderVisualFilters();
    }

    function renderVisualFilters() {
        const container = document.getElementById('data-analysis-query-visual-filters');
        if (!container) return;
        
        const dataset = activeDataset();
        const columns = dataset?.columns || [];
        const filters = state.visualQuery.filters;
        
        if (filters.length === 0) {
            PivotSafeHtml.setHtml(container, `
                <div class="data-analysis-query-filter-empty">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                    <span>当前未设置筛选条件，将查询全部数据。点击上方「+ 添加条件」即可新增过滤规则。</span>
                </div>
            `);
            return;
        }
        
        const opOptions = [
            { value: 'eq', label: '等于 (=)' },
            { value: 'ne', label: '不等于 (!=)' },
            { value: 'contains', label: '包含' },
            { value: 'not_contains', label: '不包含' },
            { value: 'gt', label: '大于 (>)' },
            { value: 'gte', label: '大于等于 (>=)' },
            { value: 'lt', label: '小于 (<)' },
            { value: 'lte', label: '小于等于 (<=)' },
            { value: 'null', label: '为空' },
            { value: 'not_null', label: '不为空' }
        ];
        
        PivotSafeHtml.setHtml(container, filters.map((filter, index) => {
            const fieldOptionsHtml = buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择字段' });
            const operatorOptionsHtml = opOptions.map(op => `<option value="${op.value}" ${filter.operator === op.value ? 'selected' : ''}>${esc(op.label)}</option>`).join('');
            const showValueInput = !['null', 'not_null'].includes(filter.operator);
            
            return `
                <div class="data-analysis-query-filter-row" data-filter-index="${index}">
                    <span class="data-analysis-query-filter-index">${index + 1}</span>
                    <select class="form-input data-analysis-query-filter-field">
                        ${fieldOptionsHtml}
                    </select>
                    <select class="form-input data-analysis-query-filter-operator">
                        ${operatorOptionsHtml}
                    </select>
                    <input type="text" class="form-input data-analysis-query-filter-value" style="${showValueInput ? '' : 'display: none;'}" value="${esc(filter.value)}" placeholder="请输入筛选值">
                    <button type="button" class="data-analysis-query-filter-remove" title="删除条件">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        <span>删除</span>
                    </button>
                </div>
            `;
        }).join(''));
        
        // 分别为每个渲染出来的 field select 设置当前选中的 value
        filters.forEach((filter, index) => {
            const row = container.querySelector(`[data-filter-index="${index}"]`);
            if (row) {
                const fieldSelect = row.querySelector('.data-analysis-query-filter-field');
                if (fieldSelect) fieldSelect.value = filter.field;
            }
        });
    }

    function buildTable(rows = [], columns = []) {
        if (!rows.length || !columns.length) return '<div class="data-analysis-empty">暂无预览数据</div>';
        return `
            <table class="data-table compact-table data-analysis-result-table">
                <thead><tr>${columns.map(column => `<th>${esc(column.name)}</th>`).join('')}</tr></thead>
                <tbody>
                    ${rows.slice(0, 80).map(row => `
                        <tr>${columns.map(column => {
                            const val = row[column.key] ?? '';
                            const strVal = String(val);
                            return `<td data-cell-full="${esc(strVal)}">${esc(strVal)}</td>`;
                        }).join('')}</tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    // 通用表渲染：columns 为列名字符串数组，rows 为按列名取值的对象数组。
    function buildTableFromRows(columns = [], rows = [], startIndex = 0) {
        if (!columns.length) return '<div class="data-analysis-empty">无结果</div>';
        return `
            <table class="data-table compact-table data-analysis-result-table">
                <thead>
                    <tr>
                        <th style="width: 54px; min-width: 54px; text-align: center;">#</th>
                        ${columns.map(name => `<th>${esc(name)}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${rows.length === 0 ? `<tr><td colspan="${columns.length + 1}" class="text-center data-analysis-empty-cell">暂无数据</td></tr>` : rows.map((row, idx) => `
                        <tr>
                            <td class="text-center data-analysis-row-index">${startIndex + idx + 1}</td>
                            ${columns.map(name => {
                                const val = row[name] ?? '';
                                const strVal = String(val);
                                return `<td data-cell-full="${esc(strVal)}">${esc(strVal)}</td>`;
                            }).join('')}
                        </tr>
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
            PivotSafeHtml.setHtml(box, '');
            return;
        }
        PivotSafeHtml.setHtml(box, `<span class="data-analysis-query-fields-label">可用字段：</span>${columns.map(column => `<button type="button" class="data-analysis-query-field" data-data-analysis-query-field="${esc(column.name)}">${esc(column.name)}</button>`).join('')}`);
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
            state.queryPage = 1;
            renderQuery();
        });
    }

    function renderQuery() {
        const box = document.getElementById('data-analysis-query-result');
        if (!box) return;
        if (!state.query) {
            PivotSafeHtml.setHtml(box, '<div class="data-analysis-query-empty"><div class="data-analysis-empty">编写并运行查询后在此查看结果</div></div>');
            return;
        }
        const result = state.query;
        const allRows = result.rows || [];
        const total = allRows.length;
        const pageSize = Math.max(Number(state.queryPageSize) || 10, 1);
        const pageCount = Math.max(Math.ceil(total / pageSize), 1);
        state.queryPage = Math.min(Math.max(Number(state.queryPage) || 1, 1), pageCount);

        const startIndex = (state.queryPage - 1) * pageSize;
        const pageRows = allRows.slice(startIndex, startIndex + pageSize);

        PivotSafeHtml.setHtml(box, `
            <div class="data-analysis-query-result-card">
                <div class="data-analysis-query-meta-bar">
                    <div class="data-analysis-query-meta-info">
                        <span class="data-analysis-query-meta-count">共 <strong>${fmtNumber(total)}</strong> 条结果${result.truncated ? `（已截断至前 ${fmtNumber(result.rowCount)} 行）` : ''}</span>
                        <span class="data-analysis-query-meta-page">第 ${state.queryPage} / ${pageCount} 页（每页 ${pageSize} 条）</span>
                    </div>
                    <button id="data-analysis-query-export-btn" class="btn-secondary data-analysis-query-export-btn" type="button">导出查询结果 (CSV)</button>
                </div>
                <div class="data-analysis-query-table">${buildTableFromRows(result.columns || [], pageRows, startIndex)}</div>
                <div id="data-analysis-query-pagination" class="pagination workspace-pagination data-analysis-query-pagination"></div>
            </div>
        `);

        const pager = document.getElementById('data-analysis-query-pagination');
        if (pager && window.renderWorkspacePagination) {
            window.renderWorkspacePagination(pager, {
                total,
                page: state.queryPage,
                limit: pageSize,
                onPageChange: targetPage => {
                    state.queryPage = targetPage;
                    renderQuery();
                }
            });
        }
    }

    function exportQueryResultToCsv() {
        if (!state.query || !state.query.columns || !state.query.rows) {
            toast('暂无查询结果可导出', 'warning');
            return;
        }
        const columns = state.query.columns || [];
        const rows = state.query.rows || [];

        const headerLine = columns.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',');
        const dataLines = rows.map(row => {
            return columns.map(col => {
                const val = row[col] ?? '';
                return `"${String(val).replace(/"/g, '""')}"`;
            }).join(',');
        });
        const csvContent = '\uFEFF' + [headerLine, ...dataLines].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', '数据查询结果.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function buildSqlFromVisual() {
        const dataset = activeDataset();
        if (!dataset) return '';
        
        let sql = 'SELECT * FROM data';
        
        const columns = dataset.columns || [];
        const filters = state.visualQuery.filters || [];
        const validFilters = filters.filter(f => f.field.trim() !== '');
        
        if (validFilters.length > 0) {
            const conditions = validFilters.map(filter => {
                const colKey = filter.field;
                const column = columns.find(c => c.key === colKey);
                const colName = column ? column.name : colKey;
                const fieldExpr = `"${colName.replace(/"/g, '""')}"`;
                const op = filter.operator;
                const rawVal = filter.value || '';
                const escapedVal = rawVal.replace(/'/g, "''");
                
                switch (op) {
                    case 'eq':
                        return `${fieldExpr} = '${escapedVal}'`;
                    case 'ne':
                        return `${fieldExpr} <> '${escapedVal}'`;
                    case 'contains':
                        return `${fieldExpr} LIKE '%${escapedVal}%'`;
                    case 'not_contains':
                        return `${fieldExpr} NOT LIKE '%${escapedVal}%'`;
                    case 'gt':
                        return `${fieldExpr} > '${escapedVal}'`;
                    case 'gte':
                        return `${fieldExpr} >= '${escapedVal}'`;
                    case 'lt':
                        return `${fieldExpr} < '${escapedVal}'`;
                    case 'lte':
                        return `${fieldExpr} <= '${escapedVal}'`;
                    case 'null':
                        return `(${fieldExpr} IS NULL OR trim(CAST(${fieldExpr} AS VARCHAR)) = '')`;
                    case 'not_null':
                        return `(${fieldExpr} IS NOT NULL AND trim(CAST(${fieldExpr} AS VARCHAR)) <> '')`;
                    default:
                        return '';
                }
            }).filter(c => c !== '');
            
            if (conditions.length > 0) {
                const logicOp = state.visualQuery.logicalOperator || 'AND';
                sql += ` WHERE ${conditions.map(c => `(${c})`).join(` ${logicOp} `)}`;
            }
        }
        
        const sortField = state.visualQuery.sortField;
        if (sortField) {
            const column = columns.find(c => c.key === sortField);
            const colName = column ? column.name : sortField;
            const order = state.visualQuery.sortOrder === 'DESC' ? 'DESC' : 'ASC';
            sql += ` ORDER BY "${colName.replace(/"/g, '""')}" ${order}`;
        }
        
        const limit = Number(state.visualQuery.limit) || 100;
        const safeLimit = Math.min(Math.max(limit, 1), 5000);
        sql += ` LIMIT ${safeLimit}`;
        
        return sql;
    }

    async function runQueryVisual() {
        const dataset = activeDataset();
        if (!dataset) {
            toast('请选择分析数据集', 'warning');
            return;
        }
        
        const filters = state.visualQuery.filters || [];
        for (let i = 0; i < filters.length; i++) {
            const f = filters[i];
            if (f.field && !['null', 'not_null'].includes(f.operator) && !f.value.trim()) {
                toast(`请为筛选条件第 ${i + 1} 行填入值`, 'warning');
                return;
            }
        }
        
        const sql = buildSqlFromVisual();
        if (!sql) {
            toast('生成查询语句失败', 'error');
            return;
        }
        
        await guardButton('data-analysis-run-query-visual', '查询中…', async () => {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql })
            });
            state.query = data;
            state.queryPage = 1;
            renderQuery();
        });
    }

    Object.assign(app, {
        renderVisualQueryControls,
        renderVisualFilters,
        buildTable,
        buildTableFromRows,
        renderQueryFields,
        runQuery,
        renderQuery,
        buildSqlFromVisual,
        runQueryVisual,
        exportQueryResultToCsv
    });
})();
