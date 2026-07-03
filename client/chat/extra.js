// --- 扩展功能模块 Extra Features ---
const PROMPT_TYPE_LABELS = {
    role: '角色',
    output: '输出规范',
    method: '任务方法',
    workflow: '工作流节点'
};
const PROMPT_TARGET_LABELS = {
    chat: '聊天',
    agent: '自由任务',
    workflow: '工作流'
};
const PROMPT_TARGETS = ['chat', 'agent', 'workflow'];
let promptLibraryCache = [];
let promptApplyTarget = 'chat';

function normalizePromptType(value) {
    return PROMPT_TYPE_LABELS[value] ? value : 'role';
}

function normalizePromptTargets(value) {
    const raw = Array.isArray(value) ? value : String(value || 'chat,agent,workflow').split(',');
    const list = [...new Set(raw.map(item => String(item || '').trim()).filter(item => PROMPT_TARGETS.includes(item)))];
    return list.length ? list : [...PROMPT_TARGETS];
}

function normalizePromptItem(item = {}) {
    const targetSurfaces = normalizePromptTargets(item.targetSurfaces || item.target_surfaces);
    return {
        ...item,
        type: normalizePromptType(item.type),
        description: item.description || '',
        targetSurfaces,
        target_surfaces: targetSurfaces.join(',')
    };
}

function promptTypeLabel(type) {
    return PROMPT_TYPE_LABELS[normalizePromptType(type)] || '角色';
}

function promptTargetLabel(target) {
    return PROMPT_TARGET_LABELS[target] || target;
}

function getPromptById(id) {
    return promptLibraryCache.find(item => String(item.id) === String(id)) || null;
}

function promptMatchesFilters(prompt, { type = '', target = '', query = '' } = {}) {
    if (type && prompt.type !== type) return false;
    if (target && !prompt.targetSurfaces.includes(target)) return false;
    const keyword = String(query || '').trim().toLowerCase();
    if (!keyword) return true;
    return [prompt.name, prompt.category, prompt.description, prompt.content]
        .some(value => String(value || '').toLowerCase().includes(keyword));
}

function renderPromptChips(prompt) {
    const chips = [
        promptTypeLabel(prompt.type),
        prompt.category || '通用',
        ...(prompt.targetSurfaces || []).map(promptTargetLabel)
    ];
    return chips.map(item => `<span class="prompt-chip">${escapeHtml(item)}</span>`).join('');
}

function renderPromptSurfaceActions(prompt) {
    return PROMPT_TARGETS
        .filter(target => prompt.targetSurfaces.includes(target))
        .map(target => `<button type="button" class="btn-secondary" data-prompt-action="apply-target" data-prompt-target="${target}" data-prompt-id="${prompt.id}">${escapeHtml(promptTargetLabel(target))}</button>`)
        .join('');
}

function renderPromptGrid() {
    const grid = document.getElementById('prompt-grid');
    if (!grid) return;
    const filters = {
        type: document.getElementById('prompt-type-filter')?.value || '',
        target: document.getElementById('prompt-surface-filter')?.value || '',
        query: document.getElementById('prompt-search-input')?.value || ''
    };
    const prompts = promptLibraryCache.filter(prompt => promptMatchesFilters(prompt, filters));
    PivotSafeHtml.setHtml(grid, prompts.length ? prompts.map(prompt => `
        <div class="prompt-card">
            <div class="prompt-card-head">
                <h4 title="${escapeHtml(prompt.name)}">${escapeHtml(prompt.name)}</h4>
                <span>${escapeHtml(prompt.scope === 'global' ? '全局' : '个人')}</span>
            </div>
            <div class="prompt-chip-row">${renderPromptChips(prompt)}</div>
            ${prompt.description ? `<div class="prompt-card-desc" title="${escapeHtml(prompt.description)}">${escapeHtml(prompt.description)}</div>` : ''}
            <p title="${escapeHtml(prompt.content)}">${escapeHtml(prompt.content)}</p>
            <div class="prompt-actions prompt-actions-targets">
                ${renderPromptSurfaceActions(prompt)}
                ${(prompt.scope !== 'global' || isSuperAdminUser()) ? `<button type="button" class="btn-secondary" data-prompt-action="edit" data-prompt-id="${prompt.id}">编辑</button><button type="button" class="btn-danger" data-prompt-action="delete" data-prompt-id="${prompt.id}">删除</button>` : ''}
            </div>
        </div>
    `).join('') : '<div class="prompt-empty-state">暂无可用提示词</div>');
}

