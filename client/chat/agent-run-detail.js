// Agent 运行详情
// 拆自 agent-runs-list.js。
// Agent 运行详情、预览轮询和审计弹窗渲染。
/* eslint-disable no-undef */
function bindAgentRunTitleTooltip(list = document.getElementById('agent-runs-list')) {
    if (!list || list.dataset.boundAgentRunTitleTooltip === '1') return;
    list.dataset.boundAgentRunTitleTooltip = '1';
    const getTarget = event => event.target.closest?.('[data-agent-run-title-full]');
    list.addEventListener('mouseover', event => {
        const target = getTarget(event);
        if (target) showAgentRunTitleTooltip(target);
    });
    list.addEventListener('mousemove', event => {
        const target = getTarget(event);
        if (target && target === agentRunTitleTooltipTarget) positionAgentRunTitleTooltip(target);
    });
    list.addEventListener('mouseout', event => {
        const target = getTarget(event);
        if (target && !target.contains(event.relatedTarget)) hideAgentRunTitleTooltip(target);
    });
    list.addEventListener('focusin', event => {
        const target = getTarget(event);
        if (target) showAgentRunTitleTooltip(target);
    });
    list.addEventListener('focusout', event => {
        const target = getTarget(event);
        if (target) hideAgentRunTitleTooltip(target);
    });
    list.addEventListener('scroll', () => {
        if (agentRunTitleTooltipTarget?.isConnected) positionAgentRunTitleTooltip(agentRunTitleTooltipTarget);
    });
    window.addEventListener('resize', () => hideAgentRunTitleTooltip());
}

function isAgentRunDetailModalOpen() {
    return !document.getElementById('agent-run-detail-modal')?.classList.contains('hidden');
}

