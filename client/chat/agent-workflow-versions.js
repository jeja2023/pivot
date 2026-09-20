/* Agent 工作流版本弹窗与差异辅助函数（拆自 agent-workflow-library.js） */



function ensureAgentWorkflowVersionsModal() {
    let modal = document.getElementById('agent-workflow-versions-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-workflow-versions-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    PivotSafeHtml.setHtml(modal, `
        <div class="modal rag-detail-modal agent-workflow-versions-modal">
            <div class="rag-detail-header">
                <div>
                    <h3>工作流版本</h3>
                    <p class="model-modal-desc">查看历史版本，加载到画布预览，或回滚为新的当前版本。</p>
                </div>
                <button type="button" id="agent-workflow-versions-close-btn" class="btn-secondary">关闭</button>
            </div>
            <div id="agent-workflow-versions-body" class="agent-workflow-versions-body"></div>
        </div>
    `);
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
        if (event.target.closest('#agent-workflow-versions-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
}

function selectedAgentWorkflow() {
    const select = document.getElementById('agent-workflow-select');
    return agentWorkflowsCache.find(item => String(item.id) === String(select?.value || activeAgentWorkflowId));
}

function currentWorkflowMatchesSelected(workflow) {
    if (!workflow) return false;
    try {
        const draftName = String(agentWorkflowDraftName || workflow.name || '').trim().slice(0, 100);
        const draftSpec = dagEditorInstance?.getValue?.() || parseAgentWorkflowText();
        return draftName === String(workflow.name || '').trim().slice(0, 100)
            && JSON.stringify(draftSpec) === JSON.stringify(workflow.dag_spec || { nodes: [] });
    } catch (e) {
        return false;
    }
}

function agentWorkflowVersionMarkup(item, workflow, release = null) {
    const spec = item.dag_spec || { nodes: [] };
    const nodeCount = Array.isArray(spec.nodes) ? spec.nodes.length : 0;
    const isCurrent = Number(item.version) === Number(workflow?.current_version);
    const isPublished = Number(item.version) === Number(workflow?.published_version);
    const canReview = Boolean(release?.id && release.review_status === 'pending' && typeof isAdminUser === 'function' && isAdminUser());
    return `
        <div class="agent-workflow-version-item ${isCurrent ? 'current' : ''}">
            <div>
                <strong>版本 ${Number(item.version || 0)}${isCurrent ? ' · 当前' : ''}${isPublished ? ' · 已发布' : ''}</strong>
                <span>${nodeCount} 节点 · ${agentEscape(item.created_at || '-')}</span>
                ${item.note ? `<small>${agentEscape(agentShortText(item.note, 120))}</small>` : ''}
                ${release?.release_note ? `<small>发布说明：${agentEscape(agentShortText(release.release_note, 120))}</small>` : ''}
                ${release?.review_status && release.review_status !== 'not_required' ? `<small>审阅：${release.review_status === 'approved' ? '已通过' : release.review_status === 'changes_requested' ? '需修改' : '待审阅'}${release.review_note ? ` · ${agentEscape(agentShortText(release.review_note, 100))}` : ''}</small>` : ''}
            </div>
            <div class="agent-workflow-version-actions">
                <button type="button" class="btn-secondary" data-agent-workflow-version-diff="${agentEscape(item.version)}">对比当前</button>
                <button type="button" class="btn-secondary" data-agent-workflow-version-impact="${agentEscape(item.version)}">影响清单</button>
                <button type="button" class="btn-secondary" data-agent-workflow-version-load="${agentEscape(item.version)}">加载旧版</button>
                <button type="button" class="btn-secondary" data-agent-workflow-version-publish="${agentEscape(item.version)}" ${isPublished ? 'disabled' : ''}>发布</button>
                <button type="button" class="btn-secondary" data-agent-workflow-version-publish-note="${agentEscape(item.version)}" ${isPublished ? 'disabled' : ''}>附说明发布</button>
                ${canReview ? `<button type="button" class="btn-secondary" data-agent-workflow-release-review="${agentEscape(release.id)}" data-agent-workflow-review-status="approved">通过审阅</button><button type="button" class="btn-secondary" data-agent-workflow-release-review="${agentEscape(release.id)}" data-agent-workflow-review-status="changes_requested">要求修改</button>` : ''}
                <button type="button" class="btn-primary" data-agent-workflow-version-restore="${agentEscape(item.version)}" ${isCurrent ? 'disabled' : ''}>回滚</button>
            </div>
        </div>
    `;
}

async function reviewAgentWorkflowRelease(releaseId, status) {
    const isApproved = status === 'approved';
    const note = await window.Pivot.legacy.showInputPrompt?.({
        title: isApproved ? '通过工作流发布审阅' : '要求修改工作流发布',
        message: isApproved ? '请填写审阅结论或上线注意事项。' : '请说明需要修改的内容，发布所有者将收到通知。',
        placeholder: isApproved ? '例如：已核对影响清单和回滚路径。' : '例如：请补充写操作的幂等与回滚说明。'
    });
    if (note === null || note === undefined) return false;
    const reviewNote = String(note).trim().slice(0, 2000);
    if (!reviewNote) {
        showToast('请填写审阅说明', 'warning');
        return false;
    }
    const response = await apiFetch(`${API_BASE}/agents/workflows/releases/${encodeURIComponent(releaseId)}/review`, {
        method: 'POST',
        body: JSON.stringify({ status, note: reviewNote })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        showToast(data.error || '工作流发布审阅失败', 'error');
        return false;
    }
    const toastMessage = status === 'approved' ? '已通过工作流发布审阅' : '已通知所有者修改工作流发布';
    showToast(toastMessage, 'success');
    return true;
}

function agentWorkflowReleaseImpactMarkup(impact = {}) {
    const summary = impact.summary || {};
    const renderItems = (title, entries = []) => {
        if (!entries.length) return '';
        return `<section><strong>${title}（${entries.length}）</strong><ul>${entries.slice(0, 20).map(item => `<li>${agentEscape(item.title || item.nodeId || '-')} · ${agentEscape(item.tool || '')}</li>`).join('')}</ul></section>`;
    };
    const unavailableTools = renderItems('当前不可用工具', impact.unavailableTools || []);
    return `<section class="agent-workflow-diff-panel agent-workflow-release-impact"><header><strong>发布影响清单 · 版本 ${agentEscape(impact.version || '-')}</strong><span>${Number(summary.nodeCount || 0)} 节点 · 变更 ${Number(summary.changedCount || 0)} 项</span></header>${renderItems('副作用操作', impact.sideEffects)}${renderItems('需要审批', impact.approvals)}${renderItems('网络访问', impact.networks)}${renderItems('子工作流', impact.subworkflows)}${unavailableTools}<section><strong>依赖</strong><span>模型 ${Number(impact.dependencies?.summary?.modelCount || 0)} · 工具 ${Number(impact.dependencies?.summary?.toolCount || 0)} · 凭据 ${Number(impact.dependencies?.summary?.credentialCount || 0)}</span></section></section>`;
}

async function showAgentWorkflowReleaseImpact(workflow, version) {
    const body = document.getElementById('agent-workflow-versions-body');
    if (!body) return;
    const target = body.querySelector(`[data-agent-workflow-version-impact="${CSS.escape(String(version))}"]`);
    target?.setAttribute('disabled', 'disabled');
    const response = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/release-impact?version=${encodeURIComponent(version)}`);
    const data = await response.json().catch(() => ({}));
    target?.removeAttribute('disabled');
    if (!response.ok) return showToast(data.error || '发布影响清单加载失败', 'error');
    body.querySelector('.agent-workflow-release-impact')?.remove();
    PivotSafeHtml.prependHtml(body, agentWorkflowReleaseImpactMarkup(data.impact));
}

