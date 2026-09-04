(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber } = app;
    const fetchJson = (...args) => app.fetchJson(...args);
    const toast = (...args) => app.toast(...args);
    const guardButton = (...args) => app.guardButton(...args);

    const OPERATIONS = [
        ['trim', '去除首尾空格'],
        ['normalize_empty', '空白值标准化为空值'],
        ['lowercase', '转换为小写'],
        ['uppercase', '转换为大写'],
        ['replace', '替换文本'],
        ['regex_replace', '正则替换'],
        ['fill_missing', '填充缺失值'],
        ['cast_number', '转换为数值（支持货币、千分位、百分比）'],
        ['cast_date', '转换为日期'],
        ['remove_missing', '移除缺失值所在记录'],
        ['remove_outliers', '按 IQR 移除离群值所在记录'],
        ['deduplicate', '按字段去重'],
        ['rename_column', '重命名字段'],
        ['drop_column', '删除字段']
    ];
    const OPERATION_LABELS = Object.fromEntries(OPERATIONS);

    const OPERATION_GROUPS = [
        {
            group: '文本洗练',
            items: [
                ['trim', '去除首尾空格'],
                ['normalize_empty', '空白值标准化为空值'],
                ['lowercase', '转换为小写'],
                ['uppercase', '转换为大写'],
                ['replace', '替换文本'],
                ['regex_replace', '正则替换']
            ]
        },
        {
            group: '缺失值与异常处理',
            items: [
                ['fill_missing', '填充缺失值'],
                ['remove_missing', '移除缺失值所在记录'],
                ['remove_outliers', '按 IQR 移除离群值所在记录']
            ]
        },
        {
            group: '格式转换与去重',
            items: [
                ['cast_number', '转换为数值（支持货币/千分位/百分比）'],
                ['cast_date', '转换为日期'],
                ['deduplicate', '按字段去重']
            ]
        },
        {
            group: '字段结构调整',
            items: [
                ['rename_column', '重命名字段'],
                ['drop_column', '删除字段']
            ]
        }
    ];

    function operationSelectOptions(selected) {
        return OPERATION_GROUPS.map(grp => `
            <optgroup label="${esc(grp.group)}">
                ${grp.items.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('')}
            </optgroup>
        `).join('');
    }

    function currentDataset() {
        const id = state.cleaningDatasetId || state.activeId;
        return state.datasets.find(item => item.id === id) || null;
    }

    function getColumns() {
        return currentDataset()?.columns || [];
    }

    function createRule(operation = 'trim', field = '') {
        return {
            id: `clean_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
            operation,
            field: field || getColumns()[0]?.key || '',
            fields: [],
            strategy: 'constant',
            value: '',
            search: '',
            replacement: '',
            factor: 1.5,
            includeEmpty: false,
            name: ''
        };
    }

    function fieldOptions(selected = '', emptyLabel = '请选择字段') {
        return `<option value="">${esc(emptyLabel)}</option>${getColumns().map(column => `<option value="${esc(column.key)}"${column.key === selected ? ' selected' : ''}>${esc(column.name)}</option>`).join('')}`;
    }

    function ruleExtraFields(rule) {
        if (rule.operation === 'replace' || rule.operation === 'regex_replace') {
            return `
                <label>查找<input class="form-input" data-cleaning-rule-input="search" value="${esc(rule.search || '')}" maxlength="500" placeholder="${rule.operation === 'regex_replace' ? '正则表达式' : '要替换的文本'}"></label>
                <label>替换为<input class="form-input" data-cleaning-rule-input="replacement" value="${esc(rule.replacement || '')}" maxlength="500" placeholder="可留空"></label>
            `;
        }
        if (rule.operation === 'fill_missing') {
            const strategies = [['constant', '固定值'], ['mean', '均值'], ['median', '中位数'], ['mode', '众数']];
            return `
                <label>填充方式<select class="form-input" data-cleaning-rule-input="strategy">${strategies.map(([value, label]) => `<option value="${value}"${rule.strategy === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
                ${rule.strategy === 'constant' ? `<label>填充值<input class="form-input" data-cleaning-rule-input="value" value="${esc(rule.value || '')}" maxlength="500" placeholder="例如：未知、0、未填写"></label>` : ''}
            `;
        }
        if (rule.operation === 'remove_outliers') {
            return `<label>IQR 系数<input class="form-input" type="number" min="0.1" max="20" step="0.1" data-cleaning-rule-input="factor" value="${esc(rule.factor ?? 1.5)}"></label>`;
        }
        if (rule.operation === 'rename_column') {
            return `<label>新字段名<input class="form-input" data-cleaning-rule-input="name" value="${esc(rule.name || '')}" maxlength="80" placeholder="输入新字段名"></label>`;
        }
        if (rule.operation === 'deduplicate') {
            const fields = Array.isArray(rule.fields) ? rule.fields : [];
            return `
                <div class="data-cleaning-dedup-fields">
                    <span>去重依据字段（可多选）</span>
                    <div>${getColumns().map(column => `<label><input type="checkbox" data-cleaning-dedup-field="${esc(column.key)}"${fields.includes(column.key) ? ' checked' : ''}>${esc(column.name)}</label>`).join('')}</div>
                    <label class="data-cleaning-check"><input type="checkbox" data-cleaning-rule-input="includeEmpty"${rule.includeEmpty ? ' checked' : ''}>将空白值也纳入去重匹配</label>
                </div>
            `;
        }
        return '';
    }

    function renderRules() {
        const box = document.getElementById('data-cleaning-rules');
        if (!box) return;
        if (!currentDataset()) {
            PivotSafeHtml.setHtml(box, `
                <div class="data-cleaning-empty-card">
                    <div class="data-cleaning-empty-card-inner">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
                        <div class="data-analysis-empty">请先选择需要清洗的数据集。</div>
                    </div>
                </div>
            `);
            return;
        }
        if (!state.cleaningRules.length) {
            PivotSafeHtml.setHtml(box, `
                <div class="data-cleaning-empty-card">
                    <div class="data-cleaning-empty-card-inner">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line></svg>
                        <div class="data-cleaning-rules-empty">还没有规则。可从左侧质量建议添加，或点击“添加规则”自定义清洗流程。</div>
                        <span class="data-cleaning-empty-sub">您也可以直接点击上方「常用快捷规则」按钮一键添加预置清洗步骤</span>
                    </div>
                </div>
            `);
            return;
        }
        PivotSafeHtml.setHtml(box, state.cleaningRules.map((rule, index) => `
            <article class="data-cleaning-rule" data-cleaning-rule-index="${index}">
                <div class="data-cleaning-rule-order">
                    <span class="data-cleaning-rule-step-badge">${index + 1}</span>
                </div>
                <div class="data-cleaning-rule-fields">
                    <label>操作类型<select class="form-input" data-cleaning-rule-input="operation">${operationSelectOptions(rule.operation)}</select></label>
                    ${rule.operation === 'deduplicate' ? '' : `<label>目标字段<select class="form-input" data-cleaning-rule-input="field">${fieldOptions(rule.field)}</select></label>`}
                    ${ruleExtraFields(rule)}
                </div>
                <div class="data-cleaning-rule-actions">
                    <button type="button" class="btn-secondary" data-cleaning-rule-move="up" title="上移规则"${index === 0 ? ' disabled' : ''}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"></polyline></svg>
                    </button>
                    <button type="button" class="btn-secondary" data-cleaning-rule-move="down" title="下移规则"${index === state.cleaningRules.length - 1 ? ' disabled' : ''}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </button>
                    <button type="button" class="btn-secondary data-cleaning-rule-delete" data-cleaning-rule-delete="${index}" title="删除规则">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        <span>删除</span>
                    </button>
                </div>
            </article>
        `).join(''));
    }

    function renderQuality() {
        const box = document.getElementById('data-cleaning-quality');
        if (!box) return;
        const quality = state.cleaningQuality;
        if (!currentDataset()) {
            PivotSafeHtml.setHtml(box, `
                <div class="data-cleaning-empty-hero">
                    <div class="data-cleaning-empty-icon-wrap">
                        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
                    </div>
                    <div class="data-cleaning-empty-content">
                        <h6>选择数据集后可查看缺失值、重复记录和字段质量状况。</h6>
                        <p>系统将自动对数据执行全量质量体检，输出健康评分、缺失单元格统计、完全重复行检测以及各字段类型与完整率。</p>
                        <div class="data-cleaning-feature-chips">
                            <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg> 缺失值检测与均值/中位数/常数填充</span>
                            <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg> 文本空白修剪与标准 NULL 归一</span>
                            <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg> IQR 四分位距离群极值过滤</span>
                            <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg> 字段精准去重与流水线影响预览</span>
                        </div>
                    </div>
                </div>
            `);
            return;
        }
        if (!quality) {
            PivotSafeHtml.setHtml(box, `
                <div class="data-cleaning-loading-card">
                    <div class="data-cleaning-spinner"></div>
                    <div class="data-cleaning-loading">正在加载数据质量报告…</div>
                </div>
            `);
            return;
        }
        const summary = quality.summary || {};
        const fields = Array.isArray(quality.fields) ? quality.fields : [];
        const totalRows = Number(summary.totalRows) || 0;
        const totalCols = Number(summary.totalColumns) || 0;
        const totalCells = totalRows * totalCols;
        const missingCells = Number(summary.missingCells) || 0;
        const dupRows = Number(summary.duplicateRows) || 0;
        const fillScore = totalCells > 0 ? Math.max(0, 100 - (missingCells / totalCells) * 100) : 100;
        const dupScore = totalRows > 0 ? Math.max(0, 100 - (dupRows / totalRows) * 100) : 100;
        const healthScore = Math.round(fillScore * 0.7 + dupScore * 0.3);
        let healthClass = 'good';
        let healthLabel = '质量优良';
        if (healthScore < 70) {
            healthClass = 'warning';
            healthLabel = '需重点清洗';
        } else if (healthScore < 90) {
            healthClass = 'fair';
            healthLabel = '基本良好';
        }

        PivotSafeHtml.setHtml(box, `
            <div class="data-cleaning-quality-bar">
                <div class="data-cleaning-quality-title">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
                    <strong>数据质量体检分析报告</strong>
                </div>
                <div class="data-cleaning-health-badge health-${healthClass}">
                    <span class="data-cleaning-health-dot"></span>
                    <span>数据健康评分：<strong>${healthScore} 分</strong> · ${healthLabel}</span>
                </div>
            </div>
            <div class="data-cleaning-kpis">
                <div class="data-cleaning-kpi-card kpi-rows">
                    <div class="data-cleaning-kpi-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
                    </div>
                    <div class="data-cleaning-kpi-meta">
                        <span>数据记录</span>
                        <strong>${fmtNumber(summary.totalRows)} 行</strong>
                    </div>
                </div>
                <div class="data-cleaning-kpi-card kpi-columns">
                    <div class="data-cleaning-kpi-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="12" y1="3" x2="12" y2="21"></line></svg>
                    </div>
                    <div class="data-cleaning-kpi-meta">
                        <span>字段数量</span>
                        <strong>${fmtNumber(summary.totalColumns)} 个</strong>
                    </div>
                </div>
                <div class="data-cleaning-kpi-card kpi-missing">
                    <div class="data-cleaning-kpi-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                    </div>
                    <div class="data-cleaning-kpi-meta">
                        <span>缺失单元格</span>
                        <strong>${fmtNumber(summary.missingCells)}</strong>
                    </div>
                </div>
                <div class="data-cleaning-kpi-card kpi-duplicates">
                    <div class="data-cleaning-kpi-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </div>
                    <div class="data-cleaning-kpi-meta">
                        <span>完全重复记录</span>
                        <strong>${fmtNumber(summary.duplicateRows)}</strong>
                    </div>
                </div>
            </div>
            <div class="data-cleaning-field-quality-wrap">
                <table class="data-table compact-table data-cleaning-field-quality">
                    <thead>
                        <tr>
                            <th>字段名称</th>
                            <th>推断类型</th>
                            <th style="min-width: 160px;">数据完整率</th>
                            <th>缺失数</th>
                            <th>去重值数</th>
                            <th>数值区间 / 代表值</th>
                        </tr>
                    </thead>
                    <tbody>${fields.map(field => {
                        const range = field.numeric ? `${fmtNumber(field.numeric.min)} ～ ${fmtNumber(field.numeric.max)}` : (field.samples || []).slice(0, 2).map(esc).join('、') || '—';
                        const fillRate = Math.round((Number(field.fillRate) || 0) * 100);
                        const fillClass = fillRate >= 95 ? 'rate-high' : (fillRate >= 70 ? 'rate-med' : 'rate-low');
                        return `
                            <tr>
                                <td><strong>${esc(field.name)}</strong></td>
                                <td><span class="data-cleaning-type type-${esc(field.type || 'text')}">${esc(field.type || 'text')}</span></td>
                                <td>
                                    <div class="data-cleaning-fill-bar-wrap">
                                        <div class="data-cleaning-fill-bar ${fillClass}">
                                            <span style="width: ${fillRate}%;"></span>
                                        </div>
                                        <span class="data-cleaning-fill-text">${fillRate}%</span>
                                    </div>
                                </td>
                                <td><span class="${field.empty > 0 ? 'text-warning font-bold' : 'text-muted'}">${fmtNumber(field.empty)}</span></td>
                                <td>${fmtNumber(field.distinct)}</td>
                                <td class="data-cleaning-sample-cell" title="${esc(range)}">${esc(range)}</td>
                            </tr>
                        `;
                    }).join('') || '<tr><td colspan="6" class="text-center">暂无字段质量数据</td></tr>'}</tbody>
                </table>
            </div>
        `);
    }

    function renderRecommendations() {
        const box = document.getElementById('data-cleaning-recommendations-list');
        if (!box) return;
        const items = state.cleaningQuality?.recommendations || [];
        if (!items.length) {
            PivotSafeHtml.setHtml(box, `
                <div class="data-cleaning-recommendations-empty-card">
                    <div class="data-cleaning-good-icon">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                    </div>
                    <div>
                        <strong>数据质量状态良好</strong>
                        <div class="data-cleaning-recommendations-empty">当前未发现可自动推荐的清洗规则。仍可手动添加规则。</div>
                    </div>
                </div>
            `);
            return;
        }
        PivotSafeHtml.setHtml(box, items.map((item, index) => `
            <article class="data-cleaning-recommendation">
                <div class="data-cleaning-rec-top">
                    <span class="data-cleaning-rec-badge">${esc(OPERATION_LABELS[item.operation] || '清洗建议')}</span>
                    <button type="button" class="btn-secondary data-cleaning-adopt-btn" data-cleaning-add-suggestion="${index}">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        <span>采纳规则</span>
                    </button>
                </div>
                <strong>${esc(item.title || OPERATION_LABELS[item.operation] || '清洗建议')}</strong>
                <span>${esc(item.description || '')}</span>
            </article>
        `).join(''));
    }

    function buildTable(rows, columns) {
        if (!rows?.length || !columns?.length) return '<div class="data-analysis-empty">暂无可展示的清洗后样本。</div>';
        return `<div class="data-cleaning-preview-table-wrap"><table class="data-table compact-table data-analysis-result-table"><thead><tr>${columns.map(column => `<th>${esc(column.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => `<td data-cell-full="${esc(String(row[column.key] ?? ''))}">${esc(String(row[column.key] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }

    function renderPreview() {
        const box = document.getElementById('data-cleaning-preview');
        if (!box) return;
        const preview = state.cleaningPreview;
        if (!preview) {
            PivotSafeHtml.setHtml(box, `
                <div class="data-cleaning-preview-empty data-cleaning-empty-card">
                    <div class="data-cleaning-empty-card-inner">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        <h6>清洗影响实时演算预览</h6>
                        <div class="data-cleaning-preview-empty-text">配置规则后可先预览行数、字段和样本变化，再生成新的清洗后数据集。</div>
                        <span class="data-cleaning-empty-sub">点击上方「预览清洗影响」，系统将在完整数据集上即时模拟演算，零风险验证规则效果</span>
                    </div>
                </div>
            `);
            return;
        }
        const summary = preview.summary || {};
        const changes = Object.entries(summary.changedByField || {}).filter(([, value]) => Number(value) > 0);
        PivotSafeHtml.setHtml(box, `
            <div class="data-cleaning-preview-head">
                <div class="data-cleaning-preview-head-title">
                    <div class="data-cleaning-preview-title-row">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        <h6>清洗预览</h6>
                        <span class="data-cleaning-preview-tag">演算样本：前 ${fmtNumber(preview.rows?.length || 0)} 行</span>
                    </div>
                    <span>规则已在完整数据集上计算，以下展示前 ${fmtNumber(preview.rows?.length || 0)} 行样本。</span>
                </div>
                <div class="data-cleaning-preview-kpis">
                    <span class="kpi-pill kpi-in"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>输入 ${fmtNumber(summary.inputRows)} 行</span>
                    <span class="kpi-pill kpi-out"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>输出 ${fmtNumber(summary.outputRows)} 行</span>
                    <span class="kpi-pill kpi-removed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>移除 ${fmtNumber(summary.removedRows)} 行</span>
                    <span class="kpi-pill kpi-changed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>变更 ${fmtNumber(summary.changedRows)} 行 / ${fmtNumber(summary.changedCells)} 格</span>
                </div>
            </div>
            ${changes.length ? `<div class="data-cleaning-changed-fields"><span class="data-cleaning-changed-label">字段变更：</span>${changes.map(([key, value]) => `<span class="data-cleaning-changed-chip">${esc(getColumns().find(column => column.key === key)?.name || key)} <strong>${fmtNumber(value)}</strong> 格</span>`).join('')}</div>` : ''}
            ${summary.droppedColumns ? `<div class="data-cleaning-changed-fields data-cleaning-dropped-fields"><span class="data-cleaning-changed-label">字段裁剪：</span><span>已删除 ${fmtNumber(summary.droppedColumns)} 个字段</span></div>` : ''}
            ${buildTable(preview.rows, preview.columns)}
        `);
    }

    function renderRuns() {
        const box = document.getElementById('data-cleaning-runs');
        if (!box) return;
        const runs = state.cleaningRuns || [];
        if (!runs.length) {
            PivotSafeHtml.setHtml(box, `
                <div class="data-cleaning-runs-empty data-cleaning-empty-card">
                    <div class="data-cleaning-empty-card-inner">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        <p>尚未生成清洗后数据集。每次生成都会在此保留规则和影响统计。</p>
                        <span class="data-cleaning-empty-sub">支持随时载入历史规则进行二次调整，或一键复跑再次生成新版本</span>
                    </div>
                </div>
            `);
            return;
        }
        PivotSafeHtml.setHtml(box, `
            <div class="data-cleaning-runs-table-wrap">
                <table class="data-table compact-table data-cleaning-runs-table">
                    <thead>
                        <tr>
                            <th class="col-index">序号</th>
                            <th class="col-version">版本</th>
                            <th class="col-name">清洗后数据集名称</th>
                            <th class="col-rows">行数变化</th>
                            <th class="col-cols">列数变化</th>
                            <th class="col-rules">应用规则</th>
                            <th class="col-created">清洗时间</th>
                            <th class="col-actions">操作</th>
                        </tr>
                    </thead>
                    <tbody>${runs.map((run, idx) => {
                        const summary = run.summary || {};
                        return `
                            <tr>
                                <td class="col-index"><span class="data-cleaning-row-index">${idx + 1}</span></td>
                                <td class="col-version"><span class="data-cleaning-run-vbadge">v${runs.length - idx}</span></td>
                                <td class="col-name"><strong class="data-cleaning-run-name" title="${esc(run.name || '未命名清洗')}">${esc(run.name || '未命名清洗')}</strong></td>
                                <td class="col-rows"><span class="data-cleaning-flow-stat">${fmtNumber(summary.inputRows)} 行 <span class="data-cleaning-flow-arrow">→</span> ${fmtNumber(summary.outputRows)} 行</span></td>
                                <td class="col-cols"><span class="data-cleaning-flow-stat">${fmtNumber(summary.inputColumns)} 列 <span class="data-cleaning-flow-arrow">→</span> ${fmtNumber(summary.outputColumns)} 列</span></td>
                                <td class="col-rules"><span class="data-cleaning-type">${fmtNumber(run.rules?.length || 0)} 条规则</span></td>
                                <td class="col-created"><span class="data-cleaning-muted-cell">${esc(run.createdAt || '—')}</span></td>
                                <td class="col-actions">
                                    <div class="data-cleaning-table-actions">
                                        ${run.outputDatasetId ? `
                                            <button class="btn-secondary data-cleaning-table-btn" type="button" data-cleaning-open-output="${esc(run.outputDatasetId)}" title="前往总览查看该清洗结果数据集">
                                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                                                <span>查看数据集</span>
                                            </button>
                                        ` : ''}
                                        <button class="btn-secondary data-cleaning-table-btn" type="button" data-cleaning-load-run="${esc(run.id)}" title="载入此版本规则至当前编排面板">
                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 15v4c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-4M17 9l-5 5-5-5M12 12.8V2.5"></path></svg>
                                            <span>载入规则</span>
                                        </button>
                                        <button class="btn-secondary data-cleaning-table-btn" type="button" data-cleaning-replay-run="${esc(run.id)}" title="使用本版本历史规则重新生成新派生数据集">
                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path></svg>
                                            <span>再次生成</span>
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('')}</tbody>
                </table>
            </div>
        `);
    }

    function switchCleaningTab(tabName = 'rules') {
        state.cleaningActiveTab = tabName;
        if (typeof document?.querySelectorAll === 'function') {
            document.querySelectorAll('.data-cleaning-tab-btn').forEach(btn => {
                const isActive = btn.dataset?.cleaningTab === tabName;
                if (btn.classList?.toggle) {
                    btn.classList.toggle('active', isActive);
                } else if (isActive) {
                    btn.classList?.add?.('active');
                } else {
                    btn.classList?.remove?.('active');
                }
                if (typeof btn.setAttribute === 'function') {
                    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
                }
            });
        }
        const panes = ['rules', 'quality', 'preview', 'runs'];
        panes.forEach(p => {
            const pane = document.getElementById(`data-cleaning-pane-${p}`);
            if (pane && pane.classList) {
                const isTarget = p === tabName;
                if (typeof pane.classList.toggle === 'function') {
                    pane.classList.toggle('hidden', !isTarget);
                    pane.classList.toggle('active', isTarget);
                } else if (isTarget) {
                    pane.classList.remove?.('hidden');
                    pane.classList.add?.('active');
                } else {
                    pane.classList.add?.('hidden');
                    pane.classList.remove?.('active');
                }
            }
        });
    }

    function renderQualityQuickBanner() {
        const banner = document.getElementById('data-cleaning-quick-health-banner');
        if (!banner) return;
        const quality = state.cleaningQuality;
        const dataset = currentDataset();
        if (!dataset || !quality) {
            PivotSafeHtml.setHtml(banner, '');
            if (banner.style) banner.style.display = 'none';
            return;
        }
        const summary = quality.summary || {};
        const totalRows = Number(summary.totalRows) || 0;
        const totalCols = Number(summary.totalColumns) || 0;
        const totalCells = totalRows * totalCols;
        const missingCells = Number(summary.missingCells) || 0;
        const dupRows = Number(summary.duplicateRows) || 0;
        const fillScore = totalCells > 0 ? Math.max(0, 100 - (missingCells / totalCells) * 100) : 100;
        const dupScore = totalRows > 0 ? Math.max(0, 100 - (dupRows / totalRows) * 100) : 100;
        const healthScore = Math.round(fillScore * 0.7 + dupScore * 0.3);
        let healthClass = 'good';
        let healthLabel = '质量优良';
        if (healthScore < 70) {
            healthClass = 'warning';
            healthLabel = '需重点清洗';
        } else if (healthScore < 90) {
            healthClass = 'fair';
            healthLabel = '基本良好';
        }
        const recsCount = quality.recommendations?.length || 0;

        if (banner.style) banner.style.display = 'flex';
        PivotSafeHtml.setHtml(banner, `
            <div class="data-cleaning-quick-health-left">
                <div class="data-cleaning-health-pill health-${healthClass}">
                    <span class="data-cleaning-health-dot"></span>
                    <span>健康评分 <strong>${healthScore}</strong> 分 · ${healthLabel}</span>
                </div>
                <div class="data-cleaning-quick-stats">
                    <span>缺失格数：<strong class="${missingCells > 0 ? 'text-warning' : ''}">${fmtNumber(missingCells)}</strong></span>
                    <span class="data-cleaning-quick-stat-sep">/</span>
                    <span>完全重复行：<strong class="${dupRows > 0 ? 'text-warning' : ''}">${fmtNumber(dupRows)}</strong></span>
                    ${recsCount > 0 ? `<span class="data-cleaning-quick-stat-sep">/</span><span class="data-cleaning-quick-rec-hint">建议规则：<strong class="text-primary">${recsCount} 条</strong></span>` : ''}
                </div>
            </div>
            <button type="button" class="data-cleaning-quick-health-link" data-cleaning-switch-tab="quality">
                <span>查看完整体检报告与字段分布</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
        `);
    }

    function updateTabBadges() {
        const rulesBadge = document.getElementById('data-cleaning-tab-rules-badge');
        if (rulesBadge) {
            const count = state.cleaningRules.length;
            rulesBadge.textContent = `${count} 条`;
            if (rulesBadge.classList?.toggle) rulesBadge.classList.toggle('has-items', count > 0);
        }
        const qualityBadge = document.getElementById('data-cleaning-tab-quality-badge');
        if (qualityBadge) {
            if (state.cleaningQuality) {
                const summary = state.cleaningQuality.summary || {};
                const totalRows = Number(summary.totalRows) || 0;
                const totalCols = Number(summary.totalColumns) || 0;
                const totalCells = totalRows * totalCols;
                const missingCells = Number(summary.missingCells) || 0;
                const dupRows = Number(summary.duplicateRows) || 0;
                const fillScore = totalCells > 0 ? Math.max(0, 100 - (missingCells / totalCells) * 100) : 100;
                const dupScore = totalRows > 0 ? Math.max(0, 100 - (dupRows / totalRows) * 100) : 100;
                const healthScore = Math.round(fillScore * 0.7 + dupScore * 0.3);
                qualityBadge.textContent = `${healthScore} 分`;
                qualityBadge.classList?.add?.('has-items');
            } else {
                qualityBadge.textContent = '待体检';
                qualityBadge.classList?.remove?.('has-items');
            }
        }
        const previewBadge = document.getElementById('data-cleaning-tab-preview-badge');
        if (previewBadge) {
            const rows = state.cleaningPreview?.rows?.length || 0;
            if (state.cleaningPreview) {
                previewBadge.textContent = `${fmtNumber(rows)} 行`;
                previewBadge.classList?.add?.('has-items');
            } else {
                previewBadge.textContent = '待演算';
                previewBadge.classList?.remove?.('has-items');
            }
        }
        const runsBadge = document.getElementById('data-cleaning-tab-runs-badge');
        if (runsBadge) {
            const count = state.cleaningRuns?.length || 0;
            runsBadge.textContent = `${count} 个`;
            if (runsBadge.classList?.toggle) runsBadge.classList.toggle('has-items', count > 0);
        }
    }

    function renderCleaning() {
        renderQualityQuickBanner();
        renderQuality();
        renderRecommendations();
        renderRules();
        renderPreview();
        renderRuns();
        updateTabBadges();
        switchCleaningTab(state.cleaningActiveTab || 'rules');
        const nameInput = document.getElementById('data-cleaning-name');
        if (nameInput && nameInput.value !== state.cleaningRunName) nameInput.value = state.cleaningRunName || '';
    }

    async function loadCleaningWorkspace(datasetId = state.cleaningDatasetId || state.activeId, { resetPreview = false } = {}) {
        const targetId = String(datasetId || '').trim();
        state.cleaningDatasetId = targetId;
        if (!targetId) {
            state.cleaningQuality = null;
            state.cleaningRuns = [];
            if (resetPreview) state.cleaningPreview = null;
            renderCleaning();
            return;
        }
        const loadVersion = Number(state.cleaningLoadVersion || 0) + 1;
        state.cleaningLoadVersion = loadVersion;
        if (resetPreview) state.cleaningPreview = null;
        renderCleaning();
        try {
            const [qualityResult, runResult] = await Promise.all([
                fetchJson(`${API}/datasets/${encodeURIComponent(targetId)}/cleaning/quality`),
                fetchJson(`${API}/datasets/${encodeURIComponent(targetId)}/cleaning/runs?limit=50`)
            ]);
            if (state.cleaningLoadVersion !== loadVersion || state.cleaningDatasetId !== targetId) return;
            state.cleaningQuality = qualityResult;
            state.cleaningRuns = Array.isArray(runResult.runs) ? runResult.runs : [];
            renderCleaning();
        } catch (error) {
            if (state.cleaningLoadVersion !== loadVersion) return;
            state.cleaningQuality = null;
            state.cleaningRuns = [];
            renderCleaning();
            throw error;
        }
    }

    async function previewCleaningRules() {
        const dataset = currentDataset();
        if (!dataset) {
            toast('请选择需要清洗的数据集', 'warning');
            return;
        }
        await guardButton('data-cleaning-preview-run', '正在计算预览…', async () => {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/cleaning/preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rules: state.cleaningRules })
            });
            state.cleaningPreview = data;
            state.cleaningRules = Array.isArray(data.rules) ? data.rules : state.cleaningRules;
            renderCleaning();
            switchCleaningTab('preview');
            toast('已完成清洗影响预览', 'success');
        });
    }

    async function applyCleaningRules() {
        const dataset = currentDataset();
        if (!dataset) {
            toast('请选择需要清洗的数据集', 'warning');
            return;
        }
        if (!state.cleaningRules.length) {
            toast('请至少添加一条清洗规则', 'warning');
            return;
        }
        const confirmed = typeof showConfirm === 'function'
            ? await showConfirm('生成清洗后数据集', '将按当前规则生成一个新的派生数据集。原始数据集不会被修改。')
            : true;
        if (!confirmed) return;
        await guardButton('data-cleaning-apply', '正在生成…', async () => {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/cleaning/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rules: state.cleaningRules, name: state.cleaningRunName })
            });
            toast(`已生成清洗后数据集「${data.dataset?.name || ''}」`, 'success');
            state.activeId = data.dataset?.id || state.activeId;
            await app.loadDatasets?.({ keepActive: true });
            app.activateTab?.('overview');
        });
    }

    function updateRuleInput(target) {
        const card = target.closest('[data-cleaning-rule-index]');
        const index = Number(card?.dataset.cleaningRuleIndex);
        const rule = state.cleaningRules[index];
        if (!rule) return false;
        const field = target.dataset.cleaningRuleInput;
        if (!field) return false;
        if (field === 'includeEmpty') rule.includeEmpty = !!target.checked;
        else if (field === 'factor') rule.factor = Number(target.value) || 1.5;
        else rule[field] = target.value;
        if (field === 'operation') {
            const replacement = createRule(target.value, rule.field);
            replacement.id = rule.id;
            state.cleaningRules[index] = replacement;
            state.cleaningPreview = null;
            renderCleaning();
        } else if (field === 'strategy') {
            state.cleaningPreview = null;
            renderCleaning();
        } else {
            state.cleaningPreview = null;
        }
        return true;
    }

    function updateDedupField(target) {
        const card = target.closest('[data-cleaning-rule-index]');
        const index = Number(card?.dataset.cleaningRuleIndex);
        const rule = state.cleaningRules[index];
        if (!rule || rule.operation !== 'deduplicate') return false;
        const key = target.dataset.cleaningDedupField;
        const fields = new Set(rule.fields || []);
        if (target.checked) fields.add(key); else fields.delete(key);
        rule.fields = [...fields];
        state.cleaningPreview = null;
        return true;
    }

    function resetCleaningWorkspace() {
        state.cleaningQuality = null;
        state.cleaningRules = [];
        state.cleaningPreview = null;
        state.cleaningRuns = [];
        state.cleaningDatasetId = '';
        state.cleaningRunName = '';
        state.cleaningActiveTab = 'rules';
        state.cleaningLoadVersion = Number(state.cleaningLoadVersion || 0) + 1;
    }

    Object.assign(app, {
        createCleaningRule: createRule,
        getCleaningColumns: getColumns,
        switchCleaningTab,
        renderCleaning,
        loadCleaningWorkspace,
        previewCleaningRules,
        applyCleaningRules,
        updateCleaningRuleInput: updateRuleInput,
        updateCleaningDedupField: updateDedupField,
        resetCleaningWorkspace
    });
})();
