
(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc, fmtNumber, activeDataset } = app;
    const fetchJson = (...args) => app.fetchJson(...args);
    const setBusy = (...args) => app.setBusy(...args);
    const toast = (...args) => app.toast(...args);
    const guardButton = (...args) => app.guardButton(...args);

    // 将数据比对结果导出为差异 Excel (含相同项、仅在A表、仅在B表和差异项，空白除外)
    async function exportCompareToExcel() {
        const result = state.compare;
        if (!result) return;
        
        try {
            setBusy(true, '正在生成比对结果Excel...');
            const res = await apiFetch(`${API}/compare/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result)
            });
            if (!res.ok) throw new Error('导出失败');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `数据比对差异结果-${Date.now()}.xlsx`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (e) {
            toast(e && e.message ? e.message : '导出失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function runCompare() {
        const leftId = document.getElementById('data-analysis-compare-left')?.value;
        const rightId = document.getElementById('data-analysis-compare-right')?.value;
        const leftKey = document.getElementById('data-analysis-compare-left-key')?.value;
        const rightKey = document.getElementById('data-analysis-compare-right-key')?.value;
        if (!leftId || !rightId) {
            toast('请选择要比对的数据集', 'warning');
            return;
        }
        if (!leftKey || !rightKey) {
            toast('请选择比对的左侧主键和右侧主键', 'warning');
            return;
        }
        await guardButton('data-analysis-run-compare', '比对中…', async () => {
            const payload = {
                leftDatasetId: leftId,
                rightDatasetId: rightId,
                leftKey: leftKey,
                rightKey: rightKey,
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
            PivotSafeHtml.setHtml(box, '<div class="data-analysis-empty">选择两个数据集和主键后开始比对</div>');
            return;
        }
        const result = state.compare;
        PivotSafeHtml.setHtml(box, `
            <div style="display: flex; justify-content: flex-end; margin: 12px 10px 6px;">
                <button id="data-analysis-compare-export-btn" class="btn-secondary" type="button" style="height: 30px; padding: 0 12px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; border: 1px solid rgba(148, 163, 184, 0.3); cursor: pointer;">导出结果</button>
            </div>
            ${renderDuplicateKeys(result)}
            <div class="data-analysis-compare-lists">
                ${renderCompareList(`相同项 (${fmtNumber(result.matched)})`, result.matchedKeys || [], 'matched')}
                ${renderCompareList(`仅左侧存在 (${fmtNumber(result.onlyLeft?.length || 0)})`, result.onlyLeft, 'onlyLeft')}
                ${renderCompareList(`仅右侧存在 (${fmtNumber(result.onlyRight?.length || 0)})`, result.onlyRight, 'onlyRight')}
                ${renderChangedList(`字段差异 (${fmtNumber(result.changed?.length || 0)})`, result.changed)}
            </div>
        `);
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

    function renderCompareList(title, rows = [], type = '') {
        return `
            <section data-compare-type="${esc(type)}">
                <strong>${esc(title)}</strong>
                <div>${rows.slice(0, 30).map(row => `<span>${esc(row.key)}</span>`).join('') || '<em>无</em>'}</div>
            </section>
        `;
    }

    function renderChangedList(title, rows = []) {
        return `
            <section data-compare-type="changed">
                <strong>${esc(title)}</strong>
                <div>${rows.slice(0, 30).map(row => `
                    <span>${esc(row.key)}：${esc(row.leftValue)} → ${esc(row.rightValue)}</span>
                `).join('') || '<em>无</em>'}</div>
            </section>
        `;
    }

    function showCompareDetailModal(type) {
        const modal = document.getElementById('data-analysis-compare-modal');
        const titleEl = document.getElementById('data-analysis-compare-modal-title');
        const contentEl = document.getElementById('data-analysis-compare-modal-content');
        if (!modal || !titleEl || !contentEl || !state.compare) return;

        const result = state.compare;
        let title = '';
        let htmlContent = '';

        if (type === 'matched') {
            title = `相同项明细 (${result.matched})`;
            const list = result.matchedKeys || [];
            htmlContent = list.map(item => `<div class="compare-modal-item">${esc(item.key)}</div>`).join('') || '<div class="compare-modal-empty">无数据</div>';
        } else if (type === 'onlyLeft') {
            title = `仅左侧存在明细 (${result.onlyLeft?.length || 0})`;
            const list = result.onlyLeft || [];
            htmlContent = list.map(item => `<div class="compare-modal-item">${esc(item.key)}</div>`).join('') || '<div class="compare-modal-empty">无数据</div>';
        } else if (type === 'onlyRight') {
            title = `仅右侧存在明细 (${result.onlyRight?.length || 0})`;
            const list = result.onlyRight || [];
            htmlContent = list.map(item => `<div class="compare-modal-item">${esc(item.key)}</div>`).join('') || '<div class="compare-modal-empty">无数据</div>';
        } else if (type === 'changed') {
            title = `字段差异明细 (${result.changed?.length || 0})`;
            const list = result.changed || [];
            const compareField = result.compareField || '对比字段';
            htmlContent = `
                <table class="data-table compact-table data-analysis-result-table" style="width: 100%; table-layout: fixed; margin: 0;">
                    <thead>
                        <tr><th style="width: 40%; text-align: left;">主键</th><th style="width: 30%; text-align: left;">左侧值 (${esc(compareField)})</th><th style="width: 30%; text-align: left;">右侧值 (${esc(compareField)})</th></tr>
                    </thead>
                    <tbody>
                        ${list.map(item => `
                            <tr>
                                <td style="word-break: break-all; text-align: left;"><strong>${esc(item.key)}</strong></td>
                                <td style="color: #dc2626; font-weight: 700; word-break: break-all; text-align: left;">${esc(item.leftValue)}</td>
                                <td style="color: #16a34a; font-weight: 700; word-break: break-all; text-align: left;">${esc(item.rightValue)}</td>
                            </tr>
                        `).join('') || '<tr><td colspan="3" style="text-align: center;">无差异</td></tr>'}
                    </tbody>
                </table>
            `;
        }

        titleEl.textContent = title;
        PivotSafeHtml.setHtml(contentEl, htmlContent);
        modal.classList.remove('hidden');
    }

    async function loadArtifacts() {
        const dataset = activeDataset();
        const box = document.getElementById('data-analysis-history-result');
        const pager = document.getElementById('data-analysis-history-pagination');
        state.historyPage = 1;
        if (!dataset) {
            state.artifacts = [];
            renderHistory();
            return;
        }
        if (box) PivotSafeHtml.setHtml(box, '<div class="data-analysis-empty">加载中…</div>');
        if (pager) {
            if (typeof pager.replaceChildren === 'function') pager.replaceChildren();
            else PivotSafeHtml.setHtml(pager, '');
        }
        try {
            const data = await fetchJson(`${API}/datasets/${encodeURIComponent(dataset.id)}/artifacts?limit=100`);
            state.artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
            state.historyPage = 1;
            renderHistory();
        } catch (e) {
            state.artifacts = [];
            state.historyPage = 1;
            if (box) PivotSafeHtml.setHtml(box, `<div class="data-analysis-empty">历史加载失败：${esc(e && e.message ? e.message : '请稍后重试')}</div>`);
            if (pager) {
                if (typeof pager.replaceChildren === 'function') pager.replaceChildren();
                else PivotSafeHtml.setHtml(pager, '');
            }
        }
    }

    function renderHistory() {
        const box = document.getElementById('data-analysis-history-result');
        if (!box) return;
        const pager = document.getElementById('data-analysis-history-pagination');
        const items = state.artifacts || [];
        if (!items.length) {
            PivotSafeHtml.setHtml(box, '<div class="data-analysis-empty">暂无历史记录，生成图表 / 数据透视 / 比对 / 导出后会显示在这里</div>');
            if (pager) {
                if (typeof pager.replaceChildren === 'function') pager.replaceChildren();
                else PivotSafeHtml.setHtml(pager, '');
            }
            return;
        }

        const total = items.length;
        const pageSize = Math.max(Number(state.historyPageSize) || 10, 1);
        const pageCount = Math.max(Math.ceil(total / pageSize), 1);
        state.historyPage = Math.min(Math.max(Number(state.historyPage) || 1, 1), pageCount);

        const startIndex = (state.historyPage - 1) * pageSize;
        const pageRows = items.slice(startIndex, startIndex + pageSize);

        const typeLabel = { chart: '图表', pivot: '透视', comparison: '比对', export: '导出', query: '查询', ai_analysis: 'AI 分析', ai_full_text_analysis: '全量语义', cleaning: '数据清洗' };
        const rows = pageRows.map((item, offset) => {
            const itemIndex = startIndex + offset;
            const clickable = (item.type === 'chart' && item.chart) || (item.type === 'ai_analysis' && item.analysis) || (item.type === 'ai_full_text_analysis' && item.semantic);
            const viewBtn = clickable
                ? `<button class="data-analysis-table-btn" data-data-analysis-history="${itemIndex}" type="button">查看</button>`
                : `<span class="data-analysis-muted-cell">—</span>`;
            const titleVal = esc(item.title);
            const dateVal = esc(item.createdAt || '—');
            return `
                <tr>
                    <td class="col-history-index text-center data-analysis-row-index">${itemIndex + 1}</td>
                    <td class="col-history-type"><span class="data-analysis-history-type data-analysis-history-type-${esc(item.type)}">${esc(typeLabel[item.type] || item.type)}</span></td>
                    <td class="col-history-title" data-cell-full="${titleVal}">${titleVal}</td>
                    <td class="col-history-date data-analysis-muted-cell" data-cell-full="${dateVal}">${dateVal}</td>
                    <td class="col-history-action text-center">
                        <span class="data-analysis-table-actions">${viewBtn}</span>
                    </td>
                </tr>
            `;
        }).join('');
        PivotSafeHtml.setHtml(box, `
            <table class="data-table compact-table data-analysis-history-table">
                <colgroup>
                    <col class="col-history-index">
                    <col class="col-history-type">
                    <col class="col-history-title">
                    <col class="col-history-date">
                    <col class="col-history-action">
                </colgroup>
                <thead>
                    <tr>
                        <th class="col-history-index text-center">序号</th>
                        <th class="col-history-type">类型</th>
                        <th class="col-history-title">标题</th>
                        <th class="col-history-date">记录时间</th>
                        <th class="col-history-action text-center">操作</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `);

        if (!pager) return;
        if (window.Pivot.legacy.renderWorkspacePagination) {
            window.Pivot.legacy.renderWorkspacePagination(pager, {
                total,
                page: state.historyPage,
                limit: pageSize,
                onPageChange: targetPage => {
                    state.historyPage = targetPage;
                    renderHistory();
                }
            });
            return;
        }
        if (typeof pager.replaceChildren === 'function') pager.replaceChildren();
        else PivotSafeHtml.setHtml(pager, '');
    }


    Object.assign(app, {
        exportCompareToExcel,
        runCompare,
        renderCompare,
        renderDuplicateKeys,
        renderCompareList,
        renderChangedList,
        showCompareDetailModal,
        loadArtifacts,
        renderHistory
    });
})();