function agentWorkflowDiffMarkup(diff) {
    if (!diff) return '<div class="empty-state agent-empty-state">暂无差异</div>';
    const summary = diff.summary || {};
    const renderSimple = (items, type) => items.map(item => `
        <div class="agent-workflow-diff-row ${type}">
            <strong>${agentEscape(item.id)} · ${agentEscape(item.title || '-')}</strong>
            <span>${agentEscape(item.tool || '-')}</span>
        </div>
    `).join('');
    const renderChanged = (items) => items.map(item => `
        <div class="agent-workflow-diff-row changed">
            <strong>${agentEscape(item.id)} · ${agentEscape(item.after?.title || item.before?.title || '-')}</strong>
            <span>变化：${agentEscape((item.changes || []).join('、'))}</span>
            <details>
                <summary>查看前后参数</summary>
                <pre>${agentEscape(JSON.stringify({ before: item.before, after: item.after }, null, 2))}</pre>
            </details>
        </div>
    `).join('');
    const renderWorkflowChanges = (items) => items.map(item => `
        <div class="agent-workflow-diff-row changed">
            <strong>${agentEscape(item.label || '工作流设置')}</strong>
            <details>
                <summary>查看前后配置</summary>
                <pre>${agentEscape(JSON.stringify({ before: item.before, after: item.after }, null, 2))}</pre>
            </details>
        </div>
    `).join('');
    const hasDiff = Number(summary.added || 0) || Number(summary.removed || 0) || Number(summary.changed || 0);
    if (!hasDiff) {
        return `
            <section class="agent-workflow-diff-panel">
                <header>版本 ${agentEscape(diff.from?.version)} 与版本 ${agentEscape(diff.to?.version)} 没有节点差异</header>
            </section>
        `;
    }
    return `
        <section class="agent-workflow-diff-panel">
            <header>
                <strong>版本 ${agentEscape(diff.from?.version)} → 版本 ${agentEscape(diff.to?.version)}</strong>
                <span>新增 ${Number(summary.added || 0)} · 删除 ${Number(summary.removed || 0)} · 修改 ${Number(summary.changed || 0)}</span>
            </header>
            ${diff.added?.length ? `<h4>新增节点</h4>${renderSimple(diff.added, 'added')}` : ''}
            ${diff.removed?.length ? `<h4>删除节点</h4>${renderSimple(diff.removed, 'removed')}` : ''}
            ${diff.changed?.length ? `<h4>修改节点</h4>${renderChanged(diff.changed)}` : ''}
            ${diff.workflowChanges?.length ? `<h4>工作流设置</h4>${renderWorkflowChanges(diff.workflowChanges)}` : ''}
        </section>
    `;
}

