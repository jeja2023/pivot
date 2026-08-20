// Agent 结果沉淀与导出辅助
// 拆自 agents.js。
/* eslint-disable no-undef */
async function loadAgentArtifacts() {
    const list = document.getElementById('agent-artifact-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/artifacts?limit=8`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '结果沉淀加载失败');
    agentArtifactsCache = data.data || [];
    PivotSafeHtml.setHtml(list, agentArtifactsCache.length ? agentArtifactsCache.slice(0, 4).map(item => `
        <button type="button" class="agent-ops-item" data-agent-artifact-id="${agentEscape(item.id)}">
            <strong>${agentEscape(item.title)}</strong>
            <span>版本 ${Number(item.current_version || 1)} · 共 ${Number(item.version_count || 1)} 版 · ${agentEscape(formatDateToCN(item.updated_at || item.created_at))}</span>
        </button>
        </button>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无沉淀结果</div>');
    list.querySelectorAll('[data-agent-artifact-id]').forEach(btn => {
        btn.addEventListener('click', () => loadAgentArtifactModal(btn.dataset.agentArtifactId));
    });
}

function ensureAgentArtifactModal() {
    let modal = document.getElementById('agent-artifact-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-artifact-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    PivotSafeHtml.setHtml(modal, `
        <div class="modal rag-detail-modal agent-artifact-modal">
            <div class="rag-detail-header">
                <div>
                    <h3 id="agent-artifact-title">结果版本</h3>
                    <p class="model-modal-desc" id="agent-artifact-desc"></p>
                </div>
                <button type="button" id="agent-artifact-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div class="agent-artifact-editor">
                <label>
                    <span>版本备注</span>
                    <input id="agent-artifact-note" class="form-input" placeholder="说明本次修改、回滚或校订原因">
                </label>
                <label>
                    <span>当前内容</span>
                    <textarea id="agent-artifact-content" class="form-input agent-artifact-content"></textarea>
                </label>
                <button type="button" id="agent-artifact-save-version" class="btn-primary">保存新版本</button>
            </div>
            <div id="agent-artifact-diff" class="agent-artifact-diff"></div>
            <div id="agent-artifact-version-list" class="agent-artifact-version-list"></div>
        </div>
    `);
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
        if (event.target.closest('#agent-artifact-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
}

async function loadAgentArtifactModal(artifactId) {
    const modal = ensureAgentArtifactModal();
    const res = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/versions`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '版本加载失败', 'error');
    const artifact = data.artifact || {};
    const versions = data.versions || [];
    modal.querySelector('#agent-artifact-title').textContent = artifact.title || '结果版本';
    modal.querySelector('#agent-artifact-desc').textContent = `${versions.length} 个版本 · 当前版本 ${artifact.current_version || 1}`;
    modal.querySelector('#agent-artifact-content').value = artifact.content || '';
    modal.querySelector('#agent-artifact-note').value = '';
    PivotSafeHtml.setHtml(modal.querySelector('#agent-artifact-diff'), '');
    modal.querySelector('#agent-artifact-save-version').onclick = async () => {
        const content = modal.querySelector('#agent-artifact-content').value;
        const note = modal.querySelector('#agent-artifact-note').value;
        const saveRes = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/versions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, note })
        });
        const saveData = await saveRes.json().catch(() => ({}));
        if (!saveRes.ok) return showToast(saveData.error || '保存版本失败', 'error');
        showToast('新版本已保存', 'success');
        await loadAgentArtifacts();
        await loadAgentArtifactModal(artifactId);
    };
    const list = modal.querySelector('#agent-artifact-version-list');
    PivotSafeHtml.setHtml(list, versions.map(version => `
        <div class="agent-artifact-version ${version.id === artifact.current_version_id ? 'current' : ''}">
            <div>
                <strong>版本 ${Number(version.version)}</strong>
                <span>${agentEscape(version.note || '无备注')}</span>
                <small>${agentEscape(formatDateToCN(version.created_at))}</small>
            </div>
            <div class="agent-artifact-version-actions">
                ${version.version > 1 ? `<button type="button" class="btn-secondary" data-artifact-diff="${version.version}">对比上一版</button>` : ''}
                ${version.id !== artifact.current_version_id ? `<button type="button" class="btn-secondary" data-artifact-rollback="${version.version}">回滚</button>` : ''}
            </div>
        </div>
    `).join('') || '<div class="empty-state compact">暂无版本</div>');
    list.querySelectorAll('[data-artifact-diff]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const to = Number(btn.dataset.artifactDiff);
            const diffRes = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/diff?from=${to - 1}&to=${to}`);
            const diffData = await diffRes.json().catch(() => ({}));
            if (!diffRes.ok) return showToast(diffData.error || '对比失败', 'error');
            PivotSafeHtml.setHtml(modal.querySelector('#agent-artifact-diff'), `
                <strong>版本 ${to - 1} → 版本 ${to}</strong>
                <pre>${agentEscape((diffData.diff || []).filter(row => row.type !== 'same').map(row => `${row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' '} ${row.text}`).join('\n') || '无差异')}</pre>
            `);
        });
    });
    list.querySelectorAll('[data-artifact-rollback]').forEach(btn => {
        btn.addEventListener('click', () => {
            showConfirm('回滚结果版本', `确定回滚到版本 ${btn.dataset.artifactRollback} 吗？会生成一个新的当前版本。`, async () => {
                const rollbackRes = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/rollback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ version: Number(btn.dataset.artifactRollback) })
                });
                const rollbackData = await rollbackRes.json().catch(() => ({}));
                if (!rollbackRes.ok) return showToast(rollbackData.error || '回滚失败', 'error');
                showToast('已回滚并生成新版本', 'success');
                await loadAgentArtifacts();
                await loadAgentArtifactModal(artifactId);
            });
        });
    });
    modal.classList.remove('hidden');
}

async function saveAgentArtifact(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '保存结果失败', 'error');
    showToast('结果已沉淀', 'success');
    await loadAgentArtifacts();
}

window.Pivot.exposeModule('agent.artifacts', {
    openVersions: loadAgentArtifactModal,
    saveFromRun: saveAgentArtifact,
    refresh: loadAgentArtifacts
});
