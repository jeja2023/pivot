/* 附件与账号安全辅助功能 */
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
};

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