window.loadPrompts = async function() {
    const res = await apiFetch(`${API_BASE}/prompts`, { headers: authHeaders() });
    const data = await res.json();
    promptLibraryCache = Array.isArray(data) ? data.map(normalizePromptItem) : [];
    renderPromptGrid();
    renderPromptApplyList();
    return promptLibraryCache;
};

async function ensurePromptLibraryLoaded() {
    if (!promptLibraryCache.length) await window.loadPrompts();
    return promptLibraryCache;
}

function promptBlock(prompt) {
    return `【${promptTypeLabel(prompt.type)}：${prompt.name}】\n${prompt.content}`.trim();
}

function appendTextBlock(current, block) {
    const existing = String(current || '').trim();
    const addition = String(block || '').trim();
    if (!addition) return existing;
    if (existing.includes(addition)) return existing;
    return existing ? `${existing}\n\n${addition}` : addition;
}

async function applyPromptToChat(prompt) {
    if (!currentSessionId) return showToast('请先选择或新建一个对话', 'error');
    showConfirm('套用到聊天', '确定将这条提示词应用到当前对话的系统提示词吗？', async () => {
        try {
            const res = await apiFetch(`${API_BASE}/sessions/${currentSessionId}/system-prompt`, {
                method: 'PUT',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ systemPrompt: prompt.content })
            });
            if (!res.ok) throw new Error('应用失败');
            window.closePromptLibrary();
            showToast('已应用到当前聊天');
            window.showMainWorkspace?.('chat');
        } catch (e) {
            showToast(e.message || '应用失败', 'error');
        }
    });
}

async function applyPromptToAgent(prompt) {
    if (document.body?.dataset.activeWorkspace !== 'agent' && typeof window.openAgentWorkbench === 'function') {
        await window.openAgentWorkbench();
    } else if (!document.getElementById('agent-context-notes') && typeof window.openAgentWorkbench === 'function') {
        await window.openAgentWorkbench();
    } else if (typeof window.showMainWorkspace === 'function') {
        window.showMainWorkspace('agent');
    }
    const notes = document.getElementById('agent-context-notes');
    if (!notes) return showToast('请先打开自由任务工作台', 'error');
    notes.value = appendTextBlock(notes.value, promptBlock(prompt));
    const contextMode = document.getElementById('agent-context-mode');
    if (contextMode) contextMode.value = 'custom';
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    window.closePromptLibrary();
    showToast('已加入自由任务补充说明');
    window.showMainWorkspace?.('agent');
}

function createPromptLlmNode(nodes, prompt) {
    const input = typeof defaultLlmInput === 'function' ? defaultLlmInput() : {};
    return {
        id: typeof uniqueId === 'function' ? uniqueId(nodes.map(node => node.id), 'llm') : `llm_${nodes.length + 1}`,
        title: `${promptTypeLabel(prompt.type)}处理`,
        tool: 'agent.llm',
        input,
        dependsOn: [],
        condition: 'success',
        retryLimit: 0,
        timeoutMs: 0,
        onError: 'skip_dependents'
    };
}

