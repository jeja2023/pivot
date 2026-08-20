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

function agentTraceTypeLabel(type = '') {
    return ({
        model: '模型', tool: '工具', plan: '规划', dag: '工作流', dag_node: '节点',
        agent: '智能体', handoff: '交接', routing: '路由', control: '控制', note: '记录'
    })[String(type || '').toLowerCase()] || '步骤';
}

function agentTraceDuration(value) {
    const ms = Math.max(Number(value) || 0, 0);
    if (ms >= 60000) return `${(ms / 60000).toFixed(ms >= 600000 ? 0 : 1)} 分钟`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} 秒`;
    return `${Math.round(ms)} 毫秒`;
}

function agentTraceDisplayName(span = {}) {
    const name = String(span.name || '').trim();
    if (!name) return '运行步骤';
    if (/^(?:mcp\.\d+\.)?[a-z][\w-]*(?:\.[\w-]+)+$/i.test(name)) return agentToolTitle(name);
    return name;
}

function agentTraceTimestamp(value) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const normalized = /[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}+08:00`;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}

function agentTraceReadableDetail(span = {}) {
    const items = [];
    if (span.details) items.push(['运行信息', span.details]);
    if (span.input) items.push(['输入摘要', span.input]);
    if (span.output) items.push(['输出摘要', span.output]);
    if (!items.length && !span.error_message) return '';
    return `
        <details class="agent-trace-detail">
            <summary>查看上下文</summary>
            <div class="agent-trace-detail-body">
                ${span.error_message ? `<div class="error-detail">${agentEscape(span.error_message)}</div>` : ''}
                ${items.map(([label, value]) => `
                    <section>
                        <h5>${agentEscape(label)}</h5>
                        ${typeof agentResultReadableMarkup === 'function'
                            ? agentResultReadableMarkup(value, { maxRows: 4, maxItems: 5 })
                            : `<p>${agentEscape(agentShortText(JSON.stringify(value), 600))}</p>`}
                    </section>
                `).join('')}
            </div>
        </details>
    `;
}

function renderAgentTrace(traceData = {}, runStatus = '') {
    const spans = Array.isArray(traceData?.spans) ? traceData.spans : [];
    if (!spans.length) return '';
    const summary = traceData.summary || {};
    const starts = spans.map(span => agentTraceTimestamp(span.started_at)).filter(Boolean);
    const traceStart = agentTraceTimestamp(traceData.trace?.started_at) || (starts.length ? Math.min(...starts) : Date.now());
    const spanEnd = Math.max(traceStart, ...spans.map(span => agentTraceTimestamp(span.completed_at) || (agentTraceTimestamp(span.started_at) + Number(span.duration_ms || 0))));
    const longestSpanMs = Math.max(0, ...spans.map(span => Number(span.duration_ms || 0)));
    const totalMs = Math.max(Number(summary.totalDurationMs || 0), spanEnd - traceStart, longestSpanMs, 1);
    const expanded = ['error', 'approval_required'].includes(String(runStatus || '')) ? ' open' : '';
    return `
        <details class="agent-trace-panel"${expanded}>
            <summary class="agent-trace-head">
                <span><strong>运行追踪</strong><em>${spans.length} 个环节</em></span>
                <span>
                    <em>总耗时 ${agentEscape(agentTraceDuration(totalMs))}</em>
                    ${Number(summary.errorCount || 0) ? `<em class="is-error">${Number(summary.errorCount)} 个异常</em>` : '<em class="is-success">链路正常</em>'}
                </span>
            </summary>
            <div class="agent-trace-list">
                ${spans.map(span => {
                    const start = agentTraceTimestamp(span.started_at) || traceStart;
                    const duration = Math.max(Number(span.duration_ms || 0), 12);
                    const left = Math.max(0, Math.min(((start - traceStart) / totalMs) * 100, 96));
                    const width = Math.max(2, Math.min((duration / totalMs) * 100, 100 - left));
                    const status = span.status === 'error' ? 'error' : (span.status === 'running' ? 'running' : 'completed');
                    return `
                        <article class="agent-trace-item ${status}">
                            <div class="agent-trace-item-meta">
                                <span class="agent-trace-type">${agentEscape(agentTraceTypeLabel(span.span_type))}</span>
                                <strong>${agentEscape(agentTraceDisplayName(span))}</strong>
                                <em>${agentEscape(agentTraceDuration(span.duration_ms))}</em>
                            </div>
                            <div class="agent-trace-track" aria-label="${agentEscape(agentTraceDisplayName(span))}，耗时 ${agentEscape(agentTraceDuration(span.duration_ms))}">
                                <span style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span>
                            </div>
                            ${agentTraceReadableDetail(span)}
                        </article>
                    `;
                }).join('')}
            </div>
        </details>
    `;
}

