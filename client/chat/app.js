let confirmCallback = null;
let confirmResolve = null;
window.showConfirm = (title, message, callback) => {
    const container = document.getElementById('confirm-container');
    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    if (!container || !titleEl || !messageEl) return Promise.resolve(false);
    if (confirmResolve) confirmResolve(false);
    titleEl.innerText = title;
    messageEl.innerText = message;
    confirmCallback = typeof callback === 'function' ? callback : null;
    container.classList.remove('hidden');
    return new Promise(resolve => {
        confirmResolve = resolve;
    });
};
window.closeConfirmModal = (confirmed = false) => {
    document.getElementById('confirm-container')?.classList.add('hidden');
    const resolve = confirmResolve;
    confirmCallback = null;
    confirmResolve = null;
    if (resolve) resolve(confirmed);
};
document.getElementById('confirm-ok-btn')?.addEventListener('click', () => {
    const callback = confirmCallback;
    if (callback) callback();
    window.closeConfirmModal(true);
});
document.getElementById('modal-confirm-cancel')?.addEventListener('click', () => window.closeConfirmModal(false));

// --- 消息操作 ---
let inputPromptResolve = null;
let inputPromptOptions = {};

function resetInputPromptError() {
    const errorEl = document.getElementById('input-prompt-error');
    if (!errorEl) return;
    errorEl.innerText = '';
    errorEl.classList.add('hidden');
}

function closeInputPrompt(value = null) {
    document.getElementById('input-prompt-container')?.classList.add('hidden');
    const resolve = inputPromptResolve;
    inputPromptResolve = null;
    inputPromptOptions = {};
    if (resolve) resolve(value);
}

window.showInputPrompt = function(options = {}) {
    const container = document.getElementById('input-prompt-container');
    const titleEl = document.getElementById('input-prompt-title');
    const messageEl = document.getElementById('input-prompt-message');
    const field = document.getElementById('input-prompt-field');
    if (!container || !titleEl || !messageEl || !field) return Promise.resolve(null);

    if (inputPromptResolve) closeInputPrompt(null);
    inputPromptOptions = options;
    titleEl.innerText = options.title || '输入';
    messageEl.innerText = options.message || '';
    field.type = options.type || 'text';
    field.value = options.value || '';
    field.placeholder = options.placeholder || '';
    field.autocomplete = options.autocomplete || 'off';
    resetInputPromptError();
    container.classList.remove('hidden');
    setTimeout(() => field.focus(), 0);

    return new Promise(resolve => {
        inputPromptResolve = resolve;
    });
};

function submitInputPrompt() {
    const field = document.getElementById('input-prompt-field');
    const errorEl = document.getElementById('input-prompt-error');
    if (!field || !errorEl) return closeInputPrompt(null);
    const value = field.value;
    const trimmed = value.trim();
    if (inputPromptOptions.required !== false && !trimmed) {
        errorEl.innerText = inputPromptOptions.requiredMessage || '请输入内容';
        errorEl.classList.remove('hidden');
        field.focus();
        return;
    }
    closeInputPrompt(inputPromptOptions.trim === false ? value : trimmed);
}

document.getElementById('modal-input-prompt-ok')?.addEventListener('click', submitInputPrompt);
document.getElementById('modal-input-prompt-cancel')?.addEventListener('click', () => closeInputPrompt(null));
document.getElementById('input-prompt-field')?.addEventListener('input', resetInputPromptError);
document.getElementById('input-prompt-field')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        submitInputPrompt();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeInputPrompt(null);
    }
});

async function writeTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const success = document.execCommand('copy');
    textArea.remove();
    if (!success) throw new Error('execCommand copy failed');
}

window.copyMsg = async (btn) => {
    try {
        const body = btn.closest('.message-content')?.querySelector('.text-body');
        if (!body) throw new Error('Message body not found');
        const temp = body.cloneNode(true);
        temp.querySelectorAll('.code-toolbar, .thought-summary').forEach(el => el.remove());
        const text = temp.innerText.trim();
        if (!text) return showToast('没有可复制的内容', 'warning');
        await writeTextToClipboard(text);
        showToast('内容已复制');
    } catch (e) {
        console.error('Copy message failed:', e);
        showToast('复制失败，请手动选择内容复制', 'error');
    }
};

window.deleteMsg = (id, btn) => {
    showConfirm('删除消息', '确定要删除这条消息吗？', async () => {
        const res = await apiFetch(`${API_BASE}/messages/${id}`, { method: 'DELETE' });
        if (res.ok) { btn.closest('.message').remove(); showToast('消息已删除'); }
    });
};

window.deleteSession = (id) => {
    showConfirm('删除会话', '确定要删除整个会话吗？', async () => {
        const res = await apiFetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' });
        if (res.ok) {
            if (currentSessionId === id) {
                currentSessionId = null;
                window.persistActiveChatSession?.('');
                document.getElementById('current-title').innerText = '请选择或新建对话';
                document.getElementById('message-container').innerHTML = '';
            }
            window.loadSessions();
            showToast('会话已删除');
        }
    });
};

