// --- 扩展功能模块 Extra Features ---
window.loadPrompts = async function() {
    const res = await fetch(`${API_BASE}/prompts`, { headers: authHeaders() });
    const data = await res.json();
    document.getElementById('prompt-grid').innerHTML = data.map(p => `
        <div class="prompt-card">
            <div class="prompt-card-head">
                <h4>${escapeHtml(p.name)}</h4>
                <span>${escapeHtml(p.scope === 'global' ? '全局' : '个人')}</span>
            </div>
            <p>${escapeHtml(p.content)}</p>
            <div class="prompt-actions">
                <button class="btn-secondary" onclick="applyPrompt(JSON.parse(decodeURIComponent('${encodeActionArg(p)}')).content)">应用</button>
                ${(p.scope !== 'global' || currentUser.role === 'admin') ? `<button class="btn-secondary" onclick="prepareEditPrompt(JSON.parse(decodeURIComponent('${encodeActionArg(p)}')))">编辑</button><button class="btn-danger" onclick="deletePrompt(${p.id})">删除</button>` : ''}
            </div>
        </div>
    `).join('');
}

window.applyPrompt = async (content) => {
    if (!currentSessionId) return showToast('请先选择一个对话', 'error');
    showConfirm('切换 AI 角色', '确定要将该角色指令应用到当前对话吗？', async () => {
        try {
            const res = await fetch(`${API_BASE}/sessions/${currentSessionId}/system-prompt`, {
                method: 'PUT',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ systemPrompt: content })
            });
            if (res.ok) { showToast('AI 角色切换成功'); closeModal(); }
        } catch (e) { showToast('应用失败', 'error'); }
    });
};

window.openPromptModal = () => { resetPromptForm(); document.getElementById('prompt-modal-title').innerText = '添加指令'; document.getElementById('p-scope').disabled = currentUser.role !== 'admin'; document.getElementById('prompt-modal-container').classList.remove('hidden'); };
window.closePromptModal = () => document.getElementById('prompt-modal-container').classList.add('hidden');
window.resetPromptForm = () => { document.getElementById('p-id').value = ''; document.getElementById('p-name').value = ''; document.getElementById('p-category').value = '通用'; document.getElementById('p-scope').value = currentUser.role === 'admin' ? 'global' : 'personal'; document.getElementById('p-content').value = ''; };

window.prepareEditPrompt = (p) => {
    document.getElementById('p-id').value = p.id; document.getElementById('p-name').value = p.name;
    document.getElementById('p-category').value = p.category || '通用'; document.getElementById('p-scope').value = p.scope || 'personal';
    document.getElementById('p-scope').disabled = currentUser.role !== 'admin'; document.getElementById('p-content').value = p.content;
    document.getElementById('prompt-modal-title').innerText = '编辑指令'; document.getElementById('prompt-modal-container').classList.remove('hidden');
};

window.savePrompt = async () => {
    const id = document.getElementById('p-id').value;
    const payload = { name: document.getElementById('p-name').value, category: document.getElementById('p-category').value, scope: document.getElementById('p-scope').value, content: document.getElementById('p-content').value };
    const res = await fetch(API_BASE + (id ? `/prompts/${id}` : '/prompts'), { method: id ? 'PUT' : 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
    if (!res.ok) { const data = await res.json(); return showToast(data.error || '保存失败', 'error'); }
    closePromptModal(); loadPrompts(); showToast('指令已保存');
};

window.deletePrompt = (id) => {
    showConfirm('删除指令', '确定删除该指令模板吗？', async () => {
        const res = await fetch(`${API_BASE}/prompts/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.ok) { showToast('指令已删除'); loadPrompts(); }
    });
};

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
    const res = await fetch(`${API_BASE}/attachments?page=${page}&limit=${pageState.limit}&keyword=${encodeURIComponent(keyword)}`, { headers: authHeaders() });
    const { data, total } = await res.json();
    document.getElementById('attachment-list-body').innerHTML = data.map((item, idx) => {
        const typeDisplay = MIME_TYPE_MAP[item.file_type] || item.file_type || '未知类型';
        return `
        <tr>
            <td class="text-center">${(page - 1) * pageState.limit + idx + 1}</td>
            <td title="${escapeHtml(item.file_name)}">${escapeHtml(item.file_name)}</td>
            <td title="${escapeHtml(item.session_title || item.session_id || '-')}">${escapeHtml(item.session_title || item.session_id || '-')}</td>
            <td title="${escapeHtml(item.file_type)}">${escapeHtml(typeDisplay)}</td>
            <td>${formatFileSize(item.file_size)}</td>
            <td>${escapeHtml(formatDateToCN(item.created_at))}</td>
            <td class="text-center">
                <div style="display: flex; gap: 5px; justify-content: center;">
                    <a class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; text-decoration: none;" href="${item.url}" target="_blank">打开</a>
                    <button class="btn-danger" style="padding: 2px 8px; font-size: 0.75rem;" onclick="deleteAttachment(${item.id})">删除</button>
                </div>
            </td>
        </tr>
    `}).join('');
    renderPagination('attachments', total, page);
}

function formatFileSize(size) {
    const v = Number(size) || 0;
    if (v > 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    if (v > 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${v} B`;
}

window.deleteAttachment = (id) => {
    showConfirm('删除附件', '确定删除该附件吗？', async () => {
        const res = await fetch(`${API_BASE}/attachments/${id}`, { method: 'DELETE', headers: authHeaders() });
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
    if (newPassword.length < 8) return showToast('新密码长度至少需要8位', 'error');
    showConfirm('确认修改密码', '修改密码后，您需要重新登录，确定继续吗？', async () => {
        try {
            const res = await fetch(`${API_BASE}/settings/password`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ oldPassword, newPassword }) });
            if (!res.ok) { const data = await res.json(); throw new Error(data.error || '修改失败'); }
            showToast('密码修改成功，请重新登录', 'success');
            setTimeout(() => { localStorage.clear(); window.location.reload(); }, 1500);
        } catch (e) { showToast(e.message, 'error'); }
    });
};
