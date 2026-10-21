const copyTextToClipboard = async (text) => {
    if (!text && text !== '') return;
    const dialogHelpers = window.Pivot?.legacy?.chatDialogHelpers;
    if (typeof dialogHelpers?.writeTextToClipboard === 'function') {
        try {
            await dialogHelpers.writeTextToClipboard(text);
            return;
        } catch (_) {}
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (_) {}
    }
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '-9999px';
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    textArea.style.fontSize = '12pt';
    const selection = document.getSelection();
    const originalRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, textArea.value.length);
    let success = false;
    try {
        success = document.execCommand('copy');
    } catch (_) {
        success = false;
    }
    document.body.removeChild(textArea);
    if (originalRange && selection) {
        selection.removeAllRanges();
        selection.addRange(originalRange);
    }
    if (!success) throw new Error('执行命令复制失败');
};

const normalizeClipboardText = (text) => {
    if (!text) return '';
    const normalized = String(text)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[ \t]+$/gm, '');

    // 区分代码块与正文：代码块内部保留合理空行（至多保留单空行），正文段落间消除多余空行，避免粘贴时产生意外空行
    const parts = normalized.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g);
    return parts.map(part => {
        if (/^(```|~~~)/.test(part)) {
            return part.replace(/\n{3,}/g, '\n\n').trim();
        }
        return part
            .replace(/^[ \t]*(?:>[ \t]*)+$/gm, '')
            .replace(/^([ \t]*(?:\d+\.|-|\*|\+|\b\[[ xX]\]\b))[ \t]*\n+([^\n])/gm, '$1 $2')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }).filter(Boolean).join('\n');
};

const cleanRawMarkdownForClipboard = (content) => {
    if (!content) return '';
    return normalizeClipboardText(
        String(content)
            .replace(/PIVOT_(WORLD_STATE|MCP_TOOL_RESULT|AGENT_CONTROL)_BEGIN[\s\S]*?PIVOT_\1_END/gi, '')
            .replace(/PIVOT_(?:WORLD_STATE|MCP_TOOL_RESULT|AGENT_CONTROL)_BEGIN[\s\S]*$/gi, '')
            .replace(/^\s*PIVOT_(?:WORLD_STATE|MCP_TOOL_RESULT|AGENT_CONTROL)_(?:BEGIN|END)\s*$/gim, '')
            .replace(/<(thought|think|thinking)>[\s\S]*?<\/\1>/gi, '')
            .replace(/<(thought|think|thinking)>[\s\S]*$/gi, '')
    );
};

const formatListsInElement = (root) => {
    const lists = Array.from(root.querySelectorAll('ol, ul'));
    lists.forEach(list => {
        const isOrdered = list.tagName.toLowerCase() === 'ol';
        const start = isOrdered ? (parseInt(list.getAttribute('start') || '1', 10) || 1) : 1;
        let index = start;

        let depth = 0;
        let p = list.parentElement;
        while (p && p !== root) {
            if (p.tagName && (p.tagName.toLowerCase() === 'ol' || p.tagName.toLowerCase() === 'ul')) {
                depth++;
            }
            p = p.parentElement;
        }
        const indent = '  '.repeat(depth);

        Array.from(list.children).forEach(child => {
            if (!child.tagName || child.tagName.toLowerCase() !== 'li') return;
            if (child.dataset.clipboardListMarked === 'true') return;
            child.dataset.clipboardListMarked = 'true';

            const checkbox = child.querySelector('input[type="checkbox"]');
            let prefix = '';
            if (checkbox) {
                prefix = indent + (checkbox.checked ? '[x] ' : '[ ] ');
                checkbox.remove();
            } else if (isOrdered) {
                prefix = indent + `${index}. `;
                index++;
            } else {
                prefix = indent + '- ';
            }

            const firstP = child.firstElementChild;
            if (firstP && firstP.tagName.toLowerCase() === 'p') {
                firstP.insertBefore(document.createTextNode(prefix), firstP.firstChild);
            } else {
                child.insertBefore(document.createTextNode(prefix), child.firstChild);
            }
        });
    });
};

const extractMessageTextForClipboard = (messageContent) => {
    if (!messageContent) return '';

    // 1. 优先使用原始 Markdown 文本（最保真，保留序号、代码块、公式与格式）
    const rawContent = messageContent._rawMessageContent || messageContent.closest?.('.message')?._rawMessageContent;
    if (typeof rawContent === 'string' && rawContent.trim()) {
        const cleaned = cleanRawMarkdownForClipboard(rawContent);
        if (cleaned) return cleaned;
    }

    // 2. 从 DOM 树结构化提取
    const body = messageContent.querySelector('.text-body') || messageContent;
    const temp = body.cloneNode(true);

    temp.querySelectorAll('.code-toolbar, .thought-summary, .action-btn, [data-copy-ignore]').forEach(el => el.remove());

    const thoughtBlocks = temp.querySelectorAll('.thought-block');
    if (thoughtBlocks.length > 0) {
        const cloneWithoutThoughts = temp.cloneNode(true);
        cloneWithoutThoughts.querySelectorAll('.thought-block').forEach(el => el.remove());
        if (cloneWithoutThoughts.innerText.trim()) {
            thoughtBlocks.forEach(el => el.remove());
        } else {
            thoughtBlocks.forEach(block => {
                const inner = block.querySelector('.thought-content');
                if (inner) block.replaceWith(inner);
            });
        }
    }

    // 处理代码块：转换为标准 ```lang 语法
    temp.querySelectorAll('.code-block').forEach(block => {
        const codeEl = block.querySelector('code');
        const code = codeEl ? codeEl.innerText : block.innerText;
        const lang = block.dataset.codeLanguage || block.querySelector('.code-language')?.innerText?.trim() || '';
        const cleanLang = lang.toLowerCase() === 'code' ? '' : lang.toLowerCase();
        const pre = document.createElement('pre');
        pre.textContent = `\`\`\`${cleanLang}\n${(code || '').replace(/\r\n/g, '\n').trimEnd()}\n\`\`\``;
        block.replaceWith(pre);
    });

    // 处理数学公式
    temp.querySelectorAll('.math-block').forEach(block => {
        const tex = block.querySelector('annotation')?.textContent?.trim();
        if (tex) {
            const pre = document.createElement('pre');
            pre.textContent = `$$\n${tex}\n$$`;
            block.replaceWith(pre);
        }
    });
    temp.querySelectorAll('.katex').forEach(katexEl => {
        if (!katexEl.isConnected) return;
        const tex = katexEl.querySelector('annotation')?.textContent?.trim();
        if (tex) {
            katexEl.replaceWith(document.createTextNode(`$${tex}$`));
        }
    });

    // 处理表格：转换为整洁的 Markdown 表格
    temp.querySelectorAll('table').forEach(table => {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (!rows.length) return;
        const mdRows = [];
        let hasHeader = false;
        rows.forEach((tr, rowIndex) => {
            const cells = Array.from(tr.querySelectorAll('th, td'));
            if (!cells.length) return;
            if (rowIndex === 0 && tr.querySelector('th')) hasHeader = true;
            const rowText = cells.map(c => (c.innerText || '').replace(/\r?\n/g, ' ').trim()).join(' | ');
            mdRows.push(`| ${rowText} |`);
            if (rowIndex === 0 && hasHeader) {
                const sep = cells.map(() => '---').join(' | ');
                mdRows.push(`| ${sep} |`);
            }
        });
        if (mdRows.length > 0) {
            if (!hasHeader && rows.length > 1) {
                const sep = Array.from(rows[0].querySelectorAll('td')).map(() => '---').join(' | ');
                mdRows.splice(1, 0, `| ${sep} |`);
            }
            const pre = document.createElement('pre');
            pre.textContent = mdRows.join('\n');
            const wrapper = table.closest('.table-wrapper') || table;
            wrapper.replaceWith(pre);
        }
    });

    // 处理有序列表和无序列表（补充缺失的数字序号和符号）
    formatListsInElement(temp);

    let text = temp.innerText || '';

    // 3. 回退：任务状态摘要卡片
    if (!text.trim() && messageContent) {
        const heading = messageContent.querySelector('.chat-task-heading')?.innerText?.trim() || '';
        const statusSummary = messageContent.querySelector('.chat-task-status-summary')?.innerText?.trim() || '';
        const goalBody = messageContent.querySelector('.chat-task-goal-body')?.innerText?.trim() || '';
        const resultNote = messageContent.querySelector('.chat-task-result-note')?.innerText?.trim() || '';
        text = [heading, statusSummary, goalBody, resultNote].filter(Boolean).join('\n\n');
    }

    return normalizeClipboardText(text);
};

const copyMsg = async (btn) => {
    try {
        const messageContent = btn.closest('.message-content') || btn.closest('.message');
        const text = extractMessageTextForClipboard(messageContent);
        if (!text) return showToast('没有可复制的内容', 'warning');
        await copyTextToClipboard(text);
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

const setSessionSystemPrompt = async (id, title) => {
    let initialPrompt = '';
    try {
        const res = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(id)}`);
        if (res.ok) {
            const data = await res.json().catch(() => ({}));
            initialPrompt = data?.session?.system_prompt || '';
        }
    } catch (_) {}

    const prompt = await window.Pivot.legacy.showInputPrompt?.({
        title: `设置提示词 - ${title || '会话'}`,
        message: '为当前会话设置专属角色、指令或前置约束，对话时将作为系统上下文生效。留空则清除。',
        multiline: true,
        required: false,
        value: initialPrompt,
        placeholder: '例如：你是一名资深公文起草专家，回答需严谨、规范并符合公文行文习惯...',
        width: 520
    });

    if (prompt === null || prompt === undefined) return;

    try {
        const res = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(id)}/system-prompt`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPrompt: prompt })
        });
        if (res.ok) {
            showToast(prompt ? '会话系统提示词已更新' : '已清除会话系统提示词');
        } else {
            const err = await res.json().catch(() => ({}));
            showToast(err.error || '设置系统提示词失败', 'error');
        }
    } catch (e) {
        showToast('设置系统提示词失败: ' + e.message, 'error');
    }
};

