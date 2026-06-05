/* Agent 工作流版本弹窗与差异辅助函数（拆自 agent-workflow-library.js） */



function ensureAgentWorkflowVersionsModal() {
    let modal = document.getElementById('agent-workflow-versions-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-workflow-versions-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
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
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
        if (event.target === modal || event.target.closest('#agent-workflow-versions-close-btn')) {
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
        return JSON.stringify(parseAgentWorkflowText()) === JSON.stringify(workflow.dag_spec || { nodes: [] });
    } catch (e) {
        return false;
    }
}

function agentWorkflowVersionMarkup(item, workflow) {
    const spec = item.dag_spec || { nodes: [] };
    const nodeCount = Array.isArray(spec.nodes) ? spec.nodes.length : 0;
    const isCurrent = Number(item.version) === Number(workflow?.current_version);
    const isPublished = Number(item.version) === Number(workflow?.published_version);
    return `
        <div class="agent-workflow-version-item ${isCurrent ? 'current' : ''}">
            <div>
                <strong>v${Number(item.version || 0)}${isCurrent ? ' · 当前' : ''}${isPublished ? ' · 已发布' : ''}</strong>
                <span>${nodeCount} 节点 · ${agentEscape(item.created_at || '-')}</span>
                ${item.note ? `<small>${agentEscape(agentShortText(item.note, 120))}</small>` : ''}
            </div>
            <div class="agent-workflow-version-actions">
                <button type="button" class="btn-secondary" data-agent-workflow-version-diff="${agentEscape(item.version)}">对比当前</button>
                <button type="button" class="btn-secondary" data-agent-workflow-version-load="${agentEscape(item.version)}">加载旧版</button>
                <button type="button" class="btn-secondary" data-agent-workflow-version-publish="${agentEscape(item.version)}" ${isPublished ? 'disabled' : ''}>发布</button>
                <button type="button" class="btn-primary" data-agent-workflow-version-restore="${agentEscape(item.version)}" ${isCurrent ? 'disabled' : ''}>回滚</button>
            </div>
        </div>
    `;
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
    const hasDiff = Number(summary.added || 0) || Number(summary.removed || 0) || Number(summary.changed || 0);
    if (!hasDiff) {
        return `
            <section class="agent-workflow-diff-panel">
                <header>v${agentEscape(diff.from?.version)} 与 v${agentEscape(diff.to?.version)} 没有节点差异</header>
            </section>
        `;
    }
    return `
        <section class="agent-workflow-diff-panel">
            <header>
                <strong>v${agentEscape(diff.from?.version)} → v${agentEscape(diff.to?.version)}</strong>
                <span>新增 ${Number(summary.added || 0)} · 删除 ${Number(summary.removed || 0)} · 修改 ${Number(summary.changed || 0)}</span>
            </header>
            ${diff.added?.length ? `<h4>新增节点</h4>${renderSimple(diff.added, 'added')}` : ''}
            ${diff.removed?.length ? `<h4>删除节点</h4>${renderSimple(diff.removed, 'removed')}` : ''}
            ${diff.changed?.length ? `<h4>修改节点</h4>${renderChanged(diff.changed)}` : ''}
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
    body.insertAdjacentHTML('afterbegin', agentWorkflowDiffMarkup(data));
}

async function openAgentWorkflowVersions() {
    const workflow = selectedAgentWorkflow();
    if (!workflow) return showToast('请选择要查看版本的工作流', 'warning');
    const modal = ensureAgentWorkflowVersionsModal();
    const body = document.getElementById('agent-workflow-versions-body');
    modal.classList.remove('hidden');
    body.innerHTML = '<div class="empty-state agent-empty-state">正在加载版本...</div>';
    const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/versions`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        body.innerHTML = `<div class="empty-state agent-empty-state">${agentEscape(data.error || '版本加载失败')}</div>`;
        return;
    }
    const versions = data.data || [];
    body.innerHTML = versions.length
        ? versions.map(item => agentWorkflowVersionMarkup(item, workflow)).join('')
        : '<div class="empty-state agent-empty-state">暂无版本</div>';
    body.querySelectorAll('[data-agent-workflow-version-diff]').forEach(btn => {
        btn.addEventListener('click', () => showAgentWorkflowVersionDiff(workflow, btn.dataset.agentWorkflowVersionDiff));
    });
    body.querySelectorAll('[data-agent-workflow-version-load]').forEach(btn => {
        btn.addEventListener('click', () => {
            const version = versions.find(item => String(item.version) === String(btn.dataset.agentWorkflowVersionLoad));
            if (!version) return;
            writeAgentWorkflowText(version.dag_spec || { nodes: [] });
            mountAgentDagEditor();
            window.refreshAgentDagEditor?.();
            updateAgentWorkflowRunUi();
            showToast(`已加载 v${version.version} 到画布，保存后会生成新版本`, 'success');
        });
    });
    body.querySelectorAll('[data-agent-workflow-version-publish]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const version = btn.dataset.agentWorkflowVersionPublish;
            btn.setAttribute('disabled', 'disabled');
            const published = await publishSelectedAgentWorkflow(version);
            btn.removeAttribute('disabled');
            if (published) openAgentWorkflowVersions();
        });
    });
    body.querySelectorAll('[data-agent-workflow-version-restore]').forEach(btn => {
        btn.addEventListener('click', () => {
            const version = btn.dataset.agentWorkflowVersionRestore;
            showConfirm('回滚工作流版本', `确定将工作流回滚到 v${version} 吗？系统会生成一个新的当前版本。`, async () => {
                const restoreRes = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/versions/${encodeURIComponent(version)}/restore`, { method: 'POST' });
                const restoreData = await restoreRes.json().catch(() => ({}));
                if (!restoreRes.ok) return showToast(restoreData.error || '版本回滚失败', 'error');
                activeAgentWorkflowId = String(restoreData.workflow.id);
                agentWorkflowDraftName = restoreData.workflow.name || agentWorkflowDraftName;
                agentWorkflowDraftDescription = restoreData.workflow.description || agentWorkflowDraftDescription;
                writeAgentWorkflowText(restoreData.workflow.dag_spec || { nodes: [] });
                await loadAgentWorkflows();
                mountAgentDagEditor();
                window.refreshAgentDagEditor?.();
                updateAgentWorkflowRunUi();
                showToast(`已回滚为 v${restoreData.workflow.current_version}`, 'success');
                openAgentWorkflowVersions();
            });
        });
    });
}
