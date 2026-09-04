(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber, activeDataset } = app;
    const buildOptions = (...args) => app.buildOptions(...args);
    const setSelectOptions = (...args) => app.setSelectOptions(...args);
    const fetchJson = (...args) => app.fetchJson(...args);
    const guardButton = (...args) => app.guardButton(...args);
    const toast = (...args) => app.toast(...args);

    const AGGREGATION_LABELS = {
        sum: '求和',
        count: '计数',
        avg: '平均',
        min: '最小',
        max: '最大'
    };

    const SORT_LABELS = {
        total_desc: '按指标降序',
        total_asc: '按指标升序',
        label_asc: '按名称升序',
        label_desc: '按名称降序'
    };

    function getProfile(dataset = activeDataset()) {
        return Array.isArray(dataset?.profile) ? dataset.profile : [];
    }

    function getColumns(dataset = activeDataset()) {
        return Array.isArray(dataset?.columns) ? dataset.columns : [];
    }

    function numericFieldKeys(dataset = activeDataset()) {
        return getProfile(dataset).filter(item => item.type === 'number' && item.numeric).map(item => item.key);
    }

    function dimensionCandidates(dataset = activeDataset()) {
        const rowCount = Number(dataset?.rowCount) || 0;
        return getProfile(dataset)
            .filter(item => item.type !== 'empty' && item.distinct > 1)
            .map(item => {
                const distinct = Number(item.distinct) || 0;
                const fillRate = Number(item.fillRate) || 0;
                const cardinalityPenalty = rowCount ? Math.min(distinct / rowCount, 1) : 0;
                const typeScore = item.type === 'date' ? 18 : item.type === 'boolean' ? 16 : item.type === 'text' ? 14 : 8;
                const rangeScore = distinct <= 30 ? 28 : distinct <= 80 ? 18 : distinct <= 200 ? 8 : -12;
                return {
                    key: item.key,
                    score: typeScore + rangeScore + fillRate * 20 - cardinalityPenalty * 18
                };
            })
            .sort((a, b) => b.score - a.score)
            .map(item => item.key);
    }

    function selectHasOption(select, value) {
        return Array.from(select?.options || []).some(option => option.value === value);
    }

    function setSelectValueIfEmpty(id, value) {
        const el = document.getElementById(id);
        if (!el || el.value || !value || !selectHasOption(el, value)) return false;
        el.value = value;
        return true;
    }

    function setPivotControlHint(message = '') {
        const hint = document.getElementById('data-analysis-pivot-hint');
        if (hint) hint.textContent = message;
    }

    function syncPivotAggregationControls(source = 'auto', notify = false) {
        const valueEl = document.getElementById('data-analysis-pivot-value');
        const aggregationEl = document.getElementById('data-analysis-pivot-aggregation');
        if (!valueEl || !aggregationEl) return;
        const aggregation = aggregationEl.value || 'sum';
        if (aggregation === 'count') {
            setPivotControlHint('计数模式会统计每个组合的数据行数。');
            return;
        }
        if (valueEl.value) {
            setPivotControlHint('当前聚合会按所选值字段计算。');
            return;
        }
        const fallback = numericFieldKeys().find(key => selectHasOption(valueEl, key));
        if (fallback) {
            valueEl.value = fallback;
            setPivotControlHint('已自动选择一个数值字段。');
            return;
        }
        aggregationEl.value = 'count';
        setPivotControlHint('未识别到稳定数值字段，已切换为计数。');
        if (notify || source === 'aggregation') toast('未选择数值字段，已自动切换为计数。', 'warning');
    }

    function applyPivotRecommendations({ force = false } = {}) {
        const dataset = activeDataset();
        if (!dataset) return;
        const candidates = dimensionCandidates(dataset);
        const numericKeys = numericFieldKeys(dataset);
        const rowEl = document.getElementById('data-analysis-pivot-row');
        const colEl = document.getElementById('data-analysis-pivot-col');
        const valueEl = document.getElementById('data-analysis-pivot-value');
        const aggregationEl = document.getElementById('data-analysis-pivot-aggregation');
        if (!rowEl || !colEl || !valueEl || !aggregationEl) return;

        if (force) {
            rowEl.value = '';
            colEl.value = '';
            valueEl.value = '';
        }
        const rowFallback = candidates.find(key => selectHasOption(rowEl, key));
        const colFallback = candidates.find(key => key !== rowFallback && selectHasOption(colEl, key));
        const valueFallback = numericKeys.find(key => selectHasOption(valueEl, key));
        setSelectValueIfEmpty('data-analysis-pivot-row', rowFallback);
        setSelectValueIfEmpty('data-analysis-pivot-col', colFallback);
        setSelectValueIfEmpty('data-analysis-pivot-value', valueFallback);
        if (!valueEl.value) aggregationEl.value = 'count';
        syncPivotAggregationControls('auto');
        if (force) toast('已按字段画像推荐透视配置。');
    }

    function renderPivotControls() {
        const dataset = activeDataset();
        const columns = getColumns(dataset);
        setSelectOptions('data-analysis-pivot-row', buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择行维度' }));
        setSelectOptions('data-analysis-pivot-col', buildOptions(columns, { includeEmpty: true, emptyLabel: '不拆分列，仅按行汇总' }));
        setSelectOptions('data-analysis-pivot-value', buildOptions(columns, { includeEmpty: true, emptyLabel: '请选择值字段' }));
        applyPivotRecommendations();
    }

    function getPivotInputValue(id, fallback = '') {
        const el = document.getElementById(id);
        if (!el) return fallback;
        return el.value || fallback;
    }

    function getPivotNumberInput(id, fallback) {
        const value = Number.parseInt(document.getElementById(id)?.value, 10);
        return Number.isFinite(value) ? value : fallback;
    }

    async function runPivot() {
        const dataset = activeDataset();
        if (!dataset) {
            toast('请选择分析数据集', 'warning');
            return;
        }
        const rowField = getPivotInputValue('data-analysis-pivot-row');
        if (!rowField) {
            toast('请选择行维度', 'warning');
            return;
        }
        const colField = getPivotInputValue('data-analysis-pivot-col');
        const valueField = getPivotInputValue('data-analysis-pivot-value');
        const aggregation = getPivotInputValue('data-analysis-pivot-aggregation', 'sum');
        if (colField && colField === rowField) {
            toast('列维度请不要与行维度相同', 'warning');
            return;
        }
        if (aggregation !== 'count' && !valueField) {
            toast('该聚合方式下请选择值字段，或改用计数。', 'warning');
            syncPivotAggregationControls('run', true);
            return;
        }
        const payload = {
            rowField,
            colField,
            valueField,
            aggregation,
            rowLimit: getPivotNumberInput('data-analysis-pivot-row-limit', 50),
            colLimit: getPivotNumberInput('data-analysis-pivot-col-limit', 20),
            sortBy: getPivotInputValue('data-analysis-pivot-sort', 'total_desc'),
            emptyLabel: getPivotInputValue('data-analysis-pivot-empty-label', '(空值)'),
            percentMode: getPivotInputValue('data-analysis-pivot-percent-mode', 'none')
        };
        await guardButton('data-analysis-run-pivot', '生成中…', async () => {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/pivot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            state.pivot = data;
            renderPivot();
        });
    }

    function formatPercent(value) {
        if (value === null || value === undefined) return '-';
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        if (!num) return '0%';
        return `${(num * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
    }

    function formatMetric(value, aggregation = 'sum') {
        if (aggregation === 'count') return fmtNumber(value);
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        return num.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
    }

    function isAdditiveAggregation(result) {
        return result?.aggregation === 'sum' || result?.aggregation === 'count';
    }

    function pivotPercent(cellValue, row, col, result, mode) {
        if (!isAdditiveAggregation(result)) return null;
        if (mode === 'row') return row.total ? Number(cellValue) / Number(row.total) : 0;
        if (mode === 'column') return result.colTotals?.[col] ? Number(cellValue) / Number(result.colTotals[col]) : 0;
        if (mode === 'total') return result.grandTotal ? Number(cellValue) / Number(result.grandTotal) : 0;
        return null;
    }

    function cellHeatStyle(cellValue, result) {
        if (!isAdditiveAggregation(result)) return '';
        const base = Math.abs(Number(result.grandTotal) || 0);
        if (!base) return '';
        const alpha = Math.min(0.18, Math.max(0, Math.abs(Number(cellValue) || 0) / base * 1.8));
        return alpha ? ` style="background: rgba(20, 184, 166, ${alpha.toFixed(3)});"` : '';
    }

    function buildPivotCell(cellValue, row, col, result, percentMode) {
        const num = Number(cellValue) || 0;
        const isZero = num === 0;
        const pct = pivotPercent(cellValue, row, col, result, percentMode);
        const pctHtml = pct === null ? '' : `<span class="data-analysis-pivot-percent">${formatPercent(pct)}</span>`;
        const zeroClass = isZero ? ' class="data-analysis-pivot-cell-zero"' : '';
        const displayVal = isZero ? '<span class="data-analysis-pivot-zero">-</span>' : formatMetric(cellValue, result.aggregation);
        return `<td${cellHeatStyle(cellValue, result)}${zeroClass}><span class="data-analysis-pivot-cell-value">${displayVal}</span>${pctHtml}</td>`;
    }

    function buildTopList(items = [], aggregation = 'sum', emptyText = '暂无数据') {
        if (!items.length) return `<span class="data-analysis-muted-cell">${esc(emptyText)}</span>`;
        return items.slice(0, 5).map(item => `
            <span class="data-analysis-pivot-rank-item">
                <b>${esc(item.rank)}</b>
                <span title="${esc(item.label)}">${esc(item.label)}</span>
                <em>${formatMetric(item.value, aggregation)}</em>
                <small>${formatPercent(item.share)}</small>
            </span>
        `).join('');
    }

    function renderPivot() {
        const box = document.getElementById('data-analysis-pivot-result');
        if (!box) return;
        const result = state.pivot;
        if (!result) {
            document.getElementById('data-analysis-pivot-export-btn')?.classList.add('hidden');
            PivotSafeHtml.setHtml(box, `
                <div class="data-analysis-empty data-analysis-pivot-empty">
                    选择行维度和值字段后生成透视表。系统会优先推荐适合分组的字段，并可按 Top N 控制结果规模。
                </div>
            `);
            return;
        }
        document.getElementById('data-analysis-pivot-export-btn')?.classList.remove('hidden');

        const cols = result.columns || [];
        const rows = result.rows || [];
        const percentMode = result.display?.percentMode || getPivotInputValue('data-analysis-pivot-percent-mode', 'none');
        const totalLabel = result.totalLabel || (isAdditiveAggregation(result) ? '合计' : (result.aggregationLabel || '结果'));
        const valueName = result.aggregation === 'count' ? '记录数' : (result.valueField?.name || '数值');
        const showShare = isAdditiveAggregation(result);
        const head = `<tr><th class="pivot-th-corner">${esc(result.rowField?.name || '行')}${result.colField ? ` / ${esc(result.colField.name)}` : ''}</th>${cols.map(col => `<th>${esc(col)}</th>`).join('')}<th>${esc(totalLabel)}</th>${showShare ? '<th>占比</th>' : ''}</tr>`;
        const body = rows.map(row => `
            <tr>
                <th class="pivot-row-th" title="${esc(row.label)}"><span class="pivot-row-text" title="${esc(row.label)}">${esc(row.label)}</span></th>
                ${cols.map(col => buildPivotCell(row.values?.[col] || 0, row, col, result, percentMode)).join('')}
                <td class="data-analysis-pivot-total">${formatMetric(row.total || 0, result.aggregation)}</td>
                ${showShare ? `<td class="data-analysis-pivot-share">${formatPercent(row.share)}</td>` : ''}
            </tr>
        `).join('');
        const footer = `
            <tr class="data-analysis-pivot-total-row">
                <th class="pivot-row-th"><span class="pivot-row-text">${esc(totalLabel)}</span></th>
                ${cols.map(col => `<td>${formatMetric(result.colTotals?.[col] || 0, result.aggregation)}</td>`).join('')}
                <td class="data-analysis-pivot-total">${formatMetric(result.grandTotal || 0, result.aggregation)}</td>
                ${showShare ? '<td>100%</td>' : ''}
            </tr>
        `;
        const truncateText = result.truncated
            ? `展示 ${fmtNumber(result.displayedRowCount || rows.length)}/${fmtNumber(result.totalRowCount || rows.length)} 行、${fmtNumber(result.displayedColumnCount || cols.length)}/${fmtNumber(result.totalColumnCount || cols.length)} 列（${esc(totalLabel)}按全量计算）`
            : `共 ${fmtNumber(rows.length)} 个行项${result.colField ? `、${fmtNumber(cols.length)} 个列项` : ''}`;
        PivotSafeHtml.setHtml(box, `
            <div class="data-analysis-pivot-result-head">
                <div class="data-analysis-pivot-summary">
                    <div class="data-analysis-pivot-stat"><span>口径</span><strong>${esc(result.aggregationLabel || AGGREGATION_LABELS[result.aggregation] || result.aggregation)} / ${esc(valueName)}</strong></div>
                    <div class="data-analysis-pivot-stat"><span>行</span><strong>${esc(result.rowField?.name || '-')}</strong></div>
                    <div class="data-analysis-pivot-stat"><span>列</span><strong>${esc(result.colField?.name || '未拆分')}</strong></div>
                    <div class="data-analysis-pivot-stat data-analysis-pivot-stat-total"><span>${esc(totalLabel)}</span><strong>${formatMetric(result.grandTotal || 0, result.aggregation)}</strong></div>
                </div>
                <div class="data-analysis-query-meta data-analysis-pivot-meta">${truncateText}</div>
            </div>
            <details class="data-analysis-pivot-insights-details">
                <summary class="data-analysis-pivot-insights-summary">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    <span>极值排行速览 (Top 5 行项与列项)</span>
                </summary>
                <div class="data-analysis-pivot-insights">
                    <div><span>Top 行项</span><div class="data-analysis-pivot-rank-list">${buildTopList(result.topRows || [], result.aggregation)}</div></div>
                    <div><span>Top 列项</span><div class="data-analysis-pivot-rank-list">${buildTopList(result.topColumns || [], result.aggregation, result.colField ? '暂无列项' : '未设置列维度')}</div></div>
                </div>
            </details>
            <div class="data-analysis-pivot-table">
                <table class="data-table compact-table data-analysis-result-table">
                    <thead>${head}</thead>
                    <tbody>${body || ''}${footer}</tbody>
                </table>
            </div>
            <div class="data-analysis-pivot-actions">
                <span>${esc(SORT_LABELS[result.display?.sortBy] || '按指标降序')}；空值显示为「${esc(result.display?.emptyLabel || '(空值)')}」。</span>
            </div>
        `);
    }

    Object.assign(app, {
        renderPivotControls,
        syncPivotAggregationControls,
        applyPivotRecommendations,
        runPivot,
        renderPivot
    });
})();
