(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis;
    const m = app.modeling;
    const { state, request, json } = m;
    const { esc } = app;

    function renderPreviewDock() {
        if (!state.previewOpen) return '';
        const targetId = state.previewNodeId || state.selectedNodeId || state.draft?.nodes?.[0]?.id || '';
        const preview = state.previewData;
        const canEdit = state.selected?.isOwner && state.selected?.lifecycle !== 'archived';
        const isFlowTarget = Boolean(m.getFlowNode?.(targetId));
        const nodeLabel = m.getAnyNodeName ? m.getAnyNodeName(targetId) : targetId;

        const stepChain = preview?.steps?.length > 1
            ? `<div class="modeling-preview-steps" aria-label="节点流转链路">
                <span class="modeling-preview-steps-label">流转链路：</span>
                ${preview.steps.map((step, idx) => {
                    const active = step.id === preview.nodeId;
                    return `${idx > 0 ? '<span class="modeling-guide-sep">→</span>' : ''}<button class="btn-secondary modeling-step-chip${active ? ' is-active' : ''}" type="button" data-modeling-action="preview-node" data-modeling-id="${esc(step.id)}" title="点击查看此步骤输出数据">${esc(step.name)}</button>`;
                }).join('')}
            </div>`
            : '';

        const statsBadges = preview && !state.previewLoading && !state.previewError
            ? `<div class="modeling-preview-stats">
                ${preview.upstreamRows !== null && preview.upstreamRows !== undefined
                    ? `<span class="modeling-badge is-info">上游 ${esc(preview.upstreamRows)} 行 → 输出 ${esc(preview.totalRows)} 行</span>`
                    : `<span class="modeling-badge is-success">共 ${esc(preview.totalRows)} 行</span>`}
                <span class="modeling-badge is-muted">${esc(preview.columns?.length || 0)} 列</span>
                <span class="modeling-badge is-muted">${esc(preview.durationMs)} ms</span>
            </div>`
            : '';

        let bodyMarkup = '';
        if (state.previewLoading) {
            bodyMarkup = '<div class="modeling-notice is-info">正在沙箱内实时执行节点算子与数据采样，请稍候…</div>';
        } else if (state.previewError) {
            bodyMarkup = `<div class="modeling-notice is-danger">${esc(state.previewError)}</div>`;
        } else if (!preview) {
            bodyMarkup = '<div class="modeling-empty-inline"><p>点击画布任意节点或右上角“刷新预览”即可查看该节点的实时输入输出数据。</p></div>';
        } else {
            const cols = preview.columns || [];
            const headerCells = cols.map(col => {
                return `<th><div class="modeling-preview-th"><strong>${esc(col.name)}</strong><small>${esc(col.type)}</small></div></th>`;
            }).join('');
            const dataRows = (preview.rows || []).map(row => {
                return `<tr>${cols.map(col => {
                    const cellVal = row[col.name];
                    const text = cellVal === null || cellVal === undefined ? '空值' : (typeof cellVal === 'object' ? JSON.stringify(cellVal) : String(cellVal));
                    return `<td class="${cellVal === null || cellVal === undefined ? 'text-muted' : ''}" title="${esc(text)}">${esc(text.slice(0, 160))}</td>`;
                }).join('')}</tr>`;
            });
            bodyMarkup = `<div class="table-container modeling-preview-table-wrap">
                <table class="data-table compact-table">
                    <thead><tr>${headerCells || '<th>无输出列</th>'}</tr></thead>
                    <tbody>${dataRows.length ? dataRows.join('') : `<tr><td colspan="${Math.max(1, cols.length)}">当前节点输出 0 行数据</td></tr>`}</tbody>
                </table>
            </div>`;
        }

        return `<div id="modeling-preview-dock" class="modeling-preview-dock" role="region" aria-label="节点实时数据预览">
            <div class="modeling-preview-header">
                <div class="modeling-preview-title-wrap">
                    <strong>数据运行预览 · ${esc(preview?.nodeName || nodeLabel || '未选节点')}</strong>
                    ${statsBadges}
                </div>
                ${stepChain}
                <div class="modeling-bar-actions">
                    ${targetId ? `<button class="btn-secondary" type="button" data-modeling-action="preview-node" data-modeling-id="${esc(targetId)}">刷新预览</button>` : ''}
                    ${targetId && canEdit && isFlowTarget ? `<button class="btn-secondary" type="button" data-modeling-action="materialize-node" data-modeling-id="${esc(targetId)}">保存输出为数据集</button>` : ''}
                    <button class="btn-secondary" type="button" data-modeling-action="close-preview">关闭预览</button>
                </div>
            </div>
            <div class="modeling-preview-body">${bodyMarkup}</div>
        </div>`;
    }

    async function runNodePreview(targetNodeId) {
        const nodeId = targetNodeId || state.selectedNodeId || state.draft?.nodes?.[0]?.id || '';
        if (!nodeId || !state.selected?.id) {
            throw new Error('请先在画布中选择一个表或算子节点。');
        }
        state.previewOpen = true;
        state.previewLoading = true;
        state.previewNodeId = nodeId;
        state.previewError = '';
        m.render();

        const current = m.capture('node-preview');
        try {
            const data = await request(`/models/${encodeURIComponent(state.selected.id)}/node-preview`, json({
                targetNodeId: nodeId,
                definitionNodes: state.draft?.nodes || [],
                flowGraph: state.flowGraph || { nodes: [], edges: [] },
                limit: 50
            }));
            if (!current()) return;
            state.previewData = data.preview;
            state.previewLoading = false;
            if (Array.isArray(data.preview?.columns)) {
                state.schemaCache[nodeId] = data.preview.columns.map(col => col.name);
            }
            m.render();
        } catch (error) {
            if (!current()) return;
            state.previewLoading = false;
            state.previewError = error.message || '节点数据预览执行失败，请检查节点配置与上游连线。';
            m.render();
        }
    }

    function materializeNodeDataset(targetNodeId) {
        const nodeId = targetNodeId || state.selectedNodeId;
        if (!nodeId || !state.selected?.id) throw new Error('请先选择需要输出的算子节点。');
        const label = m.getAnyNodeName ? m.getAnyNodeName(nodeId) : nodeId;
        const defaultName = `${label}_输出表`.slice(0, 60);
        m.dialog(
            '保存节点输出为数据集',
            `${m.input('datasetName', '新数据集名称', defaultName, 'maxlength="80" required placeholder="例如：订单清洗合并结果"')}
            <p class="modeling-dialog-note">系统将按当前节点完整上游算子链路执行计算，并将输出结果保存为受权限管控的标准数据集，可直接加入模型作为主表/维度表，或在「数据分析」中生成图表与透视表。</p>`,
            async form => {
                const current = m.capture('materialize-dataset');
                const datasetName = m.value(form, 'datasetName').trim();
                const res = await request(`/models/${encodeURIComponent(state.selected.id)}/node-datasets`, json({
                    targetNodeId: nodeId,
                    datasetName,
                    definitionNodes: state.draft?.nodes || [],
                    flowGraph: state.flowGraph || { nodes: [], edges: [] }
                }));
                if (!current()) return;
                if (res.dataset) {
                    const existingIdx = (app.state.datasets || []).findIndex(item => item.id === res.dataset.id);
                    if (existingIdx >= 0) app.state.datasets[existingIdx] = res.dataset;
                    else app.state.datasets = [res.dataset, ...(app.state.datasets || [])];
                }
                await app.loadDatasets?.().catch(() => {});
                m.render();
                app.toast(`已生成数据集「${res.dataset?.name || datasetName}」（共 ${res.dataset?.rowCount ?? 0} 行）。`, 'success');
            }
        );
    }

    Object.assign(m, { renderPreviewDock, runNodePreview, materializeNodeDataset });
})();