async function showAgentWorkflowVersionDiff(workflow, version) {
    const body = document.getElementById('agent-workflow-versions-body');
    if (!body) return;
    const target = body.querySelector(`[data-agent-workflow-version-diff="${CSS.escape(String(version))}"]`);
    target?.setAttribute('disabled', 'disabled');
    const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/diff?from=${encodeURIComponent(version)}&to=current`);
    const data = await res.json().catch(() => ({}));
    target?.removeAttribute('disabled');
    const existing = body.querySelector('.agent-workflow-diff-panel');
    existing?.remove();
    if (!res.ok) return showToast(data.error || '版本对比失败', 'error');
    PivotSafeHtml.prependHtml(body, agentWorkflowDiffMarkup(data));
}

async function openAgentWorkflowVersions() {
    const workflow = selectedAgentWorkflow();
    if (!workflow) return showToast('请选择要查看版本的工作流', 'warning');
    const modal = ensureAgentWorkflowVersionsModal();
    const body = document.getElementById('agent-workflow-versions-body');
    modal.classList.remove('hidden');
    PivotSafeHtml.setHtml(body, '<div class="empty-state agent-empty-state">正在加载版本...</div>');
    const [res, releasesRes] = await Promise.all([
        apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/versions`),
        apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/releases?limit=100`)
    ]);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        PivotSafeHtml.setHtml(body, `<div class="empty-state agent-empty-state">${agentEscape(data.error || '版本加载失败')}</div>`);
        return;
    }
    const versions = data.data || [];
    const releasesData = await releasesRes.json().catch(() => ({}));
    const releaseByVersion = new Map((releasesRes.ok ? releasesData.data || [] : []).map(item => [Number(item.version), item]));
    PivotSafeHtml.setHtml(body, versions.length
        ? versions.map(item => agentWorkflowVersionMarkup(item, workflow, releaseByVersion.get(Number(item.version)))).join('')
        : '<div class="empty-state agent-empty-state">暂无版本</div>');
    body.querySelectorAll('[data-agent-workflow-version-diff]').forEach(btn => {
        btn.addEventListener('click', () => showAgentWorkflowVersionDiff(workflow, btn.dataset.agentWorkflowVersionDiff));
    });
    body.querySelectorAll('[data-agent-workflow-version-impact]').forEach(btn => {
        btn.addEventListener('click', () => showAgentWorkflowReleaseImpact(workflow, btn.dataset.agentWorkflowVersionImpact));
    });
    body.querySelectorAll('[data-agent-workflow-version-load]').forEach(btn => {
        btn.addEventListener('click', () => {
            const version = versions.find(item => String(item.version) === String(btn.dataset.agentWorkflowVersionLoad));
            if (!version) return;
            writeAgentWorkflowText(version.dag_spec || { nodes: [] });
            mountAgentDagEditor();
            window.Pivot.legacy.refreshAgentDagEditor?.();
            updateAgentWorkflowRunUi();
            showToast(`已加载版本 ${version.version} 到画布，保存后会生成新版本`, 'success');
        });
    });
    body.querySelectorAll('[data-agent-workflow-version-publish]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const version = btn.dataset.agentWorkflowVersionPublish;
            btn.setAttribute('disabled', 'disabled');
            const published = await window.Pivot.legacy.publishSelectedAgentWorkflow(version);
            btn.removeAttribute('disabled');
            if (published) openAgentWorkflowVersions();
        });
    });
    body.querySelectorAll('[data-agent-workflow-version-publish-note]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const note = await window.Pivot.legacy.showInputPrompt?.({
                title: '发布说明', message: '可选。说明本次变更范围、风险或回滚注意事项，最多 2000 字。',
                placeholder: '例如：增加订单校验分支；不涉及写操作。'
            });
            if (note === null || note === undefined) return;
            btn.setAttribute('disabled', 'disabled');
            const published = await window.Pivot.legacy.publishSelectedAgentWorkflow(btn.dataset.agentWorkflowVersionPublishNote, { releaseNote: String(note).slice(0, 2000) });
            btn.removeAttribute('disabled');
            if (published) openAgentWorkflowVersions();
        });
    });
    body.querySelectorAll('[data-agent-workflow-release-review]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const reviewed = await reviewAgentWorkflowRelease(btn.dataset.agentWorkflowReleaseReview, btn.dataset.agentWorkflowReviewStatus);
            if (reviewed) openAgentWorkflowVersions();
        });
    });
    body.querySelectorAll('[data-agent-workflow-version-restore]').forEach(btn => {
        btn.addEventListener('click', () => {
            const version = btn.dataset.agentWorkflowVersionRestore;
        window.Pivot.legacy.showConfirm('回滚工作流版本', `确定将工作流回滚到版本 ${version} 吗？系统会生成一个新的当前版本。`, async () => {
                const restoreRes = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/versions/${encodeURIComponent(version)}/restore`, { method: 'POST' });
                const restoreData = await restoreRes.json().catch(() => ({}));
                if (!restoreRes.ok) return showToast(restoreData.error || '版本回滚失败', 'error');
                activeAgentWorkflowId = String(restoreData.workflow.id);
                agentWorkflowDraftName = restoreData.workflow.name || agentWorkflowDraftName;
                agentWorkflowDraftDescription = restoreData.workflow.description || agentWorkflowDraftDescription;
                writeAgentWorkflowText(restoreData.workflow.dag_spec || { nodes: [] });
                await loadAgentWorkflows();
                mountAgentDagEditor();
                window.Pivot.legacy.refreshAgentDagEditor?.();
                updateAgentWorkflowRunUi();
            showToast(`已回滚为版本 ${restoreData.workflow.current_version}`, 'success');
                openAgentWorkflowVersions();
            });
        });
    });
}