window.regenerateMsg = async (id) => {
    const res = await apiFetch(`${API_BASE}/messages/${id}`, { method: 'DELETE' });
    if (res.ok) {
        document.getElementById('message-container').innerHTML = '';
        await selectSession(currentSessionId);
        window.sendMessage(true);
    } else {
        showToast('请求失败，请稍后重试', 'error');
    }
};

window.forkSessionFromMessage = async (messageId) => {
    if (!currentSessionId) return showToast('请先选择会话', 'error');
    const title = await window.showInputPrompt({
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
    await window.loadSessions?.();
    await selectSession(data.session.id, data.session.title, { refreshSidebar: true });
    showToast(`已创建分支，复制 ${data.copiedMessages || 0} 条上下文`, 'success');
};

window.exportSession = async (id) => {
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
window.printSession = (id) => {
    if (!id) return;
    window.openPrintWorkbench?.(id);
};

// --- 会话操作弹窗 ---
window.renameSession = (id, oldTitle) => {
    window.renamingSessionId = id;
    document.getElementById('new-session-title').value = oldTitle;
    document.getElementById('rename-container').classList.remove('hidden');
};
window.closeRenameModal = () => document.getElementById('rename-container').classList.add('hidden');
window.saveSessionTitle = async () => {
    const title = document.getElementById('new-session-title').value;
    const res = await apiFetch(`${API_BASE}/sessions/${window.renamingSessionId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    if (res.ok) { if (currentSessionId === window.renamingSessionId) document.getElementById('current-title').innerText = title; window.loadSessions(); window.closeRenameModal(); }
};

// --- 标签管理 ---
window.editSessionTags = (id, tags) => {
    window.editingTagsId = id;
    document.getElementById('session-tags-input').value = tags;
    document.getElementById('tags-container').classList.remove('hidden');
};
window.closeTagsModal = () => document.getElementById('tags-container').classList.add('hidden');
window.saveSessionTags = async () => {
    const tags = document.getElementById('session-tags-input').value;
    const res = await apiFetch(`${API_BASE}/sessions/${window.editingTagsId}/tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }) });
    if (res.ok) { window.loadSessions(); window.closeTagsModal(); showToast('标签已保存'); }
};

// --- 事件绑定 (集中管理以增强 CSP 安全性) ---
const bind = (id, fn, event = 'click') => document.getElementById(id)?.addEventListener(event, fn);

// 会话管理
bind('new-chat-btn', async () => {
    window.showMainWorkspace('chat');
    const s = await createSession('新对话');
    if (s) selectSession(s.id, s.title, { refreshSidebar: true });
});
bind('send-btn', () => sendMessage());
bind('stop-btn', () => { currentAbortController?.abort(); });
bind('upload-btn', () => {
    const modelId = document.getElementById('model-selector').value;
    const model = (window._cachedModels || []).find(m => String(m.id) === String(modelId));
    if (!model || Number(model.supports_vision || 0) !== 1) {
        return showToast('当前选中的模型不具备视觉或文档分析能力', 'error');
    }
    document.getElementById('file-input').click();
});
bind('clear-input-btn', () => {
    if (userInput) {
        userInput.value = '';
        window.resizeUserInput();
        userInput.focus();
    }
});
bind('chat-prompt-library-btn', async () => {
    await window.ensureAdminFeatureScripts?.();
    window.openPromptLibrary?.('chat');
});
bind('context-usage-pill', () => window.compactCurrentSessionContext?.());
bind('sidebar-toggle-btn', () => window.toggleSidebar());
bind('session-active-filter', () => window.setArchiveFilter(false));
bind('session-archive-filter', () => window.setArchiveFilter(true));

// 会话弹窗
bind('modal-rename-cancel', () => window.closeRenameModal());
bind('modal-rename-save', () => window.saveSessionTitle());
bind('modal-tags-cancel', () => window.closeTagsModal());
bind('modal-tags-save', () => window.saveSessionTags());
bind('report-query-btn', () => window.loadReport());
bind('report-days', () => window.syncReportDateFilters?.(), 'change');
bind('api-call-log-search', () => {
    clearTimeout(window.apiCallLogSearchTimer);
    window.apiCallLogSearchTimer = setTimeout(() => window.loadApiCallLogs?.(1), 300);
}, 'input');
bind('api-call-logs-open-btn', () => window.openApiCallLogsModal?.());
bind('create-key-btn', () => window.createApiKey());
bind('pw-update-btn', () => window.updatePassword());

