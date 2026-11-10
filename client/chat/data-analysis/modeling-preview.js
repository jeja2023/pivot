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
        const job = state.nodeJob;
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
            bodyMarkup = `<div class="modeling-notice is-info">节点任务${esc(statusLabel(job))}，正在固定来源并通过隔离执行器计算，请稍候…</div>`;
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
                    ${pending(job) ? '<button class="btn-secondary" type="button" data-modeling-action="cancel-node-job">取消节点任务</button>' : ''}
                    ${job && state.previewError ? '<button class="btn-secondary" type="button" data-modeling-action="retry-node-job">重新读取任务</button>' : ''}
                    ${targetId ? `<button class="btn-secondary" type="button" data-modeling-action="preview-node" data-modeling-id="${esc(targetId)}">刷新预览</button>` : ''}
                    ${targetId && canEdit && isFlowTarget ? `<button class="btn-secondary" type="button" data-modeling-action="materialize-node" data-modeling-id="${esc(targetId)}">保存输出为数据集</button>` : ''}
                    <button class="btn-secondary" type="button" data-modeling-action="close-preview">关闭预览</button>
                </div>
            </div>
            <div class="modeling-preview-body">
                ${state.previewStale || pending(job) && state.nodeTaskRevision !== state.dataRevision ? '<div class="modeling-notice is-warning" role="status">配置已变化或正在查看历史任务；已有结果不代表当前配置，请重新运行预览。</div>' : ''}
                ${job?.result?.dataset ? `<div class="modeling-notice is-success">已生成数据集「${esc(job.result.dataset.name)}」；来源及完整性声明已保留。<button class="btn-secondary" type="button" data-modeling-action="create-from-output" data-modeling-id="${esc(job.result.dataset.id)}">基于输出新建正式模型</button></div>` : ''}
                ${job?.result?.dataset && job.result.dataset.currentSourceVersion !== job.result.dataset.sourceVersion ? '<div class="modeling-notice is-warning">这里保留本次任务的固定输出预览；该数据集已有后续修订，新建模型将读取数据集当前版本，请重新检查口径。</div>' : ''}
                ${bodyMarkup}
                <details class="modeling-advanced-panel" data-modeling-node-history${state.nodeHistoryOpen ? ' open' : ''}><summary>节点任务与来源说明</summary>
                    ${state.nodeJobs.length ? `<label>最近节点任务<select id="modeling-node-job" class="form-input" aria-label="查看最近节点任务"><option value="">请选择任务</option>${state.nodeJobs.map(item => `<option value="${esc(item.id)}"${item.id === job?.id ? ' selected' : ''}>${item.executionKind === 'model_node_dataset' ? '保存输出' : '节点预览'} · ${esc(statusLabel(item))} · ${esc(item.node?.targetNodeId || '')} · ${esc(item.createdAt)}</option>`).join('')}</select></label>` : ''}
                    ${job?.result ? `<p class="text-muted">来源范围：${esc(({ full: '完整', partial: '部分', unknown: '未知' })[job.result.coverage] || '未知')}；来源截止：${esc((job.result.dataTimes || []).map(item => item.updatedAt).join('；') || '未记录')}</p>` : ''}
                    ${(job?.result?.sources || []).map(source => `<p class="text-muted">${esc(job.result.sourceNames?.find(item => item.nodeId === source.nodeId)?.name || source.datasetId)} · 固定数据版本 ${esc(source.dataVersion)} · 来源修订 ${esc(source.sourceRevision)} · ${esc(({ full: '完整', partial: '部分', incremental: '增量', unknown: '未知' })[source.coverage] || '未知')} · 截止 ${esc(source.watermark.updatedAt || '未记录')}</p>`).join('')}
                    <p class="text-muted">这里展示数据准备流；正式分析使用已发布模型绑定的数据集。数值统计按八位小数转换，金额汇总使用十进制计算。</p>
                </details>
            </div>
        </div>`;
    }

    const pending = job => job && ['queued', 'running', 'retry_wait', 'cancelling'].includes(job.status);
    const visible = () => !document.hidden && !document.getElementById('data-analysis-view')?.classList.contains('hidden') && !document.getElementById('data-analysis-modeling-panel')?.classList.contains('hidden');
    const statusLabel = job => ({ queued: '排队中', running: '执行中', retry_wait: '等待重试', cancelling: '取消中', cancelled: '已取消', succeeded: '已完成', failed: '失败' })[job?.status] || '未开始';

    function renderPreviewState() {
        const dock = document.getElementById('modeling-preview-dock');
        if (!dock) return;
        const wrapper = document.createElement('div');
        m.html(wrapper, renderPreviewDock());
        dock.replaceWith(wrapper.firstElementChild);
    }

    function rememberJob(job) {
        state.nodeJob = job;
        state.nodeJobs = [job, ...state.nodeJobs.filter(item => item.id !== job.id)].slice(0, 20);
        if (!pending(job)) for (const [signature, key] of state.nodeRequests) if (key === job.node?.requestKey) state.nodeRequests.delete(signature);
    }

    async function pollNodeJob({ historical = false } = {}) {
        const id = state.nodeJob?.id;
        if (!id) return null;
        const current = m.capture('node-poll');
        while (current() && state.nodeJob?.id === id && visible()) {
            const data = await request(`/async-queries/${encodeURIComponent(id)}`);
            if (!current() || state.nodeJob?.id !== id || !visible()) return null;
            const job = data.job;
            rememberJob(job);
            state.previewLoading = pending(job);
            if (!pending(job)) {
                if (job.resultExpired) {
                    state.previewError = '节点预览已超过保留期限，请按当前来源和配置重新运行。';
                } else if (job.status !== 'succeeded') {
                    state.previewError = job.status === 'cancelled' ? '节点任务已取消，未生成新的输出。' : job.lastError || '节点任务未完成，请检查配置后重试。';
                } else if (job.result?.preview && (historical || state.nodeTaskRevision === state.dataRevision)) {
                    state.previewData = job.result.preview;
                    state.previewNodeId = job.node.targetNodeId;
                    state.previewStale = historical;
                    state.previewError = '';
                    if (!historical) state.schemaCache[job.node.targetNodeId] = job.result.preview.columns.map(column => column.name);
                } else if (job.result?.preview) {
                    state.previewStale = true;
                }
                if (job.result?.dataset) {
                    const dataset = job.result.dataset;
                    state.previewStale = historical || state.nodeTaskRevision !== state.dataRevision;
                    if (dataset.sourceVersion === dataset.currentSourceVersion) app.state.datasets = [dataset, ...(app.state.datasets || []).filter(item => item.id !== dataset.id)];
                    if (historical || state.nodeTaskRevision === state.dataRevision) {
                        state.previewData = { nodeId: job.node.targetNodeId, nodeName: dataset.name, columns: dataset.columns.map(column => ({ name: column.name, type: '输出字段' })),
                            rows: dataset.previewRows.map(row => Object.fromEntries(dataset.columns.map(column => [column.name, row[column.key]]))), totalRows: Number(dataset.rowCount),
                            displayedRows: dataset.previewRows.length, truncated: Number(dataset.rowCount) > dataset.previewRows.length, durationMs: job.executionMetrics?.workerMs || 0 };
                        state.previewStale = historical;
                    }
                }
                renderPreviewState();
                return job;
            }
            renderPreviewState();
            await new Promise(resolve => setTimeout(resolve, 600));
        }
        return null;
    }

    async function submitNodeTask(nodeId, datasetName = '') {
        if (!nodeId || !state.selected?.id) throw new Error('请先在画布中选择一个表或算子节点。');
        if (state.nodeSubmitting || pending(state.nodeJob)) throw new Error('已有节点任务正在提交或执行，请先等待完成或取消当前任务。');
        m.capture('node-history');
        const current = m.capture('node-task');
        const revision = state.dataRevision;
        const body = { targetNodeId: nodeId, definitionNodes: m.clone(state.draft?.nodes || []), flowGraph: m.clone(state.flowGraph || { nodes: [], edges: [] }),
            expectedVersion: state.selected.version, limit: 50, ...(datasetName ? { datasetName } : {}) };
        const signature = JSON.stringify(body);
        if (!state.nodeRequests.has(signature)) {
            if (state.nodeRequests.size >= 20) state.nodeRequests.delete(state.nodeRequests.keys().next().value);
            state.nodeRequests.set(signature, m.key());
        }
        body.requestKey = state.nodeRequests.get(signature);
        state.previewOpen = true;
        state.previewLoading = true;
        state.nodeSubmitting = true;
        state.previewData = null;
        state.previewNodeId = nodeId;
        state.previewError = '';
        state.previewStale = false;
        state.nodeTaskRevision = revision;
        m.render();
        try {
            const data = await request(`/models/${encodeURIComponent(state.selected.id)}/${datasetName ? 'node-datasets' : 'node-preview'}`, json(body));
            if (!current()) return null;
            state.nodeSubmitting = false;
            rememberJob(data.job);
            // 编辑后的迟到结果只更新任务状态，不覆盖新配置下的预览或字段缓存。
            state.nodeTaskRevision = revision;
            return await pollNodeJob();
        } catch (error) {
            if (current()) { state.previewLoading = false; state.previewError = error.message || '节点任务请求失败，请重试；相同请求会复用原任务。'; renderPreviewState(); }
            throw error;
        } finally {
            if (current()) state.nodeSubmitting = false;
        }
    }

    function runNodePreview(targetNodeId) {
        return submitNodeTask(targetNodeId || state.selectedNodeId || state.draft?.nodes?.[0]?.id || '');
    }

    async function resumeNodeJob() {
        try { state.previewError = ''; return await pollNodeJob(); }
        catch (error) { state.previewLoading = false; state.previewError = error.message; renderPreviewState(); throw error; }
    }

    async function cancelNodeJob() {
        if (!pending(state.nodeJob)) return;
        const current = m.capture('node-cancel'), id = state.nodeJob.id;
        const data = await request(`/async-queries/${encodeURIComponent(id)}/cancel`, json({}));
        if (!current() || state.nodeJob?.id !== id) return;
        rememberJob(data.job);
        return resumeNodeJob();
    }

    async function selectNodeJob(id) {
        if (state.nodeSubmitting || pending(state.nodeJob) && id !== state.nodeJob.id) throw new Error('当前节点任务尚未结束，请先等待完成或取消，再查看其他任务。');
        const job = state.nodeJobs.find(item => item.id === id);
        if (!job) return;
        rememberJob(job);
        state.nodeTaskRevision = -1;
        state.previewData = null;
        state.previewNodeId = job.node?.targetNodeId || '';
        state.nodeHistoryOpen = true;
        state.previewError = '';
        state.previewOpen = true;
        state.previewLoading = pending(job);
        m.render();
        return pollNodeJob({ historical: true });
    }

    async function loadNodeJobs() {
        const current = m.capture('node-history');
        const data = await request(`/models/${encodeURIComponent(state.selected.id)}/node-jobs`);
        if (!current()) return;
        state.nodeJobs = data.jobs || [];
        if (!state.nodeJob && state.nodeJobs.length) {
            const active = state.nodeJobs.find(pending);
            state.nodeJob = active || state.nodeJobs[0];
            if (active) { state.previewOpen = true; state.previewLoading = true; m.render(); return resumeNodeJob(); }
        }
        m.render();
    }

    function materializeNodeDataset(targetNodeId) {
        const nodeId = targetNodeId || state.selectedNodeId;
        if (!nodeId || !state.selected?.id) throw new Error('请先选择需要输出的算子节点。');
        const label = m.getAnyNodeName ? m.getAnyNodeName(nodeId) : nodeId;
        m.dialog('保存节点输出为数据集', `${m.input('datasetName', '新数据集名称', `${label}_输出表`.slice(0, 60), 'maxlength="80" required')}
            <p class="modeling-dialog-note">任务将固定当前上游来源版本并在隔离执行器中计算，保留全部来源、业务截止时间及完整性声明。正式分析继续使用已发布模型；您可在输出完成后基于该数据集新建正式模型。</p>`,
        async form => {
            const job = await submitNodeTask(nodeId, m.value(form, 'datasetName').trim());
            if (job?.status === 'succeeded') { m.render(); app.toast(`已生成数据集「${job.result.dataset.name}」（共 ${job.result.rowCount} 行）。`, 'success'); }
        });
    }

    Object.assign(m, { renderPreviewDock, renderPreviewState, runNodePreview, materializeNodeDataset, resumeNodeJob, cancelNodeJob, selectNodeJob, loadNodeJobs });
})();
