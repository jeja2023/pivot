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
    modal.className = 'modal-overlay hidden agent-artifact-modal-overlay';
    PivotSafeHtml.setHtml(modal, `
        <div class="modal agent-artifact-modal" role="dialog" aria-modal="true" aria-labelledby="agent-artifact-title">
            <div class="agent-artifact-header">
                <div class="agent-artifact-header-title-wrap">
                    <div class="agent-artifact-header-icon-box" id="agent-artifact-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="3" cy="6" r="2"/><circle cx="3" cy="18" r="2"/><circle cx="21" cy="6" r="2"/><circle cx="21" cy="18" r="2"/><path d="M5 6h4l3 6-3 6H5"/><path d="M19 6h-4l-3 6 3 6h4"/></svg>
                    </div>
                    <div class="agent-artifact-header-text">
                        <div class="agent-artifact-title-row">
                            <h3 id="agent-artifact-title">结果版本</h3>
                            <span class="agent-artifact-badge" id="agent-artifact-type-badge">思维导图</span>
                        </div>
                        <p class="agent-artifact-header-desc" id="agent-artifact-desc"></p>
                    </div>
                </div>

                <div class="agent-artifact-nav-tabs" role="tablist">
                    <button type="button" class="agent-artifact-tab active" data-tab="studio">
                        <span id="agent-artifact-tab-studio-label">导图工作台</span>
                    </button>
                    <button type="button" class="agent-artifact-tab" data-tab="versions">
                        <span>历史版本</span>
                        <span class="agent-artifact-tab-badge" id="agent-artifact-versions-count">0</span>
                    </button>
                    <button type="button" class="agent-artifact-tab" data-tab="renditions">
                        <span>渲染产物</span>
                        <span class="agent-artifact-tab-badge" id="agent-artifact-renditions-count">0</span>
                    </button>
                    <button type="button" class="agent-artifact-tab" data-tab="annotations">
                        <span>修订批注</span>
                        <span class="agent-artifact-tab-badge" id="agent-artifact-annotations-count">0</span>
                    </button>
                </div>

                <div class="agent-artifact-header-actions">
                    <button type="button" id="agent-artifact-close-btn" class="workspace-modal-close agent-modal-close agent-artifact-close-btn" aria-label="关闭" title="关闭 (Esc)">
                        关闭
                    </button>
                </div>
            </div>

            <div class="agent-artifact-modal-body">
                <!-- Tab 1: Studio / Content Editor -->
                <div class="agent-artifact-tab-pane active" id="pane-studio">
                    <div class="agent-artifact-editor">
                        <div class="agent-artifact-standard-form">
                            <div class="agent-artifact-form-group">
                                <label for="agent-artifact-note">版本备注</label>
                                <input id="agent-artifact-note" class="form-input" placeholder="说明本次修改、回滚或校订原因">
                            </div>
                            <div class="agent-artifact-form-group flex-1">
                                <label for="agent-artifact-content">当前内容</label>
                                <textarea id="agent-artifact-content" class="form-input agent-artifact-content"></textarea>
                            </div>
                            <div class="agent-artifact-form-actions">
                                <button type="button" id="agent-artifact-save-version" class="btn-primary">保存新版本</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Tab 2: Version History & Comparison -->
                <div class="agent-artifact-tab-pane" id="pane-versions">
                    <div class="agent-artifact-pane-split">
                        <div class="agent-artifact-pane-sidebar">
                            <div class="pane-section-header">
                                <strong>版本演进历史</strong>
                                <span class="text-muted">选择版本可对比或回滚</span>
                            </div>
                            <div id="agent-artifact-version-list" class="agent-artifact-version-list"></div>
                        </div>
                        <div class="agent-artifact-pane-main">
                            <div class="pane-section-header">
                                <strong>版本差异对比 (Diff)</strong>
                            </div>
                            <div id="agent-artifact-diff" class="agent-artifact-diff"></div>
                        </div>
                    </div>
                </div>

                <!-- Tab 3: Rendition Deliveries (Data Table) -->
                <div class="agent-artifact-tab-pane" id="pane-renditions">
                    <div class="agent-artifact-pane-scroll">
                        <div class="pane-section-header">
                            <strong>已渲染文档与交付产物</strong>
                            <span class="text-muted">由系统或 Agent 生成的各格式最终产物，支持下载与保存到本机</span>
                        </div>
                        <div id="agent-artifact-rendition-list" class="agent-artifact-rendition-table-wrap"></div>
                    </div>
                </div>

                <!-- Tab 4: Annotations & Proofreading -->
                <div class="agent-artifact-tab-pane" id="pane-annotations">
                    <div class="agent-artifact-pane-scroll">
                        <div class="pane-section-header">
                            <strong>修改与校订批注</strong>
                            <span class="text-muted">对产物具体节点或段落记录修改建议与核对状态</span>
                        </div>
                        <div class="agent-artifact-annotation-form">
                            <div class="agent-artifact-form-field">
                                <label for="agent-artifact-annotation-target" class="form-label">批注目标位置</label>
                                <input id="agent-artifact-annotation-target" class="form-input" maxlength="500" placeholder="例如：分支一 / 第 2 节点">
                            </div>
                            <div class="agent-artifact-form-field">
                                <label for="agent-artifact-annotation-note" class="form-label">修订批注意见</label>
                                <textarea id="agent-artifact-annotation-note" class="form-input" rows="3" maxlength="4000" placeholder="详细说明要修改、校对或补充的具体内容..."></textarea>
                            </div>
                            <div class="agent-artifact-form-actions">
                                <button type="button" id="agent-artifact-annotation-add" class="btn-primary">添加批注</button>
                            </div>
                        </div>
                        <div class="pane-section-subtitle">
                            <strong>批注记录列表</strong>
                        </div>
                        <div id="agent-artifact-annotation-list" class="agent-artifact-version-list"></div>
                    </div>
                </div>
            </div>
        </div>
    `);
    document.body.appendChild(modal);

    // Tab switching
    modal.querySelectorAll('.agent-artifact-tab').forEach(tabBtn => {
        tabBtn.addEventListener('click', () => {
            const tab = tabBtn.dataset.tab;
            modal.querySelectorAll('.agent-artifact-tab').forEach(b => b.classList.toggle('active', b === tabBtn));
            modal.querySelectorAll('.agent-artifact-tab-pane').forEach(p => {
                p.classList.toggle('active', p.id === `pane-${tab}`);
            });
        });
    });

    // Close on button or backdrop click
    modal.addEventListener('click', event => {
        if (event.target.closest('#agent-artifact-close-btn') || event.target === modal) {
            modal.classList.add('hidden');
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
            modal.classList.add('hidden');
        }
    });

    return modal;
}

