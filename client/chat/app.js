/* 智枢前端主程序 Main Entry */
function handleUnauthorized() {
    localStorage.clear();
    if (window.showAuth) window.showAuth();
    else window.location.reload();
}

// --- 输入框自适应 ---
const userInput = document.getElementById('user-input');
window.resizeUserInput = () => {
    if (!userInput) return;
    userInput.style.height = 'auto';
    userInput.style.height = `${Math.min(userInput.scrollHeight, 180)}px`;
};
userInput?.addEventListener('input', resizeUserInput);
userInput && (userInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

// --- 全局确认弹窗 ---
let confirmCallback = null;
window.showConfirm = (title, message, callback) => {
    document.getElementById('confirm-title').innerText = title;
    document.getElementById('confirm-message').innerText = message;
    confirmCallback = callback;
    document.getElementById('confirm-container').classList.remove('hidden');
};
window.closeConfirmModal = () => { document.getElementById('confirm-container').classList.add('hidden'); confirmCallback = null; };
document.getElementById('confirm-ok-btn')?.addEventListener('click', () => { if (confirmCallback) confirmCallback(); window.closeConfirmModal(); });
document.getElementById('modal-confirm-cancel')?.addEventListener('click', window.closeConfirmModal);

// --- 消息操作 ---
window.copyMsg = (btn) => {
    const body = btn.closest('.message-content').querySelector('.text-body');
    const temp = body.cloneNode(true);
    temp.querySelectorAll('.code-toolbar, .thought-summary').forEach(el => el.remove());
    navigator.clipboard.writeText(temp.innerText.trim());
    showToast('内容已复制');
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

window.exportSession = async (id) => {
    showToast('正在导出...', 'info');
    try {
        const res = await fetch(`${API_BASE}/sessions/${id}/export`, {
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
    const s = await createSession('新对话');
    if (s) selectSession(s.id, s.title);
});
bind('send-btn', sendMessage);
bind('stop-btn', () => { currentAbortController?.abort(); });
bind('upload-btn', () => document.getElementById('file-input').click());
bind('sidebar-toggle-btn', () => window.toggleSidebar());
bind('session-active-filter', () => window.setArchiveFilter(false));
bind('session-archive-filter', () => window.setArchiveFilter(true));

// 会话弹窗
bind('modal-rename-cancel', () => window.closeRenameModal());
bind('modal-rename-save', () => window.saveSessionTitle());
bind('modal-tags-cancel', () => window.closeTagsModal());
bind('modal-tags-save', () => window.saveSessionTags());
bind('report-query-btn', () => window.loadReport());
bind('create-key-btn', () => window.createApiKey());
bind('pw-update-btn', () => window.updatePassword());

// 管理面板切换
['ops', 'models', 'prompts', 'attachments', 'labs', 'knowledge', 'users', 'logs', 'monitor', 'report', 'stats', 'keys', 'details', 'account'].forEach(tab => {
    bind(`tab-${tab}`, () => window.switchTab(tab));
});
bind('admin-modal-close', () => window.closeModal());
bind('admin-panel-btn', () => window.openAdminPanel());
bind('logout-btn', () => window.logout());

// 管理操作
bind('ops-refresh-btn', () => window.loadOpsSummary());
bind('monitor-refresh-btn', () => window.loadMonitorSummary());
bind('monitor-auto-refresh', () => window.loadMonitorSummary(), 'change');
bind('labs-refresh-btn', () => window.loadSettings());
bind('setting-rag-enabled', () => window.saveSettings(), 'change');
bind('prompt-add-btn', () => window.openPromptModal());
bind('modal-prompt-cancel', () => window.closePromptModal());
bind('modal-prompt-save', () => window.savePrompt());
bind('model-add-btn', () => window.openModelModal());
bind('modal-model-cancel', () => window.closeModelModal());
bind('modal-model-test', () => window.testModelConfig());
bind('m-submit-btn', () => window.addModel());

// 知识库管理
bind('rag-upload-btn', () => document.getElementById('rag-upload-input').click());
bind('rag-upload-input', () => window.uploadKnowledgeDoc(), 'change');

// 用户管理
bind('user-add-btn', () => window.openUserModal());
bind('modal-user-cancel', () => window.closeUserModal());
bind('modal-user-save', () => window.saveUser());
bind('user-template-btn', () => window.downloadUserTemplate());
bind('user-import-btn', () => document.getElementById('user-import-input').click());
bind('user-import-input', () => window.importUsers(), 'change');
bind('user-export-btn', () => window.exportUsers());

// 审计与导出
bind('logs-export-btn', () => window.exportLogs());
bind('stats-export-btn', () => window.exportStats());
bind('details-export-btn', () => window.exportDetails());

// 其他
bind('image-viewer-modal', () => window.closeImageViewer());

document.getElementById('file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const maxAttachments = window.MAX_PENDING_ATTACHMENTS || 5;
    if (pendingAttachments.length >= maxAttachments) {
        showToast(`最多只能上传 ${maxAttachments} 个附件`, 'error');
        e.target.value = '';
        return;
    }
    if (!currentSessionId) {
        const s = await createSession('新对话');
        if (!s) return;
        currentSessionId = s.id;
        document.getElementById('current-title').innerText = s.title;
        window.loadSessions();
    }
    const uploadChatFile = async (file, password = '') => {
        const fd = new FormData();
        fd.append('file', file);
        if (password) fd.append('password', password);
        const res = await apiFetch(`${API_BASE}/upload?sessionId=${currentSessionId}`, { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) {
            const err = new Error(data.error || 'Upload failed');
            err.data = data;
            throw err;
        }
        return data;
    };
    try {
        let uploadedCount = 0;
        let skippedCount = 0;
        showToast(files.length > 1 ? `正在上传 ${files.length} 个文件...` : '正在上传...', 'info');
        for (const file of files) {
            if (pendingAttachments.length >= maxAttachments) {
                skippedCount += 1;
                continue;
            }
            const hasPendingImage = pendingAttachments.some(item => String(item.type || '').startsWith('image/'));
            const selectedIsImage = String(file.type || '').startsWith('image/');
            if (selectedIsImage && hasPendingImage) {
                skippedCount += 1;
                continue;
            }

            let data;
            try {
                data = await uploadChatFile(file);
            } catch (uploadErr) {
                if (uploadErr.data?.passwordRequired) {
                    const password = window.prompt(`文档 ${file.name} 已加密，请输入文档密码`);
                    if (!password) {
                        skippedCount += 1;
                        continue;
                    }
                    data = await uploadChatFile(file, password);
                } else {
                    throw uploadErr;
                }
            }

            if (data.url) {
                pendingAttachments.push({ name: data.name, url: data.url, type: file.type, extractedText: data.extractedText, markdown: file.type.startsWith('image/') ? `![${data.name}](${data.url})` : `[附件: ${data.name}](${data.url})` });
                uploadedCount += 1;
                (data.visionAttachments || []).forEach(item => {
                    if (pendingAttachments.length >= maxAttachments) return;
                    if (pendingAttachments.some(entry => String(entry.type || '').startsWith('image/'))) return;
                    pendingAttachments.push({ name: item.name, url: item.url, type: 'image/png', extractedText: '', markdown: item.markdown || `![${item.name}](${item.url})` });
                });
                renderAttachmentPreviews();
            }
        }
        if (uploadedCount > 0) showToast(skippedCount > 0 ? `已上传 ${uploadedCount} 个，跳过 ${skippedCount} 个` : '上传成功');
        else if (skippedCount > 0) showToast('没有可上传的文件：最多 5 个附件，且图片每次仅 1 张', 'error');
    } catch (e) { showToast(e.message || '上传失败', 'error'); }
    e.target.value = '';
});

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