window.Pivot?.exposeModule?.('chat.sessionActions', {
    copyMsg,
    extractMessageTextForClipboard,
    cleanRawMarkdownForClipboard,
    normalizeClipboardText,
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
    saveSessionTags,
    setSessionSystemPrompt
}, [
    'copyMsg',
    'extractMessageTextForClipboard',
    'cleanRawMarkdownForClipboard',
    'normalizeClipboardText',
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
    const storedOpen = !media.matches && (() => {
        try {
            const stored = localStorage.getItem('pivot_chat_sidebar_drawer_open');
            if (stored === null) return true;
            return stored === 'true';
        } catch (_) { return true; }
    })();
    if (window.Pivot.legacy.setChatSidebarDrawerOpen) {
        window.Pivot.legacy.setChatSidebarDrawerOpen(storedOpen, { persist: false });
        return;
    }
    document.querySelector('.sidebar')?.classList.toggle('collapsed', !storedOpen || media.matches);
};
syncSidebarForViewport();
sidebarViewportMedia.addEventListener?.('change', syncSidebarForViewport);

// 会话管理
bind('new-chat-btn', async () => {
    window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('chat');
    const s = await createSession('新对话');
    if (s) selectSession(s.id, s.title, { refreshSidebar: true });
});
bind('send-btn', () => window.Pivot.legacy.sendMessage());
bind('chat-voice-input', () => window.Pivot?.moduleApi?.('chat.memoryActions')?.startChatVoiceInput?.());
bind('chat-realtime-voice', () => window.Pivot?.moduleApi?.('chat.realtimeVoice')?.startRealtimeVoice?.());
bind('stop-btn', () => window.Pivot.legacy.cancelCurrentChatAgent?.() || currentAbortController?.abort());
function canSelectChatAttachment() {
    const modelId = document.getElementById('model-selector')?.value;
    const model = (window.Pivot.legacy._cachedModels || [])
        .find(item => String(item.id) === String(modelId));
    if (model && Number(model.supports_vision || 0) === 1) return true;
    showToast('当前选中的模型不具备视觉或文档分析能力', 'error');
    return false;
}
bind('upload-file-choice', () => {
    if (!canSelectChatAttachment()) return;
    window.Pivot.modules['chat.inputMenu']?.setOpen?.(false);
    document.getElementById('file-input')?.click();
});
bind('upload-folder-choice', () => {
    if (!canSelectChatAttachment()) return;
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
['ops', 'models', 'evaluation-review', 'global-params', 'tool-policy', 'memories', 'attachments', 'announcements', 'users', 'logs', 'monitor', 'usage', 'keys', 'account'].forEach(tab => {
    bind(`tab-${tab}`, () => window.Pivot.legacy.switchTab(tab));
});
document.querySelectorAll('[data-usage-subtab]').forEach(button => {
    button.addEventListener('click', () => window.Pivot?.modules['settings.usage']?.switchSubtab?.(button.dataset.usageSubtab));
});
bind('admin-modal-close', (e) => { e?.currentTarget?.blur?.(); window.Pivot.legacy.closeModal(); });
bind('apps-workbench-btn', () => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
bind('personal-workbench-btn', () => window.Pivot.moduleApi('workspaces.navigation').openPersonalWorkbench?.());
bind('admin-panel-btn', () => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.());
bind('automation-workbench-btn', () => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.({ tab: 'tasks' }));
bind('knowledge-workbench-btn', () => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.());
bind('mcp-workbench-btn', () => window.Pivot.moduleApi('workspaces.navigation').openMcpWorkbench?.());
bind('manual-link-btn', () => window.Pivot.legacy.openManualWorkbench?.());
bind('manual-modal-close', () => window.Pivot.legacy.closeManualWorkbench?.());
bind('print-modal-close', () => window.Pivot.legacy.closePrintWorkbench?.());
bind('logout-btn', () => window.Pivot.legacy.logout());

function bindMountedWorkspaceControls(name) {
    if (name === 'agent') {
        bind('agent-modal-close', () => window.Pivot.legacy.closeAgentWorkbench?.());
        bind('agent-refresh-btn', () => window.Pivot.legacy.loadAgentWorkbench?.());
        bind('task-create-open-btn', () => window.Pivot.legacy.setTaskComposerOpen?.(true));
        bind('task-create-close-btn', () => window.Pivot.legacy.setTaskComposerOpen?.(false));
        bind('task-create-cancel-btn', () => window.Pivot.legacy.setTaskComposerOpen?.(false));
        bind('agent-run-btn', () => window.Pivot.legacy.createAgentRun?.());
        bind('agent-audit-btn', () => window.Pivot.legacy.showAgentRunAudit?.());
        return;
    }
    if (name === 'knowledge') {
        bind('knowledge-modal-close', () => window.Pivot.legacy.closeKnowledgeWorkbench?.());
        bind('rag-upload-btn', () => window.Pivot.legacy.openKnowledgeUploadModal?.());
        bind('rag-upload-input', () => window.Pivot.legacy.addKnowledgeUploadFiles?.(), 'change');
        return;
    }
    if (name === 'mcp') {
        bind('mcp-modal-close', () => window.Pivot.legacy.closeMcpWorkbench?.());
        bind('mcp-save-btn', () => window.Pivot.legacy.saveMcpServer?.());
        bind('mcp-reset-btn', () => window.Pivot.legacy.resetMcpForm?.());
        bind('mcp-edit-cancel-btn', () => window.Pivot.legacy.closeMcpEditModal?.());
        bind('mcp-edit-save-btn', () => window.Pivot.legacy.saveMcpServer?.('edit'));
        return;
    }
    if (name !== 'settings') return;
    bind('report-query-btn', () => window.Pivot.legacy.loadReport());
    bind('report-days', () => window.Pivot.legacy.syncReportDateFilters?.(), 'change');
    bind('api-call-log-search', () => {
        clearTimeout(window.Pivot.legacy.apiCallLogSearchTimer);
        window.Pivot.legacy.apiCallLogSearchTimer = setTimeout(() => window.Pivot.legacy.loadApiCallLogs?.(1), 300);
    }, 'input');
    bind('api-call-logs-open-btn', () => window.Pivot.legacy.openApiCallLogsModal?.());
    bind('create-key-btn', () => window.Pivot.legacy.createApiKey());
    bind('pw-update-btn', () => window.Pivot.legacy.updatePassword());
    ['ops', 'models', 'evaluation-review', 'global-params', 'tool-policy', 'memories', 'attachments', 'announcements', 'users', 'logs', 'monitor', 'usage', 'keys', 'account'].forEach(tab => {
        bind(`tab-${tab}`, () => window.Pivot.legacy.switchTab(tab));
    });
    document.querySelectorAll('[data-usage-subtab]').forEach(button => {
        button.addEventListener('click', () => window.Pivot?.modules['settings.usage']?.switchSubtab?.(button.dataset.usageSubtab));
    });
    bind('admin-modal-close', (e) => { e?.currentTarget?.blur?.(); window.Pivot.legacy.closeModal(); });
    bind('ops-refresh-btn', () => window.Pivot.legacy.loadOpsSummary());
    bind('monitor-refresh-btn', () => window.Pivot.legacy.refreshMonitorSummary());
    bind('monitor-auto-refresh', () => window.Pivot.legacy.loadMonitorSummary(), 'change');
    bind('observability-webhook-save', () => window.Pivot.legacy.saveObservabilityWebhook?.());
    bind('rag-system-reindex-btn', () => (window.Pivot.getModule?.('knowledge.retrievalSummary')?.reindexAllKnowledgeDocs || window.Pivot.legacy.reindexAllKnowledgeDocs)?.());
    bind('model-add-btn', () => window.Pivot.legacy.openModelModal());
    bind('modal-model-cancel', () => window.Pivot.legacy.closeModelModal());
    bind('modal-model-test', () => window.Pivot.legacy.testModelConfig());
    bind('m-submit-btn', () => window.Pivot.legacy.addModel());
    bind('m-scope', () => window.Pivot.legacy.updateModelScopeControls?.(), 'change');
    bind('user-add-btn', () => window.Pivot.legacy.openUserModal());
    bind('modal-user-cancel', () => window.Pivot.legacy.closeUserModal());
    bind('modal-user-save', () => window.Pivot.legacy.saveUser());
    bind('user-template-btn', () => window.Pivot.legacy.downloadUserTemplate());
    bind('user-import-btn', () => document.getElementById('user-import-input')?.click());
    bind('user-import-input', () => window.Pivot.legacy.importUsers(), 'change');
    bind('user-export-btn', () => window.Pivot.legacy.exportUsers());
    bind('public-registration-toggle', () => window.Pivot.legacy.updatePublicRegistrationSetting?.(), 'change');
    bind('api-access-toggle', () => window.Pivot.legacy.updateApiAccessSetting?.(), 'change');
    bind('logs-export-btn', () => window.Pivot.legacy.exportLogs());
    bind('report-export-btn', () => window.Pivot.legacy.exportReport?.());
    bind('stats-export-btn', () => window.Pivot.legacy.exportStats());
    bind('model-cost-export-btn', () => window.Pivot.legacy.exportModelCosts?.());
    bind('compliance-export-btn', () => window.Pivot.legacy.exportCompliancePackage?.());
    bind('details-export-btn', () => window.Pivot.legacy.exportDetails());
}

document.addEventListener('pivot:workspace-mounted', event => {
    bindMountedWorkspaceControls(event.detail?.name);
});

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
        'close-monitor-routes': () => window.Pivot.legacy.closeMonitorRoutesModal?.(),
        'toggle-observability-webhook': () => window.Pivot.legacy.toggleObservabilityWebhookDrawer?.()
    };
    await actions[actionButton.dataset.staticAction]?.();
});

// 管理操作
bind('ops-refresh-btn', () => window.Pivot.legacy.loadOpsSummary());
bind('monitor-refresh-btn', () => window.Pivot.legacy.refreshMonitorSummary());
bind('monitor-auto-refresh', () => window.Pivot.legacy.loadMonitorSummary(), 'change');
bind('observability-webhook-save', () => window.Pivot.legacy.saveObservabilityWebhook?.());
bind('rag-system-reindex-btn', () => (window.Pivot.getModule?.('knowledge.retrievalSummary')?.reindexAllKnowledgeDocs || window.Pivot.legacy.reindexAllKnowledgeDocs)?.());
bind('model-add-btn', () => window.Pivot.legacy.openModelModal());
bind('modal-model-cancel', () => window.Pivot.legacy.closeModelModal());
bind('modal-model-test', () => window.Pivot.legacy.testModelConfig());
bind('m-submit-btn', () => window.Pivot.legacy.addModel());
bind('m-scope', () => window.Pivot.legacy.updateModelScopeControls?.(), 'change');
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
