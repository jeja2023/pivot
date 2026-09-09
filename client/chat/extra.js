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

function isAttachmentSuperAdmin() {
    if (typeof isSuperAdminUser === 'function') {
        return Boolean(isSuperAdminUser());
    }
    const attachmentsTab = document.getElementById('tab-content-attachments');
    return attachmentsTab?.classList.contains('attachments-show-owner') || false;
}

function syncAttachmentOwnerVisibility(showOwner) {
    const isSuper = Boolean(showOwner);
    const attachmentsTab = document.getElementById('tab-content-attachments');
    if (attachmentsTab) attachmentsTab.classList.toggle('attachments-show-owner', isSuper);
    const userFilterGroup = document.getElementById('attachment-filter-user-group') || document.querySelector('.attachments-user-filter');
    if (userFilterGroup) {
        userFilterGroup.classList.toggle('hidden', !isSuper);
        userFilterGroup.style.display = isSuper ? '' : 'none';
    }
    let ownerHeader = document.getElementById('attachment-user-header');
    if (!ownerHeader && isSuper) {
        const firstHeader = document.querySelector('#tab-content-attachments thead tr th:first-child');
        if (firstHeader) {
            ownerHeader = document.createElement('th');
            ownerHeader.id = 'attachment-user-header';
            ownerHeader.textContent = '用户';
            firstHeader.insertAdjacentElement('afterend', ownerHeader);
        }
    }
    ownerHeader?.classList.toggle('hidden', !isSuper);
}

function getAttachmentFilterParams() {
    const filename = document.getElementById('attachment-filter-filename')?.value?.trim() || '';
    const fileType = document.getElementById('attachment-filter-type')?.value || '';
    const session = document.getElementById('attachment-filter-session')?.value?.trim() || '';
    const isSuper = isAttachmentSuperAdmin();
    const user = isSuper ? (document.getElementById('attachment-filter-user')?.value?.trim() || '') : '';
    return { filename, fileType, user, session };
}

function resetAttachmentFilters() {
    const filenameEl = document.getElementById('attachment-filter-filename');
    const typeEl = document.getElementById('attachment-filter-type');
    const userEl = document.getElementById('attachment-filter-user');
    const sessionEl = document.getElementById('attachment-filter-session');
    if (filenameEl) filenameEl.value = '';
    if (typeEl) typeEl.value = '';
    if (userEl) userEl.value = '';
    if (sessionEl) sessionEl.value = '';
}

window.Pivot.legacy.loadAttachments = async function(page = 1) {
    syncAttachmentOwnerVisibility(isAttachmentSuperAdmin());
    const { filename, fileType, user, session } = getAttachmentFilterParams();
    const params = new URLSearchParams({
        page: String(page),
        limit: String(pageState.limit || 10)
    });
    if (filename) params.set('keyword', filename);
    if (fileType) params.set('fileType', fileType);
    if (user) params.set('user', user);
    if (session) params.set('session', session);

    const res = await apiFetch(`${API_BASE}/attachments?${params.toString()}`, { headers: authHeaders() });
    const { data, total, isSuperAdmin } = await res.json();
    const showOwner = isSuperAdmin === true;
    syncAttachmentOwnerVisibility(showOwner);

    const tbody = document.getElementById('attachment-list-body');
    const colSpan = showOwner ? 8 : 7;
    if (!data || data.length === 0) {
        PivotSafeHtml.setHtml(tbody, `<tr><td colspan="${colSpan}" class="text-center">暂无匹配的附件数据</td></tr>`);
    } else {
        PivotSafeHtml.setHtml(tbody, data.map((item, idx) => {
            const typeDisplay = MIME_TYPE_MAP[item.file_type] || item.file_type || '未知类型';
            const ownerName = item.nickname || item.username || `用户 ${item.user_id || '-'}`;
            const sessionText = item.session_title || item.session_id || '未关联会话';
            const safeOwner = escapeHtml(ownerName);
            const safeFileName = escapeHtml(item.file_name);
            const safeSession = escapeHtml(sessionText);
            const safeType = escapeHtml(typeDisplay);
            const safeDate = escapeHtml(formatDateToCN(item.created_at));
            return `
            <tr>
                <td class="text-center">${(page - 1) * pageState.limit + idx + 1}</td>
                ${showOwner ? `<td title="${safeOwner}">${safeOwner}</td>` : ''}
                <td title="${safeFileName}">${safeFileName}</td>
                <td title="${safeSession}">${safeSession}</td>
                <td title="${safeType}">${safeType}</td>
                <td title="${formatFileSize(item.file_size)}">${formatFileSize(item.file_size)}</td>
                <td title="${safeDate}">${safeDate}</td>
                <td class="text-center">
                    <div class="attachment-actions">
                        <button class="btn-secondary btn-sm" data-attachment-preview data-attachment-url="${escapeHtml(item.url)}" data-attachment-name="${safeFileName}" data-attachment-type="${escapeHtml(item.file_type || '')}">预览</button>
                        <button class="btn-danger btn-sm" data-attachment-action="delete" data-attachment-id="${item.id}">删除</button>
                    </div>
                </td>
            </tr>
        `;
        }).join(''));
    }
    renderPagination('attachments', total, page);
};

function formatFileSize(size) {
    const v = Number(size) || 0;
    if (v > 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    if (v > 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${v} B`;
}

window.Pivot.legacy.deleteAttachment = (id) => {
    window.Pivot.legacy.showConfirm('删除附件', '确定删除该附件吗？', async () => {
        const res = await apiFetch(`${API_BASE}/attachments/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.ok) { showToast('附件已删除'); window.Pivot.legacy.loadAttachments(pageState.attachments); }
    });
};

document.addEventListener('click', (event) => {
    const deleteBtn = event.target.closest('[data-attachment-action="delete"]');
    if (deleteBtn) {
        event.preventDefault();
        window.Pivot.legacy.deleteAttachment(deleteBtn.dataset.attachmentId);
        return;
    }

    if (event.target.closest('#attachment-query-btn')) {
        event.preventDefault();
        window.Pivot.legacy.loadAttachments(1);
        return;
    }

    if (event.target.closest('#attachment-reset-btn')) {
        event.preventDefault();
        resetAttachmentFilters();
        window.Pivot.legacy.loadAttachments(1);
        return;
    }
});

window.Pivot.legacy.changePassword = async () => {
    const oldPassword = document.getElementById('pw-old').value;
    const newPassword = document.getElementById('pw-new').value;
    const confirmPassword = document.getElementById('pw-confirm').value;
    if (!oldPassword || !newPassword) return showToast('请输入完整密码信息', 'error');
    if (newPassword !== confirmPassword) return showToast('两次输入的新密码不一致', 'error');
    const passwordError = window.Pivot.legacy.getPasswordValidationMessage?.(newPassword, '新密码') || '';
    if (passwordError) return showToast(passwordError, 'error');
    window.Pivot.legacy.showConfirm('确认修改密码', '修改密码后，您需要重新登录，确定继续吗？', async () => {
        try {
            const res = await apiFetch(`${API_BASE}/settings/password`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ oldPassword, newPassword }) });
            if (!res.ok) { const data = await res.json(); throw new Error(data.error || '修改失败'); }
            showToast('密码修改成功，请重新登录', 'success');
            setTimeout(() => { localStorage.clear(); window.location.reload(); }, 1500);
        } catch (e) { showToast(e.message, 'error'); }
    });
};
