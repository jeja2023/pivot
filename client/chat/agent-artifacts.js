// Agent 结果沉淀与导出辅助
// 拆自 agents.js。
/* eslint-disable no-undef */
async function loadAgentArtifacts() {
    const list = document.getElementById('agent-artifact-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/artifacts?limit=8`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '结果沉淀加载失败');
    agentArtifactsCache = data.data || [];
    PivotSafeHtml.setHtml(list, agentArtifactsCache.length ? agentArtifactsCache.slice(0, 4).map(item => `
        <button type="button" class="agent-ops-item" data-agent-artifact-id="${agentEscape(item.id)}">
            <strong>${agentEscape(item.title)}</strong>
            <span>版本 ${Number(item.current_version || 1)} · 共 ${Number(item.version_count || 1)} 版 · ${agentEscape(formatDateToCN(item.updated_at || item.created_at))}</span>
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
            <div class="agent-artifact-renditions">
                <strong>已渲染文档</strong>
                <div id="agent-artifact-rendition-list" class="agent-artifact-version-list"></div>
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

function downloadAgentArtifactBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadAgentArtifactRendition(rendition) {
    const tokenRes = await apiFetch(`${API_BASE}/agents/renditions/${encodeURIComponent(rendition.id)}/download-token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.token) return showToast(tokenData.error || '获取下载令牌失败', 'error');
    const fileRes = await apiFetch(`${API_BASE}/agents/renditions/${encodeURIComponent(rendition.id)}/download?token=${encodeURIComponent(tokenData.token)}`);
    if (!fileRes.ok) return showToast('下载渲染文档失败', 'error');
    const blob = await fileRes.blob();
    downloadAgentArtifactBlob(`产物-${rendition.id}.${rendition.format}`, blob);
}

async function saveAgentArtifactRenditionToDesktop(rendition) {
    if (!window.pivotDesktop?.getDeliveryStatus) return showToast('请在 Pivot 桌面客户端中使用“保存到本机”。', 'warning');
    let status = await window.pivotDesktop.getDeliveryStatus();
    if (!status.available) return showToast(status.reason || '本机交付设备不可用。', 'error');
    if (!Array.isArray(status.grants) || !status.grants.length) {
        const configured = await window.pivotDesktop.authorizeDeliveryDirectory();
        if (configured?.canceled) return;
        status = await window.pivotDesktop.getDeliveryStatus();
    }
    const grants = Array.isArray(status.grants) ? status.grants.filter(grant => grant.grantId) : [];
    if (!grants.length) return showToast('请先在桌面端授权一个文档交付目录。', 'warning');
    const choices = grants.map(grant => `${grant.grantId}  (${grant.pathHint || '已授权目录'})`).join('\n');
    const selected = window.prompt(`请选择本次保存的授权目录：\n${choices}`, grants[0].grantId);
    if (!selected) return;
    const grant = grants.find(item => item.grantId === selected.trim());
    if (!grant) return showToast('未选择有效的目录授权。', 'warning');
    const intentRes = await apiFetch(`${API_BASE}/agents/deliveries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            renditionId: rendition.id,
            channel: 'local_device',
            deviceId: status.deviceId,
            targetDirGrant: grant.grantId,
            targetFilename: `产物-${rendition.id}`
        })
    });
    const intentData = await intentRes.json().catch(() => ({}));
    if (!intentRes.ok) return showToast(intentData.error || '创建本机交付意图失败', 'error');
    showToast(intentData.reused ? '该文档已在该目录的交付队列中。' : '已加入本机交付队列，桌面端将安全写入授权目录。', 'success');
}

async function loadAgentArtifactRenditions(modal, artifactId) {
    const list = modal.querySelector('#agent-artifact-rendition-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/renditions`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        PivotSafeHtml.setHtml(list, '<div class="empty-state compact">渲染文档加载失败</div>');
        return;
    }
    const renditions = Array.isArray(data.data) ? data.data : [];
    PivotSafeHtml.setHtml(list, renditions.map(item => `
        <div class="agent-artifact-version">
            <div><strong>${agentEscape(String(item.format || '').toUpperCase())}</strong><span>${Number(item.byte_size || 0)} 字节 · ${agentEscape(String(item.content_digest || '').slice(0, 12))}…</span></div>
            <div class="agent-artifact-version-actions">
                <button type="button" class="btn-secondary" data-artifact-rendition-download="${agentEscape(item.id)}">下载</button>
                <button type="button" class="btn-secondary" data-artifact-rendition-local="${agentEscape(item.id)}">保存到本机</button>
            </div>
        </div>
    `).join('') || '<div class="empty-state compact">暂无已渲染文档。请由 Agent 使用 artifact.render 生成，或在公文工作台直接导出。</div>');
    list.querySelectorAll('[data-artifact-rendition-download]').forEach(button => {
        button.addEventListener('click', () => {
            const rendition = renditions.find(item => String(item.id) === String(button.dataset.artifactRenditionDownload));
            if (rendition) void downloadAgentArtifactRendition(rendition);
        });
    });
    list.querySelectorAll('[data-artifact-rendition-local]').forEach(button => {
        button.addEventListener('click', () => {
            const rendition = renditions.find(item => String(item.id) === String(button.dataset.artifactRenditionLocal));
            if (rendition) void saveAgentArtifactRenditionToDesktop(rendition);
        });
    });
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
    void loadAgentArtifactRenditions(modal, artifactId);
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
            window.Pivot.legacy.showConfirm('回滚结果版本', `确定回滚到版本 ${btn.dataset.artifactRollback} 吗？会生成一个新的当前版本。`, async () => {
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