function agentRunDurationLabel(value) {
    const ms = Math.max(Number(value) || 0, 0);
    if (!ms) return '—';
    if (ms >= 60000) return `${(ms / 60000).toFixed(ms >= 600000 ? 0 : 1)} 分钟`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} 秒`;
    return `${Math.round(ms)} 毫秒`;
}

function agentRunFriendlySummary(run = {}, progress = {}) {
    const status = String(run.status || '').toLowerCase();
    const records = Number(progress.stepCount || 0);
    const rounds = Number(progress.roundCount || 0);
    const maxSteps = Number(progress.maxSteps || run.max_steps || 0);
    const isDag = String(run.run_mode || '') === 'dag';
    const limitMessage = String(run.error_message || '').trim();
    if (status === 'queued') return '任务已进入队列，稍后将自动开始。';
    if (status === 'running') {
        if (isDag) return `工作流正在运行，当前已有 ${records} 条执行记录。`;
        return maxSteps > 0 ? `正在执行第 ${Math.min(rounds + 1, maxSteps)} 轮，上限 ${maxSteps} 轮。` : `正在执行第 ${rounds + 1} 轮。`;
    }
    if (status === 'approval_required') return '任务需要确认工具权限，确认后才会继续。';
    if (status === 'completed') return `${records} 条执行记录已完成，结果已生成。`;
    if (status === 'completed_with_errors' && /最大执行轮次/.test(limitMessage)) return limitMessage;
    if (status === 'completed_with_errors') return `${records} 条执行记录已完成，但有部分结果需要留意。`;
    if (status === 'error') return '任务未能完成，请查看失败步骤并重试。';
    if (status === 'cancelled') return '任务已停止，当前没有新的结果。';
    return agentStatusLabel(status) || '任务状态已更新。';
}

function agentRunActionMarkup(run = {}, options = {}) {
    const { isPreview = false, canCancel = false, canApprove = false, canRerun = false,
        canCreateWorkflowDraft = false, checkpoints = {}, isActive = false } = options;
    const actions = [];
    if (canCancel) actions.push(`<button class="btn-danger-outline" data-agent-cancel="${agentEscape(run.id)}">停止任务</button>`);
    if (canApprove) actions.push(`<button class="btn-primary" data-agent-approve="${agentEscape(run.id)}">批准并继续</button>`);
    if (canApprove) actions.push(`<button class="btn-danger-outline" data-agent-reject="${agentEscape(run.id)}">拒绝工具</button>`);
    if (canRerun) actions.push(`<button class="btn-primary" data-agent-rerun="${agentEscape(run.id)}">重新运行</button>`);
    if (!isPreview && !isActive && (run.final_answer || run.error_message)) {
        actions.push(`<button class="btn-secondary" data-agent-save-artifact="${agentEscape(run.id)}">保存结果</button>`);
    }
    if (!isPreview && !isActive) actions.push(`<button class="btn-secondary" data-agent-export-md="${agentEscape(run.id)}">导出结果</button>`);
    const secondary = [];
    if (canRerun) {
        secondary.push(`<button class="btn-secondary" data-agent-resume="${agentEscape(run.id)}">${Number(checkpoints.total || 0) ? '从检查点继续' : '从断点继续'}</button>`);
    }
    if (canCreateWorkflowDraft) secondary.push(`<button class="btn-secondary" data-agent-create-workflow-draft="${agentEscape(run.id)}">转为工作流</button>`);
    if (!isPreview && !isActive) secondary.push(`<button class="btn-secondary" data-agent-add-evaluation="${agentEscape(run.id)}">加入评测集</button>`);
    return `${actions.join('')}${secondary.length ? `<details class="agent-run-more-actions"><summary class="btn-secondary">更多操作</summary><div>${secondary.join('')}</div></details>` : ''}`;
}

document.addEventListener('click', async (event) => {
    const copyGoalBtn = event.target.closest('[data-agent-copy-goal]');
    if (copyGoalBtn) {
        const text = copyGoalBtn.dataset.agentCopyGoal || '';
        if (text) {
            try {
                await navigator.clipboard.writeText(text);
                if (typeof showToast === 'function') showToast('已成功复制任务目标到剪贴板', 'success');
            } catch (e) {
                if (typeof showToast === 'function') showToast('复制失败，请手动选择文本复制', 'error');
            }
        }
        return;
    }
    const editBtn = event.target.closest('[data-agent-run-edit], [data-agent-edit-run]');
    if (editBtn) {
        const runId = editBtn.dataset.agentRunEdit || editBtn.dataset.agentEditRun;
        if (runId) openAgentTaskEditModal(runId);
        return;
    }
    if (event.target.closest('#agent-task-edit-close-btn, #agent-task-edit-cancel-btn')) {
        closeAgentTaskEditModal();
        return;
    }
    if (event.target.closest('#agent-task-edit-save-btn')) {
        saveAgentTaskEdit();
        return;
    }
    const activeMoreActions = event.target.closest('.agent-run-more-actions');
    if (activeMoreActions) {
        if (event.target.closest('.agent-run-more-actions > div')) {
            document.querySelectorAll('.agent-run-more-actions').forEach(menu => menu.removeAttribute('open'));
        } else {
            document.querySelectorAll('.agent-run-more-actions').forEach(menu => {
                if (menu !== activeMoreActions) menu.removeAttribute('open');
            });
        }
    } else {
        document.querySelectorAll('.agent-run-more-actions').forEach(menu => menu.removeAttribute('open'));
    }
});

function openAgentTaskEditModal(runId) {
    const run = (typeof agentRunsCache !== 'undefined' && Array.isArray(agentRunsCache) ? agentRunsCache.find(r => r.id === runId) : null) || (currentRunDetailRecord?.id === runId ? currentRunDetailRecord : null);
    if (!run) return;
    const modal = document.getElementById('agent-task-edit-modal');
    if (!modal) return;
    const displayTitle = run.title && !agentLooksLikeCorruptTitle(run.title) ? run.title : '';
    document.getElementById('agent-task-edit-run-id').value = run.id;
    document.getElementById('agent-task-edit-title-input').value = displayTitle;
    document.getElementById('agent-task-edit-goal-input').value = run.goal || '';
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => document.getElementById('agent-task-edit-goal-input')?.focus(), 0);
}

function closeAgentTaskEditModal() {
    const modal = document.getElementById('agent-task-edit-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
}

async function saveAgentTaskEdit() {
    const runId = document.getElementById('agent-task-edit-run-id')?.value;
    const titleInput = document.getElementById('agent-task-edit-title-input')?.value || '';
    const goalInput = document.getElementById('agent-task-edit-goal-input')?.value || '';
    if (!runId) return;
    if (!goalInput.trim()) {
        if (typeof showToast === 'function') showToast('任务目标不能为空', 'error');
        return;
    }
    try {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: titleInput.trim(), goal: goalInput.trim() })
        });
        const data = await res.json();
        if (!res.ok) {
            if (typeof showToast === 'function') showToast(data.error || '修改任务记录失败', 'error');
            return;
        }
        if (typeof showToast === 'function') showToast('任务目标与标题已成功修改', 'success');
        closeAgentTaskEditModal();
        if (typeof loadAgentRuns === 'function') loadAgentRuns(agentRunsPage);
        if (activeAgentRunId === runId && isAgentRunDetailModalOpen()) {
            openAgentRun(runId, { silent: true });
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast(`修改失败: ${e.message}`, 'error');
    }
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
    currentRunDetailRecord = run;
    const isPreview = isAgentWorkflowPreviewRun(run, options);
    const steps = data.steps || [];
    const dagNodes = agentSortDagNodesForDisplay(data.dagNodes || []);
    const progress = data.progress || {};
    const trace = data.trace || {};
    const checkpoints = data.checkpoints || {};
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
    const displayTitle = run.title && !agentLooksLikeCorruptTitle(run.title) ? run.title : '自主任务';
    const goalText = String(run.goal || '').trim();
    const showDagNodeDetails = dagNodes.length > 0;
    const visualOutputs = renderAgentRunVisualOutputs(dagNodes, steps, run.final_answer, run.status);
    const title = document.getElementById('agent-run-detail-title');
    if (title) {
        title.textContent = isPreview ? '工作流预览结果' : '任务执行结果';
        title.setAttribute('title', displayTitle);
    }
    const runStatus = String(run.status || '').toLowerCase();
    const statusLabel = agentStatusLabel(runStatus);
    const friendlySummary = agentRunFriendlySummary(run, progress);
    const durationLabel = agentRunDurationLabel(progress.totalDurationMs);
    const friendlyTokenUsage = tokenUsage
        ? tokenUsage.replace(/^模型用量\s*/u, '总计 ')
        : '';
    const actionMarkup = agentRunActionMarkup(run, {
        isPreview,
        canCancel,
        canApprove,
        canRerun,
        canCreateWorkflowDraft,
        checkpoints,
        isActive: isAgentRunActive(run.status)
    });
    const processExpanded = ['error', 'approval_required', 'running'].includes(runStatus) ? ' open' : '';
    const technicalSummary = [
        `<div><dt>运行模式</dt><dd>${agentEscape(agentRunModeLabel(run.run_mode))}</dd></div>`,
        `<div><dt>工具权限</dt><dd>${agentEscape(agentToolPolicyLabel(run.tool_policy))}</dd></div>`,
        `<div><dt>执行记录</dt><dd>${Number(progress.stepCount || 0)} 条</dd></div>`,
        `<div><dt>工具调用</dt><dd>${Number(progress.toolCount || 0)} 次</dd></div>`,
        `<div><dt>检查点</dt><dd>${Number(checkpoints.total || 0)} 个</dd></div>`,
        friendlyTokenUsage ? `<div><dt>模型用量</dt><dd>${agentEscape(friendlyTokenUsage)}</dd></div>` : ''
    ].join('');
    PivotSafeHtml.setHtml(detail, `
        <section class="agent-run-overview ${agentEscape(runStatus)}">
            <div class="agent-run-overview-top">
                <div class="agent-run-status-copy">
                    <span class="agent-run-status-icon" aria-hidden="true"></span>
                    <div>
                        <span class="agent-run-kicker">${isPreview ? '工作流预览' : '任务执行'}</span>
                        <h4>${agentEscape(statusLabel)}</h4>
                        <p>${agentEscape(friendlySummary)}</p>
                    </div>
                </div>
                <div class="agent-run-actions">${actionMarkup}</div>
            </div>
            <div class="agent-run-goal-box">
                <div class="agent-run-meta-item">
                    <span class="agent-run-meta-label">任务标题</span>
                    <strong class="agent-run-title-val">${agentEscape(displayTitle)}</strong>
                </div>
                <div class="agent-run-meta-item agent-run-goal-item">
                    <div class="agent-run-goal-head">
                        <span class="agent-run-meta-label">任务目标</span>
                        <div class="agent-run-goal-actions">
                            ${goalText ? `<button type="button" class="btn-secondary btn-xs" data-agent-copy-goal="${agentEscapeAttr(goalText)}">复制目标</button>` : ''}
                            <button type="button" class="btn-secondary btn-xs" data-agent-edit-run="${agentEscape(run.id)}">修改任务</button>
                        </div>
                    </div>
                    <div class="agent-run-goal-body">${agentEscape(goalText || '-')}</div>
                </div>
            </div>
            <div class="agent-progress-bar" aria-label="执行进度"><span style="width: ${progressPercent}%"></span></div>
            <dl class="agent-run-key-metrics">
                ${String(run.run_mode || '') === 'dag'
                    ? `<div><dt>执行记录</dt><dd>${Number(progress.stepCount || 0)}</dd></div>`
                    : `<div><dt>执行轮次</dt><dd>${Number(progress.roundCount || 0)}${progress.maxSteps ? ` / ${Number(progress.maxSteps)}` : ''}</dd></div>`}
                <div><dt>总耗时</dt><dd>${agentEscape(durationLabel)}</dd></div>
                <div><dt>异常数量</dt><dd class="${Number(progress.errorCount || 0) ? 'has-error' : ''}">${Number(progress.errorCount || 0)}</dd></div>
            </dl>
        </section>
        <details class="agent-run-technical-summary">
            <summary><span>运行信息</span><em>${agentEscape(progressLabel)} · ${agentEscape(agentRunModeLabel(run.run_mode))}</em></summary>
            <dl>${technicalSummary}</dl>
        </details>
        ${run.final_answer ? renderAgentFinalAnswer(run.final_answer) : ''}
        ${run.error_message ? `<div class="error-detail">${agentEscape(run.error_message)}</div>` : ''}
        ${visualOutputs}
        <details class="agent-run-process"${processExpanded}>
            <summary><span>执行过程</span><em>${showDagNodeDetails ? `${dagNodes.length} 个步骤` : `${steps.length} 个步骤`}</em></summary>
            <div class="agent-run-process-body">
                ${showDagNodeDetails ? `
                    <div class="agent-dag-list">
                        ${renderAgentDagRunGraph(dagNodes)}
                        <div class="agent-tool-section-head compact"><strong>步骤详情</strong><span>${dagNodes.length} 个步骤</span></div>
                        ${dagNodes.map((node, index) => agentDagNodeMarkup(node, index)).join('')}
                    </div>
                ` : ''}
                ${showDagNodeDetails ? '' : buildAgentToolStatsMarkup(steps)}
                ${showDagNodeDetails ? '' : `<div class="agent-step-list">
                    ${steps.map(step => agentStepMarkup(step)).join('') || '<div class="empty-state agent-empty-state">任务还没有执行步骤。</div>'}
                </div>`}
                ${renderAgentTrace(trace, run.status)}
            </div>
        </details>
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
    detail.querySelector('[data-agent-save-artifact]')?.addEventListener('click', () => window.Pivot.moduleApi('agent.artifacts').saveFromRun?.(run.id));
    detail.querySelector('[data-agent-add-evaluation]')?.addEventListener('click', () => {
        window.Pivot.moduleApi('agent.evaluations').openForRun?.(run);
    });
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
        if (event.target.closest('#agent-audit-close-btn')) {
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
        const stats = `记录 ${Number(item.step_count || 0)} / 工具 ${Number(item.tool_count || 0)} / 错误 ${Number(item.error_count || 0)}`;
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