async function applyPromptToWorkflow(prompt) {
    if (document.body?.dataset.activeWorkspace !== 'agent-dag' && typeof window.openAgentDagWorkbench === 'function') {
        await window.openAgentDagWorkbench();
    } else if (typeof window.showMainWorkspace === 'function') {
        window.showMainWorkspace('agent-dag');
    }
    const textarea = document.getElementById('agent-dag-spec');
    if (!textarea) return showToast('请先打开工作流编排', 'error');
    let spec;
    try {
        spec = typeof parseAgentWorkflowText === 'function' ? parseAgentWorkflowText() : JSON.parse(textarea.value || '{"nodes":[]}');
    } catch (e) {
        return showToast('工作流 JSON 需要先修正后再套用提示词', 'error');
    }
    const normalized = Array.isArray(spec) ? { nodes: spec } : (spec && typeof spec === 'object' ? spec : { nodes: [] });
    const nodes = Array.isArray(normalized.nodes) ? normalized.nodes : [];
    let llmNode = nodes.find(node => String(node?.tool || '').trim() === 'agent.llm');
    if (!llmNode) {
        llmNode = createPromptLlmNode(nodes, prompt);
        nodes.push(llmNode);
    }
    llmNode.input = llmNode.input && typeof llmNode.input === 'object' ? llmNode.input : {};
    if (prompt.type === 'role') {
        llmNode.input.systemPrompt = appendTextBlock(llmNode.input.systemPrompt, promptBlock(prompt));
    } else {
        llmNode.input.prompt = appendTextBlock(llmNode.input.prompt || '请根据本次工作流目标完成分析：\n{{goal}}', promptBlock(prompt));
    }
    const nextSpec = { ...normalized, nodes };
    if (typeof writeAgentWorkflowText === 'function') {
        writeAgentWorkflowText(nextSpec);
    } else {
        textarea.value = JSON.stringify(nextSpec, null, 2);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    window.refreshAgentDagEditor?.();
    window.closePromptLibrary();
    showToast('已套用到工作流大模型节点');
    window.showMainWorkspace?.('agent-dag');
}

async function applyPromptToTarget(prompt, target = promptApplyTarget) {
    const surface = PROMPT_TARGETS.includes(target) ? target : 'chat';
    if (!prompt.targetSurfaces.includes(surface)) {
        return showToast('这条规范未配置到当前入口', 'error');
    }
    if (surface === 'chat') return applyPromptToChat(prompt);
    if (surface === 'agent') return applyPromptToAgent(prompt);
    if (surface === 'workflow') return applyPromptToWorkflow(prompt);
    return null;
}

function renderPromptApplyList() {
    const list = document.getElementById('prompt-apply-list');
    if (!list) return;
    const query = document.getElementById('prompt-apply-search')?.value || '';
    const type = document.getElementById('prompt-apply-type-filter')?.value || '';
    const prompts = promptLibraryCache.filter(prompt => promptMatchesFilters(prompt, { target: promptApplyTarget, query, type }));
    PivotSafeHtml.setHtml(list, prompts.length ? prompts.map(prompt => `
        <button type="button" class="prompt-apply-item" data-prompt-apply-id="${prompt.id}">
            <span class="prompt-apply-main">
                <strong>${escapeHtml(prompt.name)}</strong>
                <small>${escapeHtml(prompt.description || prompt.content)}</small>
            </span>
            <span class="prompt-apply-side">
                <em>${escapeHtml(promptTypeLabel(prompt.type))}</em>
                <small>${escapeHtml(prompt.category || '通用')}</small>
            </span>
        </button>
    `).join('') : '<div class="prompt-empty-state">当前入口暂无可用提示词</div>');
    const status = document.getElementById('prompt-apply-status');
    if (status) status.textContent = `${promptTargetLabel(promptApplyTarget)} · ${prompts.length} 条可用`;
}

window.openPromptLibrary = async function(target = 'chat') {
    promptApplyTarget = PROMPT_TARGETS.includes(target) ? target : 'chat';
    await ensurePromptLibraryLoaded();
    const title = document.getElementById('prompt-apply-title');
    const desc = document.getElementById('prompt-apply-desc');
    if (title) title.textContent = `套用到${promptTargetLabel(promptApplyTarget)}`;
    if (desc) desc.textContent = '选择一条提示词应用到当前入口。';
    const search = document.getElementById('prompt-apply-search');
    const typeFilter = document.getElementById('prompt-apply-type-filter');
    if (search) search.value = '';
    if (typeFilter) typeFilter.value = '';
    renderPromptApplyList();
    document.getElementById('prompt-apply-modal-container')?.classList.remove('hidden');
    setTimeout(() => search?.focus?.({ preventScroll: true }), 0);
};

window.closePromptLibrary = () => document.getElementById('prompt-apply-modal-container')?.classList.add('hidden');

window.applyPrompt = async (content) => applyPromptToChat(normalizePromptItem({ name: '当前规范', content, type: 'role', targetSurfaces: ['chat'] }));

function setPromptTargetChecks(targets) {
    const allowed = normalizePromptTargets(targets);
    document.querySelectorAll('input[name="p-target-surfaces"]').forEach(input => {
        input.checked = allowed.includes(input.value);
    });
}

function getPromptTargetChecks() {
    return [...document.querySelectorAll('input[name="p-target-surfaces"]:checked')].map(input => input.value);
}

window.openPromptModal = () => {
    resetPromptForm();
    document.getElementById('prompt-modal-title').innerText = '新增提示词';
    document.getElementById('p-scope').disabled = !isSuperAdminUser();
    document.getElementById('prompt-modal-container').classList.remove('hidden');
};
window.closePromptModal = () => document.getElementById('prompt-modal-container').classList.add('hidden');
window.resetPromptForm = () => {
    document.getElementById('p-id').value = '';
    document.getElementById('p-name').value = '';
    document.getElementById('p-category').value = '通用';
    document.getElementById('p-description').value = '';
    document.getElementById('p-type').value = 'role';
    document.getElementById('p-scope').value = isSuperAdminUser() ? 'global' : 'personal';
    document.getElementById('p-content').value = '';
    setPromptTargetChecks(PROMPT_TARGETS);
};

window.prepareEditPrompt = (prompt) => {
    const p = normalizePromptItem(prompt);
    document.getElementById('p-id').value = p.id;
    document.getElementById('p-name').value = p.name;
    document.getElementById('p-category').value = p.category || '通用';
    document.getElementById('p-description').value = p.description || '';
    document.getElementById('p-type').value = p.type || 'role';
    document.getElementById('p-scope').value = p.scope || 'personal';
    document.getElementById('p-scope').disabled = !isSuperAdminUser() || p.scope === 'global';
    document.getElementById('p-content').value = p.content;
    setPromptTargetChecks(p.targetSurfaces);
    document.getElementById('prompt-modal-title').innerText = '编辑提示词';
    document.getElementById('prompt-modal-container').classList.remove('hidden');
};

window.savePrompt = async () => {
    const id = document.getElementById('p-id').value;
    const payload = {
        name: document.getElementById('p-name').value,
        category: document.getElementById('p-category').value,
        description: document.getElementById('p-description').value,
        type: document.getElementById('p-type').value,
        targetSurfaces: getPromptTargetChecks(),
        scope: document.getElementById('p-scope').value,
        content: document.getElementById('p-content').value
    };
    const res = await apiFetch(API_BASE + (id ? `/prompts/${id}` : '/prompts'), {
        method: id ? 'PUT' : 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const data = await res.json();
        return showToast(data.error || '保存失败', 'error');
    }
    window.closePromptModal();
    await window.loadPrompts();
    showToast('提示词已保存');
};

window.deletePrompt = (id) => {
    showConfirm('删除提示词', '确定删除这条提示词吗？', async () => {
        const res = await apiFetch(`${API_BASE}/prompts/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.ok) {
            showToast('提示词已删除');
            await window.loadPrompts();
        }
    });
};

document.getElementById('prompt-grid')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-prompt-action]');
    if (!button) return;
    const action = button.dataset.promptAction;
    const prompt = getPromptById(button.dataset.promptId);
    if (action === 'apply-target' && prompt) return applyPromptToTarget(prompt, button.dataset.promptTarget);
    if (action === 'edit' && prompt) return window.prepareEditPrompt(prompt);
    if (action === 'delete' && button.dataset.promptId) return window.deletePrompt(button.dataset.promptId);
    return null;
});

['prompt-search-input', 'prompt-type-filter', 'prompt-surface-filter'].forEach(id => {
    const eventName = id.endsWith('input') ? 'input' : 'change';
    document.getElementById(id)?.addEventListener(eventName, renderPromptGrid);
});
['prompt-apply-search', 'prompt-apply-type-filter'].forEach(id => {
    const eventName = id.endsWith('search') ? 'input' : 'change';
    document.getElementById(id)?.addEventListener(eventName, renderPromptApplyList);
});
document.getElementById('prompt-apply-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-prompt-apply-id]');
    if (!button) return;
    const prompt = getPromptById(button.dataset.promptApplyId);
    if (prompt) applyPromptToTarget(prompt, promptApplyTarget);
});
document.getElementById('prompt-apply-close')?.addEventListener('click', () => window.closePromptLibrary());
document.getElementById('prompt-apply-modal-container')?.addEventListener('click', (event) => {
    if (event.target.id === 'prompt-apply-modal-container') window.closePromptLibrary();
});

const MIME_TYPE_MAP = {
    'application/pdf': 'PDF 文档',
    'application/msword': 'Word 文档',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word 文档',
    'application/vnd.ms-excel': 'Excel 表格',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel 表格',
    'application/vnd.ms-powerpoint': 'PPT 演示',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPT 演示',
    'text/plain': '纯文本',
    'text/markdown': 'Markdown',
    'text/csv': 'CSV 表格',
    'image/jpeg': 'JPEG 图片',
    'image/png': 'PNG 图片',
    'image/gif': 'GIF 图片',
    'image/webp': 'WebP 图片',
    'application/zip': '压缩包',
    'application/x-zip-compressed': '压缩包',
    'application/json': 'JSON 数据'
};

window.loadAttachments = async function(page = 1) {
    const keyword = document.getElementById('attachment-search-input')?.value || '';
    const res = await apiFetch(`${API_BASE}/attachments?page=${page}&limit=${pageState.limit}&keyword=${encodeURIComponent(keyword)}`, { headers: authHeaders() });
    const { data, total, isSuperAdmin } = await res.json();
    const showOwner = isSuperAdmin === true;
    const attachmentsTab = document.getElementById('tab-content-attachments');
    if (attachmentsTab) attachmentsTab.classList.toggle('attachments-show-owner', showOwner);
    let ownerHeader = document.getElementById('attachment-user-header');
    if (!ownerHeader && showOwner) {
        const firstHeader = document.querySelector('#tab-content-attachments thead tr th:first-child');
        if (firstHeader) {
            ownerHeader = document.createElement('th');
            ownerHeader.id = 'attachment-user-header';
            ownerHeader.textContent = '用户';
            firstHeader.insertAdjacentElement('afterend', ownerHeader);
        }
    }
    ownerHeader?.classList.toggle('hidden', !showOwner);
    PivotSafeHtml.setHtml(document.getElementById('attachment-list-body'), data.map((item, idx) => {
        const typeDisplay = MIME_TYPE_MAP[item.file_type] || item.file_type || '未知类型';
        const ownerName = item.nickname || item.username || `用户 ${item.user_id || '-'}`;
        return `
        <tr>
            <td class="text-center">${(page - 1) * pageState.limit + idx + 1}</td>
            ${showOwner ? `<td title="${escapeHtml(ownerName)}">${escapeHtml(ownerName)}</td>` : ''}
            <td title="${escapeHtml(item.file_name)}">${escapeHtml(item.file_name)}</td>
            <td title="${escapeHtml(item.session_title || item.session_id || '-')}">${escapeHtml(item.session_title || item.session_id || '-')}</td>
            <td title="${escapeHtml(item.file_type)}">${escapeHtml(typeDisplay)}</td>
            <td title="${formatFileSize(item.file_size)}">${formatFileSize(item.file_size)}</td>
            <td title="${escapeHtml(formatDateToCN(item.created_at))}">${escapeHtml(formatDateToCN(item.created_at))}</td>
            <td class="text-center">
                <div style="display: flex; gap: 5px; justify-content: center;">
                    <button class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" data-attachment-preview data-attachment-url="${escapeHtml(item.url)}" data-attachment-name="${escapeHtml(item.file_name)}" data-attachment-type="${escapeHtml(item.file_type || '')}">预览</button>
                    <button class="btn-danger" style="padding: 2px 8px; font-size: 0.75rem;" data-attachment-action="delete" data-attachment-id="${item.id}">删除</button>
                </div>
            </td>
        </tr>
    `}).join(''));
    renderPagination('attachments', total, page);
}

document.getElementById('attachment-list-body')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-attachment-action="delete"]');
    if (!button) return;
    window.deleteAttachment(button.dataset.attachmentId);
});

function formatFileSize(size) {
    const v = Number(size) || 0;
    if (v > 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    if (v > 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${v} B`;
}

window.deleteAttachment = (id) => {
    showConfirm('删除附件', '确定删除该附件吗？', async () => {
        const res = await apiFetch(`${API_BASE}/attachments/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.ok) { showToast('附件已删除'); loadAttachments(pageState.attachments); }
    });
};

let attachmentSearchTimer = null;
document.getElementById('attachment-search-input')?.addEventListener('input', () => {
    clearTimeout(attachmentSearchTimer);
    attachmentSearchTimer = setTimeout(() => loadAttachments(1), 300);
});

window.changePassword = async () => {
    const oldPassword = document.getElementById('pw-old').value;
    const newPassword = document.getElementById('pw-new').value;
    const confirmPassword = document.getElementById('pw-confirm').value;
    if (!oldPassword || !newPassword) return showToast('请输入完整密码信息', 'error');
    if (newPassword !== confirmPassword) return showToast('两次输入的新密码不一致', 'error');
    const passwordError = window.getPasswordValidationMessage?.(newPassword, '新密码') || '';
    if (passwordError) return showToast(passwordError, 'error');
    showConfirm('确认修改密码', '修改密码后，您需要重新登录，确定继续吗？', async () => {
        try {
            const res = await apiFetch(`${API_BASE}/settings/password`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ oldPassword, newPassword }) });
            if (!res.ok) { const data = await res.json(); throw new Error(data.error || '修改失败'); }
            showToast('密码修改成功，请重新登录', 'success');
            setTimeout(() => { localStorage.clear(); window.location.reload(); }, 1500);
        } catch (e) { showToast(e.message, 'error'); }
    });
};
