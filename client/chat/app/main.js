const { writeTextToClipboard } = window.Pivot.legacy.chatDialogHelpers || {};

const copyMsg = async (btn) => {
    try {
        const body = btn.closest('.message-content')?.querySelector('.text-body');
        if (!body) throw new Error('未找到消息正文');
        const temp = body.cloneNode(true);
        temp.querySelectorAll('.code-toolbar, .thought-summary').forEach(el => el.remove());
        const text = temp.innerText.trim();
        if (!text) return showToast('没有可复制的内容', 'warning');
        await writeTextToClipboard(text);
        showToast('内容已复制');
    } catch (e) {
        console.error('复制消息失败:', e);
        showToast('复制失败，请手动选择内容复制', 'error');
    }
};

const deleteMsg = (id, btn) => {
    window.Pivot.legacy.showConfirm('删除消息', '确定要删除这条消息吗？', async () => {
        const res = await apiFetch(`${API_BASE}/messages/${id}`, { method: 'DELETE' });
        if (res.ok) { btn.closest('.message').remove(); showToast('消息已删除'); }
    });
};

const deleteSession = (id) => {
    window.Pivot.legacy.showConfirm('删除会话', '确定要删除整个会话吗？', async () => {
        const res = await apiFetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' });
        if (res.ok) {
            if (currentSessionId === id) {
                currentSessionId = null;
                window.Pivot.legacy.persistActiveChatSession?.('');
                document.getElementById('current-title').innerText = '请选择或新建对话';
                PivotSafeHtml.setHtml(document.getElementById('message-container'), '');
            }
            window.Pivot.legacy.loadSessions();
            showToast('会话已删除');
        }
    });
};

const regenerateMsg = async (id) => {
    const res = await apiFetch(`${API_BASE}/messages/${id}`, { method: 'DELETE' });
    if (res.ok) {
        PivotSafeHtml.setHtml(document.getElementById('message-container'), '');
        await selectSession(currentSessionId);
        window.Pivot.legacy.sendMessage(true);
    } else {
        showToast('请求失败，请稍后重试', 'error');
    }
};

const forkSessionFromMessage = async (messageId) => {
    if (!currentSessionId) return showToast('请先选择会话', 'error');
    const title = await window.Pivot.legacy.showInputPrompt({
        title: '分叉会话',
        message: '新会话会保留这条消息之前的上下文，可继续探索另一条路线。',
        placeholder: '分支标题',
        value: `分支：${document.getElementById('current-title')?.innerText || '新会话'}`,
        required: false
    });
    if (title === null) return;
    const res = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(currentSessionId)}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, title })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '会话分叉失败', 'error');
    await window.Pivot.legacy.loadSessions?.();
    await selectSession(data.session.id, data.session.title, { refreshSidebar: true });
    showToast(`已创建分支，复制 ${data.copiedMessages || 0} 条上下文`, 'success');
};