function agentRunMetadata(run = {}) {
    const metadata = run?.metadata || {};
    if (metadata && typeof metadata === 'object') return metadata;
    if (typeof metadata !== 'string') return {};
    try {
        const parsed = JSON.parse(metadata);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

function isAgentWorkflowPreviewRun(run = {}, options = {}) {
    if (options.workflowPreview) return true;
    const metadata = agentRunMetadata(run);
    return String(metadata.workflowRunSource || metadata.workflow_run_source || metadata.runSource || '').toLowerCase() === 'preview';
}

function ensureAgentRunDetailModalVisible() {
    const modal = document.getElementById('agent-run-detail-modal');
    if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
    return modal;
}

function closeAgentRunDetailModal() {
    const modal = document.getElementById('agent-run-detail-modal');
    const detail = document.getElementById('agent-run-detail');
    const closingPreview = activeAgentRunId === activeAgentWorkflowPreviewRunId;
    modal?.classList.add('hidden');
    if (detail) PivotSafeHtml.setHtml(detail, '');
    document.querySelectorAll('[data-agent-run-id]').forEach(row => row.classList.remove('active'));
    if (closingPreview) {
        stopAgentWorkflowPreviewPolling();
        activeAgentWorkflowPreviewRunId = '';
    }
    activeAgentRunId = '';
}

window.closeAgentRunDetailModal = closeAgentRunDetailModal;

window.openAgentRun = async function(runId, options = {}) {
    activeAgentRunId = runId;
    const modal = ensureAgentRunDetailModalVisible();
    const detail = document.getElementById('agent-run-detail');
    if (!detail) return null;
    document.querySelectorAll('[data-agent-run-id]').forEach(row => {
        const active = row.dataset.agentRunId === runId;
        row.classList.toggle('active', active);
    });
    modal?.classList.remove('hidden');
    if (!options.silent) PivotSafeHtml.setHtml(detail, '<div class="empty-state agent-empty-state">正在加载任务详情...</div>');
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`);
    const data = await res.json();
    if (!res.ok) {
        PivotSafeHtml.setHtml(detail, `<div class="empty-state agent-empty-state">${agentEscape(data.error || '加载失败')}</div>`);
        return null;
    }
    const run = data.run;
    const isPreview = isAgentWorkflowPreviewRun(run, options);
    const steps = data.steps || [];
    const dagNodes = agentSortDagNodesForDisplay(data.dagNodes || []);
    const progress = data.progress || {};
    const canCancel = isAgentRunActive(run.status);
    const canRerun = !isPreview && !isAgentRunActive(run.status);
    const canApprove = !isPreview && run.status === 'approval_required';
    const canCreateWorkflowDraft = !isPreview && run.run_mode !== 'dag';
    const tokenUsage = formatAgentTokenUsage(run);
    const progressPercent = Math.max(0, Math.min(Number(progress.percent || 0), 100));
    const progressLabel = agentProgressLabel(run, progress);
    if (isPreview) {
        run.title = agentPreviewDisplayTitle(agentDisplayTitle(run));
        run.final_answer = stripAgentWorkflowReportHeading(run.final_answer);
    }
    const showDagNodeDetails = dagNodes.length > 0;
    const visualOutputs = renderAgentRunVisualOutputs(dagNodes, steps, run.final_answer, run.status);
    const title = document.getElementById('agent-run-detail-title');
    if (title) title.textContent = isPreview ? `预览运行：${agentPreviewDisplayTitle(agentDisplayTitle(run))}` : agentDisplayTitle(run);
    PivotSafeHtml.setHtml(detail, `
        <div class="agent-progress-summary">
            <div class="agent-progress-bar"><span style="width: ${progressPercent}%"></span></div>
            <div class="agent-progress-meta">
                <span>${agentEscape(progressLabel)}</span>
                <span>工具 ${Number(progress.toolCount || 0)}</span>
                <span>错误 ${Number(progress.errorCount || 0)}</span>
                <span>耗时 ${Number(progress.totalDurationMs || 0)} 毫秒</span>
                <span>${agentEscape(agentRunModeLabel(run.run_mode))}</span>
                <span>${agentEscape(agentToolPolicyLabel(run.tool_policy))}</span>
                ${tokenUsage ? `<span>${agentEscape(tokenUsage)}</span>` : ''}
                ${canCancel ? `<button class="btn-danger-outline" data-agent-cancel="${agentEscape(run.id)}">停止</button>` : ''}
                ${canApprove ? `<button class="btn-primary" data-agent-approve="${agentEscape(run.id)}">批准工具</button><button class="btn-danger-outline" data-agent-reject="${agentEscape(run.id)}">拒绝</button>` : ''}
                ${canRerun ? `<button class="btn-secondary" data-agent-rerun="${agentEscape(run.id)}">重新运行</button>` : ''}
                ${canRerun ? `<button class="btn-secondary" data-agent-resume="${agentEscape(run.id)}">断点续跑</button>` : ''}
                ${canCreateWorkflowDraft ? `<button class="btn-secondary" data-agent-create-workflow-draft="${agentEscape(run.id)}">生成工作流草稿</button>` : ''}
                ${!isPreview && (run.final_answer || run.error_message) ? `<button class="btn-secondary" data-agent-save-artifact="${agentEscape(run.id)}">保存结果</button>` : ''}
                ${!isPreview ? `<button class="btn-secondary" data-agent-export-md="${agentEscape(run.id)}">导出</button>` : ''}
            </div>
        </div>
        ${run.final_answer ? `<div class="agent-final">${renderMarkdown(normalizeAgentMarkdown(run.final_answer))}</div>` : ''}
        ${run.error_message ? `<div class="error-detail">${agentEscape(run.error_message)}</div>` : ''}
        ${visualOutputs}
        ${showDagNodeDetails ? `
            <div class="agent-dag-list">
                <div class="agent-tool-section-head compact">
                    <strong>工作流节点</strong>
                    <span>${dagNodes.length} 个节点</span>
                </div>
                ${renderAgentDagRunGraph(dagNodes)}
                ${dagNodes.map(node => agentDagNodeMarkup(node)).join('')}
            </div>
        ` : ''}
        ${showDagNodeDetails ? '' : buildAgentToolStatsMarkup(steps)}
        ${showDagNodeDetails ? '' : `<div class="agent-step-list">
            ${steps.map(step => agentStepMarkup(step)).join('') || '<div class="empty-state agent-empty-state">任务还没有执行步骤。</div>'}
        </div>`}
    `);
    detail.querySelector('[data-agent-cancel]')?.addEventListener('click', () => {
        if (isPreview) return window.cancelAgentWorkflowPreviewRun(run.id);
        return window.cancelAgentRun(run.id);
    });
    detail.querySelector('[data-agent-approve]')?.addEventListener('click', () => window.approveAgentRun(run.id, true));
    detail.querySelector('[data-agent-reject]')?.addEventListener('click', () => window.approveAgentRun(run.id, false));
    detail.querySelector('[data-agent-rerun]')?.addEventListener('click', () => window.rerunAgentRun(run.id));
    detail.querySelector('[data-agent-resume]')?.addEventListener('click', () => window.resumeAgentRun(run.id));
    detail.querySelector('[data-agent-create-workflow-draft]')?.addEventListener('click', () => window.createWorkflowDraftFromAgentRun(run.id));
    detail.querySelectorAll('[data-agent-dag-rerun-node]').forEach(btn => {
        btn.addEventListener('click', () => window.rerunAgentDagNode(run.id, btn.dataset.agentDagRerunNode || ''));
    });
    detail.querySelector('[data-agent-save-artifact]')?.addEventListener('click', () => window.saveAgentArtifact(run.id));
    detail.querySelector('[data-agent-export-md]')?.addEventListener('click', () => agentDownload(`${API_BASE}/agents/runs/${encodeURIComponent(run.id)}/export?format=markdown`));
    window.renderPivotCharts?.(detail);
    return run;
};

function stopAgentWorkflowPreviewPolling() {
    if (agentWorkflowPreviewTimer) {
        clearInterval(agentWorkflowPreviewTimer);
        agentWorkflowPreviewTimer = null;
    }
}

function startAgentWorkflowPreviewPolling(runId) {
    stopAgentWorkflowPreviewPolling();
    activeAgentWorkflowPreviewRunId = runId;
    agentWorkflowPreviewTimer = setInterval(async () => {
        if (activeAgentWorkflowPreviewRunId !== runId || activeAgentRunId !== runId || !isAgentRunDetailModalOpen()) {
            stopAgentWorkflowPreviewPolling();
            return;
        }
        try {
            const run = await window.openAgentRun(runId, { workflowPreview: true, silent: true });
            if (run && !isAgentRunActive(run.status)) stopAgentWorkflowPreviewPolling();
        } catch (e) {}
    }, 3000);
}

function ensureAgentAuditModal() {
    let modal = document.getElementById('agent-audit-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-audit-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    PivotSafeHtml.setHtml(modal, `
        <div class="modal rag-detail-modal agent-audit-modal">
            <div class="rag-detail-header">
                <div>
                    <h3>任务删除审计</h3>
                    <p class="model-modal-desc">仅 admin 权限层级可查看，普通用户移除的任务记录会保留在这里。</p>
                </div>
                <button type="button" id="agent-audit-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div class="table-container rag-audit-table-wrap agent-audit-table-wrap">
                <table class="data-table compact-table">
                    <thead>
                        <tr>
                            <th style="width: 52px;" class="text-center">序号</th>
                            <th>任务</th>
                            <th style="width: 120px;">用户</th>
                            <th style="width: 90px;">状态</th>
                            <th style="width: 150px;">模型</th>
                            <th style="width: 115px;">统计</th>
                            <th style="width: 155px;">删除时间</th>
                            <th style="width: 120px;">删除人</th>
                        </tr>
                    </thead>
                    <tbody id="agent-audit-body"></tbody>
                </table>
            </div>
        </div>
    `);
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#agent-audit-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
}

function renderAgentAuditRows(items = []) {
    if (!items.length) {
        return '<tr><td colspan="8" class="text-center muted-text">暂无已移除的任务记录</td></tr>';
    }
    return items.map((item, index) => {
        const userName = item.nickname || item.username || `用户 ${item.user_id || '-'}`;
        const deletedBy = item.deleted_by_nickname || item.deleted_by_username || `用户 ${item.deleted_by_user || '-'}`;
        const stats = `步骤 ${Number(item.step_count || 0)} / 工具 ${Number(item.tool_count || 0)} / 错误 ${Number(item.error_count || 0)}`;
        return `
            <tr>
                <td class="text-center">${index + 1}</td>
                <td title="${agentEscape(item.goal || item.title)}">
                    <strong>${agentEscape(agentDisplayTitle(item) || '-')}</strong>
                    <small>${agentEscape(agentShortText(item.goal || '', 90))}</small>
                </td>
                <td>${agentEscape(userName)}</td>
                <td>${agentEscape(agentStatusLabel(item.status))}</td>
                <td title="${agentEscape(item.model_name || '')}">${agentEscape(item.model_name || '-')}</td>
                <td>${agentEscape(stats)}</td>
                <td>${agentEscape(formatAgentAuditDate(item.deleted_at))}</td>
                <td>${agentEscape(deletedBy)}</td>
            </tr>
        `;
    }).join('');
}