// 管理面板切换
['ops', 'models', 'tool-policy', 'prompts', 'attachments', 'announcements', 'users', 'logs', 'monitor', 'report', 'stats', 'keys', 'details', 'account'].forEach(tab => {
    bind(`tab-${tab}`, () => window.switchTab(tab));
});
bind('admin-modal-close', () => window.closeModal());
bind('apps-workbench-btn', () => window.openAppsWorkbench?.());
bind('admin-panel-btn', () => window.openAdminPanel());
bind('agent-workbench-btn', () => window.openAgentWorkbench?.());
bind('agent-modal-close', () => window.closeAgentWorkbench?.());
bind('knowledge-workbench-btn', () => window.openKnowledgeWorkbench?.());
bind('knowledge-modal-close', () => window.closeKnowledgeWorkbench?.());
bind('mcp-workbench-btn', () => window.openMcpWorkbench?.());
bind('mcp-modal-close', () => window.closeMcpWorkbench?.());
bind('manual-link-btn', () => window.openManualWorkbench?.());
bind('manual-modal-close', () => window.closeManualWorkbench?.());
bind('print-modal-close', () => window.closePrintWorkbench?.());
bind('logout-btn', () => window.logout());

document.addEventListener('click', async (event) => {
    const authToggle = event.target.closest('[data-auth-password-toggle]');
    if (authToggle) {
        window.toggleAuthPassword?.(authToggle.dataset.inputId, authToggle.dataset.iconId);
        return;
    }

    const actionButton = event.target.closest('[data-static-action]');
    if (!actionButton) return;

    const actions = {
        'toggle-model-key': () => window.toggleKeyVisibility?.(),
        'fetch-remote-models': () => window.fetchRemoteModels?.(),
        'close-user-records': () => window.closeUserRecordsModal?.(),
        'query-logs': () => window.loadLogs?.(1),
        'reset-logs': () => window.resetLogFilters?.(),
        'open-monitor-routes': () => window.openMonitorRoutesModal?.(),
        'reset-report': () => window.resetReportFilters?.(),
        'close-api-call-logs': () => window.closeApiCallLogsModal?.(),
        'close-key-modal': () => window.closeKeyModal?.(),
        'confirm-create-key': () => window.confirmCreateKey?.(),
        'copy-generated-key': () => window.copyGeneratedKey?.(),
        'close-monitor-routes': () => window.closeMonitorRoutesModal?.()
    };
    await actions[actionButton.dataset.staticAction]?.();
});

// 管理操作
bind('ops-refresh-btn', () => window.loadOpsSummary());
bind('monitor-refresh-btn', () => window.loadMonitorSummary());
bind('monitor-auto-refresh', () => window.loadMonitorSummary(), 'change');
bind('observability-webhook-save', () => window.saveObservabilityWebhook?.());
bind('rag-embedding-save-btn', () => window.saveEmbeddingSettings());
bind('prompt-add-btn', () => window.openPromptModal());
bind('modal-prompt-cancel', () => window.closePromptModal());
bind('modal-prompt-save', () => window.savePrompt());
bind('model-add-btn', () => window.openModelModal());
bind('modal-model-cancel', () => window.closeModelModal());
bind('modal-model-test', () => window.testModelConfig());
bind('m-submit-btn', () => window.addModel());
bind('m-scope', () => window.updateModelScopeControls?.(), 'change');
bind('agent-refresh-btn', () => window.loadAgentWorkbench?.());
bind('agent-run-btn', () => window.createAgentRun?.());
bind('agent-audit-btn', () => window.showAgentRunAudit?.());
bind('agent-prompt-library-btn', async () => {
    await window.ensureAdminFeatureScripts?.();
    window.openPromptLibrary?.('agent');
});
bind('agent-dag-prompt-library-btn', async () => {
    await window.ensureAdminFeatureScripts?.();
    window.openPromptLibrary?.('workflow');
});
window.bindAgentGoalTemplates?.();
window.bindAgentFilters?.();
bind('mcp-refresh-btn', () => window.loadMcpWorkbench?.());
bind('mcp-save-btn', () => window.saveMcpServer?.());
bind('mcp-reset-btn', () => window.resetMcpForm?.());
bind('mcp-edit-cancel-btn', () => window.closeMcpEditModal?.());
bind('mcp-edit-save-btn', () => window.saveMcpServer?.('edit'));

// 知识库管理
bind('rag-upload-btn', () => window.openKnowledgeUploadModal?.());
bind('rag-upload-input', () => window.uploadKnowledgeDoc(), 'change');

// 用户管理
bind('user-add-btn', () => window.openUserModal());
bind('modal-user-cancel', () => window.closeUserModal());
bind('modal-user-save', () => window.saveUser());
bind('user-template-btn', () => window.downloadUserTemplate());
bind('user-import-btn', () => document.getElementById('user-import-input').click());
bind('user-import-input', () => window.importUsers(), 'change');
bind('user-export-btn', () => window.exportUsers());
bind('public-registration-toggle', () => window.updatePublicRegistrationSetting?.(), 'change');

// 审计与导出
bind('logs-export-btn', () => window.exportLogs());
bind('stats-export-btn', () => window.exportStats());
bind('details-export-btn', () => window.exportDetails());

// 其他
bind('image-viewer-modal', () => window.closeImageViewer());

// --- 搜索防抖 ---
let searchTimer = null;
document.getElementById('session-search-input')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => window.loadSessions(), 300);
});
document.getElementById('session-tag-filter')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => window.loadSessions(), 300);
});

// --- 初始化 ---
if (typeof checkLogin === 'function') checkLogin();
resizeUserInput();