const exportSession = async (id) => {
    showToast('正在导出...', 'info');
    try {
        const res = await apiFetch(`${API_BASE}/sessions/${id}/export`, {
            headers: authHeaders()
        });
        if (res.ok) {
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chat_${id.slice(0, 8)}.md`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
            showToast('导出成功', 'success');
        } else {
            showToast('导出失败', 'error');
        }
    } catch (e) {
        showToast('请求失败', 'error');
    }
};

// 打开打印 / 导出 PDF 工作区：在主工作区内通过 iframe 加载嵌入视图，不再弹新标签
// 服务端使用 cookie 鉴权，iframe 同源加载会自动携带身份信息
const printSession = (id) => {
    if (!id) return;
    window.Pivot.legacy.openPrintWorkbench?.(id);
};

// --- 会话操作弹窗 ---
let renamingSessionId = null;
let editingTagsId = null;

const renameSession = (id, oldTitle) => {
    renamingSessionId = id;
    document.getElementById('new-session-title').value = oldTitle;
    document.getElementById('rename-container').classList.remove('hidden');
};
const closeRenameModal = () => document.getElementById('rename-container').classList.add('hidden');
const saveSessionTitle = async () => {
    const title = document.getElementById('new-session-title').value;
    const res = await apiFetch(`${API_BASE}/sessions/${renamingSessionId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    if (res.ok) { if (currentSessionId === renamingSessionId) document.getElementById('current-title').innerText = title; window.Pivot.legacy.loadSessions(); closeRenameModal(); }
};

// --- 标签管理 ---
const editSessionTags = (id, tags) => {
    editingTagsId = id;
    document.getElementById('session-tags-input').value = tags;
    document.getElementById('tags-container').classList.remove('hidden');
};
const closeTagsModal = () => document.getElementById('tags-container').classList.add('hidden');
const saveSessionTags = async () => {
    const tags = document.getElementById('session-tags-input').value;
    const res = await apiFetch(`${API_BASE}/sessions/${editingTagsId}/tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }) });
    if (res.ok) { window.Pivot.legacy.loadSessions(); closeTagsModal(); showToast('标签已保存'); }
};

window.Pivot?.exposeModule?.('chat.sessionActions', {
    copyMsg,
    deleteMsg,
    deleteSession,
    regenerateMsg,
    forkSessionFromMessage,
    exportSession,
    printSession,
    renameSession,
    closeRenameModal,
    saveSessionTitle,
    editSessionTags,
    closeTagsModal,
    saveSessionTags
}, [
    'copyMsg',
    'deleteMsg',
    'deleteSession',
    'regenerateMsg',
    'forkSessionFromMessage',
    'exportSession',
    'printSession',
    'renameSession',
    'closeRenameModal',
    'saveSessionTitle',
    'editSessionTags',
    'closeTagsModal',
    'saveSessionTags'
]);

// --- 事件绑定 (集中管理以增强 CSP 安全性) ---
const bind = (id, fn, event = 'click') => document.getElementById(id)?.addEventListener(event, fn);

const sidebarViewportMedia = window.matchMedia('(max-width: 720px)');
const syncSidebarForViewport = (media = sidebarViewportMedia) => {
    document.querySelector('.sidebar')?.classList.toggle('collapsed', media.matches);
};
syncSidebarForViewport();
sidebarViewportMedia.addEventListener?.('change', syncSidebarForViewport);

// 会话管理
bind('new-chat-btn', async () => {
    window.Pivot.legacy.showMainWorkspace('chat');
    const s = await createSession('新对话');
    if (s) selectSession(s.id, s.title, { refreshSidebar: true });
});
bind('send-btn', () => window.Pivot.legacy.sendMessage());
bind('stop-btn', () => window.Pivot.legacy.cancelCurrentChatAgent?.() || currentAbortController?.abort());
bind('upload-btn', () => {
    const modelId = document.getElementById('model-selector').value;
    const model = (window.Pivot.legacy._cachedModels || []).find(m => String(m.id) === String(modelId));
    if (!model || Number(model.supports_vision || 0) !== 1) {
        return showToast('当前选中的模型不具备视觉或文档分析能力', 'error');
    }
    const panel = document.getElementById('upload-choice-panel');
    const button = document.getElementById('upload-btn');
    if (!panel || !button) return document.getElementById('file-input')?.click();
    const shouldOpen = panel.hidden;
    document.querySelectorAll('#chat-tools-menu-panel .chat-tool-subpanel').forEach(subpanel => { subpanel.hidden = true; });
    document.querySelectorAll('#chat-tools-menu-panel [aria-expanded="true"]').forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
    panel.hidden = !shouldOpen;
    button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
});
bind('upload-file-choice', () => {
    window.Pivot.modules['chat.inputMenu']?.setOpen?.(false);
    document.getElementById('file-input')?.click();
});
bind('upload-folder-choice', () => {
    window.Pivot.modules['chat.inputMenu']?.setOpen?.(false);
    document.getElementById('folder-input')?.click();
});
bind('context-usage-pill', () => window.Pivot.legacy.compactCurrentSessionContext?.());
bind('sidebar-toggle-btn', () => window.Pivot.legacy.toggleSidebar());
bind('sidebar-mobile-close-btn', () => document.querySelector('.sidebar')?.classList.add('collapsed'));
bind('session-active-filter', () => window.Pivot.legacy.setArchiveFilter(false));
bind('session-archive-filter', () => window.Pivot.legacy.setArchiveFilter(true));

// 会话弹窗
bind('modal-rename-cancel', () => window.Pivot.legacy.closeRenameModal());
bind('modal-rename-save', () => window.Pivot.legacy.saveSessionTitle());
bind('modal-tags-cancel', () => window.Pivot.legacy.closeTagsModal());
bind('modal-tags-save', () => window.Pivot.legacy.saveSessionTags());
bind('report-query-btn', () => window.Pivot.legacy.loadReport());
bind('report-days', () => window.Pivot.legacy.syncReportDateFilters?.(), 'change');
bind('api-call-log-search', () => {
    clearTimeout(window.Pivot.legacy.apiCallLogSearchTimer);
    window.Pivot.legacy.apiCallLogSearchTimer = setTimeout(() => window.Pivot.legacy.loadApiCallLogs?.(1), 300);
}, 'input');
bind('api-call-logs-open-btn', () => window.Pivot.legacy.openApiCallLogsModal?.());
bind('create-key-btn', () => window.Pivot.legacy.createApiKey());
bind('pw-update-btn', () => window.Pivot.legacy.updatePassword());

// 管理面板切换
['ops', 'models', 'global-params', 'tool-policy', 'memories', 'attachments', 'announcements', 'users', 'logs', 'monitor', 'usage', 'keys', 'account'].forEach(tab => {
    bind(`tab-${tab}`, () => window.Pivot.legacy.switchTab(tab));
});
document.querySelectorAll('[data-usage-subtab]').forEach(button => {
    button.addEventListener('click', () => window.Pivot?.modules['settings.usage']?.switchSubtab?.(button.dataset.usageSubtab));
});
bind('admin-modal-close', () => window.Pivot.legacy.closeModal());
bind('apps-workbench-btn', () => window.Pivot.legacy.openAppsWorkbench?.());
bind('admin-panel-btn', () => window.Pivot.legacy.openAdminPanel());
bind('automation-workbench-btn', () => window.Pivot.legacy.openAgentWorkbench?.());
bind('agent-modal-close', () => window.Pivot.legacy.closeAgentWorkbench?.());
bind('knowledge-workbench-btn', () => window.Pivot.legacy.openKnowledgeWorkbench?.());
bind('knowledge-modal-close', () => window.Pivot.legacy.closeKnowledgeWorkbench?.());
bind('mcp-workbench-btn', () => window.Pivot.legacy.openMcpWorkbench?.());
bind('mcp-modal-close', () => window.Pivot.legacy.closeMcpWorkbench?.());
bind('manual-link-btn', () => window.Pivot.legacy.openManualWorkbench?.());
bind('manual-modal-close', () => window.Pivot.legacy.closeManualWorkbench?.());
bind('print-modal-close', () => window.Pivot.legacy.closePrintWorkbench?.());
bind('logout-btn', () => window.Pivot.legacy.logout());

document.addEventListener('click', async (event) => {
    const authToggle = event.target.closest('[data-auth-password-toggle]');
    if (authToggle) {
        window.Pivot.legacy.toggleAuthPassword?.(authToggle.dataset.inputId, authToggle.dataset.iconId);
        return;
    }

    const actionButton = event.target.closest('[data-static-action]');
    if (!actionButton) return;

    const actions = {
        'toggle-model-key': () => window.Pivot.legacy.toggleKeyVisibility?.(),
        'fetch-remote-models': () => window.Pivot.legacy.fetchRemoteModels?.(),
        'close-user-records': () => window.Pivot.legacy.closeUserRecordsModal?.(),
        'query-logs': () => window.Pivot.legacy.loadLogs?.(1),
        'reset-logs': () => window.Pivot.legacy.resetLogFilters?.(),
        'open-monitor-routes': () => window.Pivot.legacy.openMonitorRoutesModal?.(),
        'reset-report': () => window.Pivot.legacy.resetReportFilters?.(),
        'close-api-call-logs': () => window.Pivot.legacy.closeApiCallLogsModal?.(),
        'close-key-modal': () => window.Pivot.legacy.closeKeyModal?.(),
        'confirm-create-key': () => window.Pivot.legacy.confirmCreateKey?.(),
        'copy-generated-key': () => window.Pivot.legacy.copyGeneratedKey?.(),
        'close-monitor-routes': () => window.Pivot.legacy.closeMonitorRoutesModal?.()
    };
    await actions[actionButton.dataset.staticAction]?.();
});

// 管理操作
bind('ops-refresh-btn', () => window.Pivot.legacy.loadOpsSummary());
bind('monitor-refresh-btn', () => window.Pivot.legacy.loadMonitorSummary());
bind('monitor-auto-refresh', () => window.Pivot.legacy.loadMonitorSummary(), 'change');
bind('observability-webhook-save', () => window.Pivot.legacy.saveObservabilityWebhook?.());
bind('rag-embedding-save-btn', () => window.Pivot.legacy.saveEmbeddingSettings());
bind('model-add-btn', () => window.Pivot.legacy.openModelModal());
bind('modal-model-cancel', () => window.Pivot.legacy.closeModelModal());
bind('modal-model-test', () => window.Pivot.legacy.testModelConfig());
bind('m-submit-btn', () => window.Pivot.legacy.addModel());
bind('m-scope', () => window.Pivot.legacy.updateModelScopeControls?.(), 'change');
bind('agent-refresh-btn', () => window.Pivot.legacy.loadAgentWorkbench?.());
bind('task-create-open-btn', () => window.Pivot.legacy.setTaskComposerOpen?.(true));
bind('task-create-close-btn', () => window.Pivot.legacy.setTaskComposerOpen?.(false));
bind('task-create-cancel-btn', () => window.Pivot.legacy.setTaskComposerOpen?.(false));
bind('agent-run-btn', () => window.Pivot.legacy.createAgentRun?.());
bind('agent-audit-btn', () => window.Pivot.legacy.showAgentRunAudit?.());
window.Pivot.legacy.bindAgentGoalTemplates?.();
window.Pivot.legacy.bindAgentFilters?.();
bind('mcp-refresh-btn', () => window.Pivot.legacy.loadMcpWorkbench?.());
bind('mcp-save-btn', () => window.Pivot.legacy.saveMcpServer?.());
bind('mcp-reset-btn', () => window.Pivot.legacy.resetMcpForm?.());
bind('mcp-edit-cancel-btn', () => window.Pivot.legacy.closeMcpEditModal?.());
bind('mcp-edit-save-btn', () => window.Pivot.legacy.saveMcpServer?.('edit'));

// 知识库管理
bind('rag-upload-btn', () => window.Pivot.legacy.openKnowledgeUploadModal?.());
bind('rag-upload-input', () => window.Pivot.legacy.addKnowledgeUploadFiles?.(), 'change');

// 用户管理
bind('user-add-btn', () => window.Pivot.legacy.openUserModal());
bind('modal-user-cancel', () => window.Pivot.legacy.closeUserModal());
bind('modal-user-save', () => window.Pivot.legacy.saveUser());
bind('user-template-btn', () => window.Pivot.legacy.downloadUserTemplate());
bind('user-import-btn', () => document.getElementById('user-import-input').click());
bind('user-import-input', () => window.Pivot.legacy.importUsers(), 'change');
bind('user-export-btn', () => window.Pivot.legacy.exportUsers());
bind('public-registration-toggle', () => window.Pivot.legacy.updatePublicRegistrationSetting?.(), 'change');
bind('api-access-toggle', () => window.Pivot.legacy.updateApiAccessSetting?.(), 'change');

// 审计与导出
bind('logs-export-btn', () => window.Pivot.legacy.exportLogs());
bind('report-export-btn', () => window.Pivot.legacy.exportReport?.());
bind('stats-export-btn', () => window.Pivot.legacy.exportStats());
bind('model-cost-export-btn', () => window.Pivot.legacy.exportModelCosts?.());
bind('compliance-export-btn', () => window.Pivot.legacy.exportCompliancePackage?.());
bind('details-export-btn', () => window.Pivot.legacy.exportDetails());

// 其他
bind('image-viewer-modal', () => window.Pivot.legacy.closeImageViewer());

// --- 搜索防抖 ---
let searchTimer = null;
document.getElementById('session-search-input')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => window.Pivot.legacy.loadSessions(), 300);
});
document.getElementById('session-tag-filter')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => window.Pivot.legacy.loadSessions(), 300);
});

// --- 初始化 ---
if (typeof checkLogin === 'function') checkLogin();
window.Pivot.legacy.resizeUserInput();