async function loadAgentArtifactAnnotations(modal, artifactId) {
    const list = modal.querySelector('#agent-artifact-annotation-list');
    if (!list) return;
    const response = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/annotations`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        PivotSafeHtml.setHtml(list, '<div class="empty-state compact">批注加载失败</div>');
        return;
    }
    const annotations = Array.isArray(data.annotations) ? data.annotations : [];
    const countBadge = modal.querySelector('#agent-artifact-annotations-count');
    if (countBadge) countBadge.textContent = String(annotations.length);

    PivotSafeHtml.setHtml(list, annotations.map(item => `
        <div class="agent-artifact-version ${item.status === 'resolved' ? 'resolved' : ''}">
            <div><strong>${agentEscape(item.target?.location || item.target?.sheet || item.target?.selector || '指定位置')}</strong><span>${agentEscape(item.note || '')}</span><small>${agentEscape(item.status === 'resolved' ? '已处理' : '待处理')}</small></div>
            <div class="agent-artifact-version-actions">${item.status === 'open' ? `<button type="button" class="btn-secondary" data-artifact-annotation-resolve="${agentEscape(item.id)}">标记已处理</button>` : ''}</div>
        </div>
    `).join('') || '<div class="empty-state compact">暂无修改批注。</div>');
    list.querySelectorAll('[data-artifact-annotation-resolve]').forEach(button => {
        button.addEventListener('click', async () => {
            const res = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/annotations/${encodeURIComponent(button.dataset.artifactAnnotationResolve)}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved' })
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) return showToast(d.error || '更新批注失败', 'error');
            await loadAgentArtifactAnnotations(modal, artifactId);
        });
    });
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
    const shared = window.Pivot.moduleApi('chat.codeDelivery').downloadRendition;
    if (typeof shared === 'function') {
        try { return await shared(rendition); } catch (error) { return showToast(error.message || '下载结果文件失败', 'error'); }
    }
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
    const sharedQueue = window.Pivot.moduleApi('chat.codeDelivery').queueRenditionToDesktop;
    if (typeof sharedQueue === 'function') return sharedQueue(rendition, `产物-${rendition.id}`);
    return showToast('本机交付模块尚未加载，请刷新页面后重试。', 'error');
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
    const countBadge = modal.querySelector('#agent-artifact-renditions-count');
    if (countBadge) countBadge.textContent = String(renditions.length);

    if (renditions.length === 0) {
        PivotSafeHtml.setHtml(list, '<div class="empty-state compact">暂无已渲染文档。请由 Agent 使用 artifact.render 生成，或在公文工作台直接导出。</div>');
        return;
    }

    PivotSafeHtml.setHtml(list, `
        <table class="agent-artifact-data-table">
            <thead>
                <tr>
                    <th class="artifact-col-index" style="width: 68px; text-align: left;">序号</th>
                    <th class="artifact-col-format" style="width: 120px; text-align: left;">产物格式</th>
                    <th class="artifact-col-size" style="width: 140px; text-align: left;">文件大小</th>
                    <th class="artifact-col-digest" style="text-align: left;">内容指纹</th>
                    <th class="artifact-col-actions" style="width: 190px; text-align: left;">操作</th>
                </tr>
            </thead>
            <tbody>
                ${renditions.map((item, index) => `
                    <tr>
                        <td class="artifact-index-cell" style="text-align: left;">${index + 1}</td>
                        <td class="artifact-format-cell" style="text-align: left;">
                            <span class="artifact-format-badge format-${agentEscape(String(item.format || '').toLowerCase())}">
                                ${agentEscape(String(item.format || '').toUpperCase())}
                            </span>
                        </td>
                        <td class="artifact-size-cell" style="text-align: left;">${Number(item.byte_size || 0).toLocaleString()} 字节</td>
                        <td class="artifact-digest-cell" style="text-align: left;">
                            <code class="artifact-digest-code" title="${agentEscape(String(item.content_digest || ''))}">${agentEscape(String(item.content_digest || '-'))}</code>
                        </td>
                        <td class="artifact-actions-cell" style="text-align: left;">
                            <button type="button" class="btn-secondary btn-xs" data-artifact-rendition-download="${agentEscape(item.id)}">下载</button>
                            <button type="button" class="btn-secondary btn-xs" data-artifact-rendition-local="${agentEscape(item.id)}">保存到本机</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `);
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
    const isMindmap = artifact.type === 'mindmap';
    if (isMindmap && window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench) {
        modal.classList.add('hidden');
        return window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench({ app: 'mindmaps', artifactId });
    }

    modal.dataset.artifactType = artifact.type || 'summary';
    const innerModal = modal.querySelector('.agent-artifact-modal');
    if (innerModal) innerModal.dataset.artifactType = artifact.type || 'summary';

    modal.querySelector('#agent-artifact-title').textContent = artifact.title || (isMindmap ? '未命名思维导图' : '结果版本');
    const badge = modal.querySelector('#agent-artifact-type-badge');
    if (badge) badge.textContent = isMindmap ? '思维导图' : (artifact.type === 'official_writing' ? '公文' : '产物');
    const tabStudioLabel = modal.querySelector('#agent-artifact-tab-studio-label');
    if (tabStudioLabel) tabStudioLabel.textContent = isMindmap ? '导图工作台' : '内容编辑';

    const icon = modal.querySelector('#agent-artifact-icon');
    if (icon) {
        PivotSafeHtml.setHtml(icon, isMindmap
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="3" cy="6" r="2"/><circle cx="3" cy="18" r="2"/><circle cx="21" cy="6" r="2"/><circle cx="21" cy="18" r="2"/><path d="M5 6h4l3 6-3 6H5"/><path d="M19 6h-4l-3 6 3 6h4"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></svg>');
    }
    modal.querySelector('#agent-artifact-desc').textContent = `${versions.length} 个版本 · 当前版本 ${artifact.current_version || 1}`;
    modal.querySelector('#agent-artifact-content').value = artifact.content || '';
    
    // Mount editor into #pane-studio .agent-artifact-editor
    window.Pivot.moduleApi('chat.mindmapEditor')?.mount(modal.querySelector('#pane-studio .agent-artifact-editor') || modal.querySelector('.agent-artifact-editor') || modal, artifact);

    // Reset tab to studio
    modal.querySelectorAll('.agent-artifact-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'studio'));
    modal.querySelectorAll('.agent-artifact-tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-studio'));

    const versionsCount = modal.querySelector('#agent-artifact-versions-count');
    if (versionsCount) versionsCount.textContent = String(versions.length);

    modal.querySelector('#agent-artifact-note').value = '';
    PivotSafeHtml.setHtml(modal.querySelector('#agent-artifact-diff'), '');
    void loadAgentArtifactRenditions(modal, artifactId);
    void loadAgentArtifactAnnotations(modal, artifactId);
    modal.querySelector('#agent-artifact-annotation-target').value = '';
    modal.querySelector('#agent-artifact-annotation-note').value = '';
    modal.querySelector('#agent-artifact-annotation-add').onclick = async () => {
        const location = modal.querySelector('#agent-artifact-annotation-target').value;
        const note = modal.querySelector('#agent-artifact-annotation-note').value;
        const response = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/annotations`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, note })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showToast(data.error || '添加批注失败', 'error');
        modal.querySelector('#agent-artifact-annotation-target').value = '';
        modal.querySelector('#agent-artifact-annotation-note').value = '';
        await loadAgentArtifactAnnotations(modal, artifactId);
        showToast('批注已添加', 'success');
    };
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
                <div class="diff-header-title">版本 ${to - 1} → 版本 ${to}</div>
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
