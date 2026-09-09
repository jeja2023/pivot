// --- 用户管理模块 User Management ---
const userActionCache = new Map();

function setPublicRegistrationToggle(enabled) {
    const toggle = document.getElementById('public-registration-toggle');
    const status = document.getElementById('public-registration-status');
    if (toggle) toggle.checked = enabled === true;
    if (status) {
        status.textContent = enabled ? '已开启' : '已关闭';
        status.classList.toggle('is-off', enabled !== true);
    }
}

function userPasswordError(password, label = '密码') {
    return window.Pivot.legacy.getPasswordValidationMessage?.(password, label) || '';
}

function renderUserActionButton(action, label, userOrId, className = 'btn-secondary') {
    const userId = typeof userOrId === 'object' ? userOrId.id : userOrId;
    if (typeof userOrId === 'object') userActionCache.set(String(userId), userOrId);
    if (className === 'btn-danger') {
        return `<button type="button" class="btn-danger" data-user-action="${action}" data-user-id="${escapeHtml(userId)}">${label}</button>`;
    }
    return `<button type="button" class="btn-secondary" data-user-action="${action}" data-user-id="${escapeHtml(userId)}">${label}</button>`;
}

function getUserFilterParams() {
    const search = document.getElementById('user-filter-search')?.value.trim() || '';
    const unit = document.getElementById('user-filter-unit')?.value.trim() || '';
    const role = document.getElementById('user-filter-role')?.value || '';
    return { search, unit, role };
}

function resetUserFilters() {
    const searchInput = document.getElementById('user-filter-search');
    const unitInput = document.getElementById('user-filter-unit');
    const roleSelect = document.getElementById('user-filter-role');
    if (searchInput) searchInput.value = '';
    if (unitInput) unitInput.value = '';
    if (roleSelect) roleSelect.value = '';
    window.Pivot.legacy.loadUsers(1);
}

window.Pivot.legacy.loadUsers = async function(page = 1) {
    const requestedPage = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.max(parseInt(pageState.limit, 10) || 15, 1);
    pageState.users = requestedPage;
    const { search, unit, role } = getUserFilterParams();
    const params = new URLSearchParams({ page: String(requestedPage), limit: String(limit) });
    if (search) params.set('search', search);
    if (unit) params.set('unit', unit);
    if (role) params.set('role', role);
    const res = await apiFetch(`${API_BASE}/admin/users?${params.toString()}`, { headers: authHeaders() });
    const { data = [], total = 0, isSuperAdmin, allowPublicRegistration } = await res.json();
    const totalCount = Number(total) || 0;
    const lastPage = Math.max(Math.ceil(totalCount / limit), 1);
    if (requestedPage > lastPage && totalCount > 0) return window.Pivot.legacy.loadUsers(lastPage);
    const tbody = document.getElementById('user-list-body');
    if (!res.ok) {
        renderTableMessage(tbody, 9, '用户加载失败');
        renderPagination('users', 0, 1);
        return;
    }
    const canViewUserRecords = isSuperAdmin === true || isSuperAdminUser();
    setPublicRegistrationToggle(allowPublicRegistration === true);

    userActionCache.clear();
    if (!data.length) {
        renderTableMessage(tbody, 9, (search || unit || role) ? '未找到符合条件的用户' : '暂无用户数据');
        renderPagination('users', 0, requestedPage);
        return;
    }
    PivotSafeHtml.setHtml(tbody, data.map(u => {
        const permissionTier = u.permissionTier || u.permission_tier || getPermissionTier(u);
        const permissionLabel = u.permissionLabel || u.permission_label || getPermissionLabel(u);
        const isDeleted = Boolean(u.deleted_at);
        const statusLabel = isDeleted ? '已删除' : ((u.status || 'active') === 'disabled' ? '禁用' : '启用');
        const statusClass = isDeleted ? 'is-deleted' : ((u.status || 'active') === 'disabled' ? 'is-disabled' : 'is-active');

        let actionsHtml = '';
        if (isDeleted) {
            actionsHtml = `
                ${canViewUserRecords ? renderUserActionButton('records', '记录', u) : ''}
                <span class="user-deleted-tag">已注销</span>
            `;
        } else {
            actionsHtml = `
                ${canViewUserRecords ? renderUserActionButton('records', '记录', u) : ''}
                ${renderUserActionButton('edit', '编辑', u)}
                ${u.username !== 'admin' ? renderUserActionButton('reset-password', '重置密码', u.id) : ''}
                ${u.id !== currentUser?.id && u.username !== 'admin' ? renderUserActionButton('delete', '删除', u.id, 'btn-danger') : ''}
            `;
        }

        return `
        <tr>
            <td class="text-center" title="${u.id}">${u.id}</td>
            <td title="${escapeHtml(u.username)}">${escapeHtml(u.username)}</td>
            <td title="${escapeHtml(u.nickname || '')}">${escapeHtml(u.nickname || u.username)}</td>
            <td title="${escapeHtml(u.unit || '')}">${escapeHtml(u.unit || '-')}</td>
            <td title="${escapeHtml(`权限层级: ${permissionTier}; 存储角色: ${u.role}`)}">${escapeHtml(permissionLabel)}</td>
            <td><span class="user-status-badge ${statusClass}" title="${escapeHtml(statusLabel)}">${statusLabel}</span></td>
            <td title="${escapeHtml(formatDateToCN(u.created_at))}">${escapeHtml(formatDateToCN(u.created_at))}</td>
            <td title="${escapeHtml(formatDateToCN(u.last_login_at))}">${escapeHtml(formatDateToCN(u.last_login_at))}</td>
            <td class="text-center">
                <div class="user-table-actions">
                    ${actionsHtml}
                </div>
            </td>
        </tr>
    `;
    }).join(''));
    renderPagination('users', totalCount, requestedPage);
    window.Pivot?.modules?.['settings.scale']?.scheduleSettingsWorkspaceScale?.();
};

document.addEventListener('click', (event) => {
    const queryBtn = event.target.closest('#user-query-btn');
    if (queryBtn) {
        event.preventDefault();
        window.Pivot.legacy.loadUsers?.(1);
        return;
    }
    const resetBtn = event.target.closest('#user-reset-btn');
    if (resetBtn) {
        event.preventDefault();
        resetUserFilters();
        return;
    }
    const button = event.target.closest('#user-list-body [data-user-action][data-user-id]');
    if (!button) return;
    const userId = button.dataset.userId;
    const action = button.dataset.userAction;
    const user = userActionCache.get(String(userId));
    if (action === 'records' && user) return window.Pivot.legacy.openUserRecords(user);
    if (action === 'edit' && user) return window.Pivot.legacy.prepareEditUser(user);
    if (action === 'reset-password') return window.Pivot.legacy.resetUserPassword(userId);
    if (action === 'delete') return window.Pivot.legacy.deleteUser(userId);
});

window.Pivot.legacy.downloadUserTemplate = () => {
    const headers = ['用户名', '密码', '显示名', '单位', '角色'];
    const rows = [
        ['testuser1', 'P@ssw0rd123', '测试用户1', '智枢科技', 'user'],
        ['admin_demo', 'StrongPwd99', '演示管理员', '技术部', 'admin']
    ];
    const content = '\uFEFF' + headers.join(',') + '\n' + rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pivot_user_import_template.csv';
    a.click();
    URL.revokeObjectURL(url);
};

window.Pivot.legacy.openUserModal = () => {
    window.Pivot.legacy.resetUserForm();
    document.getElementById('user-modal-title').innerText = '添加用户';
    document.getElementById('u-password-wrap').classList.remove('hidden');
    document.getElementById('user-modal-container').classList.remove('hidden');
};

window.Pivot.legacy.closeUserModal = () => document.getElementById('user-modal-container').classList.add('hidden');

window.Pivot.legacy.resetUserForm = () => {
    document.getElementById('u-id').value = '';
    document.getElementById('u-username').value = '';
    document.getElementById('u-username').disabled = false;
    document.getElementById('u-password').value = '';
    document.getElementById('u-nickname').value = '';
    document.getElementById('u-unit').value = '';
    document.getElementById('u-role').value = 'user';
    document.getElementById('u-role').disabled = false;
    document.getElementById('u-status').value = 'active';
    document.getElementById('u-status').disabled = false;
};

window.Pivot.legacy.prepareEditUser = (user) => {
    document.getElementById('u-id').value = user.id;
    document.getElementById('u-username').value = user.username;
    document.getElementById('u-username').disabled = true;
    document.getElementById('u-nickname').value = user.nickname || '';
    document.getElementById('u-unit').value = user.unit || '';
    const isBuiltInAdminAccount = user.username === 'admin';
    document.getElementById('u-role').value = user.role || 'user';
    document.getElementById('u-role').disabled = isBuiltInAdminAccount;
    document.getElementById('u-status').value = user.status || 'active';
    document.getElementById('u-status').disabled = isBuiltInAdminAccount;
    document.getElementById('u-password-wrap').classList.add('hidden');
    document.getElementById('user-modal-title').innerText = '编辑用户';
    document.getElementById('user-modal-container').classList.remove('hidden');
};

window.Pivot.legacy.saveUser = async () => {
    const id = document.getElementById('u-id').value;
    const payload = {
        username: document.getElementById('u-username').value,
        password: document.getElementById('u-password').value,
        nickname: document.getElementById('u-nickname').value,
        unit: document.getElementById('u-unit').value,
        role: document.getElementById('u-role').value,
        status: document.getElementById('u-status').value
    };
    if (!id) {
        const passwordError = userPasswordError(payload.password, '初始密码');
        if (passwordError) return showToast(passwordError, 'error');
    }
    const res = await apiFetch(API_BASE + (id ? `/admin/users/${id}` : '/admin/users'), {
        method: id ? 'PUT' : 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '保存失败', 'error');
    window.Pivot.legacy.closeUserModal();
    window.Pivot.legacy.loadUsers(pageState.users);
    showToast('用户已保存');
};

window.Pivot.legacy.resetUserPassword = async (id) => {
    const password = await window.Pivot.legacy.showInputPrompt({
        title: '重置密码',
        message: `请输入新密码，${window.Pivot.legacy.PASSWORD_RULE_DESCRIPTION || '至少 8 位，并同时包含字母和数字'}。`,
        type: 'password',
        placeholder: '新密码',
        autocomplete: 'new-password'
    });
    if (!password) return;
    const passwordError = userPasswordError(password, '新密码');
    if (passwordError) return showToast(passwordError, 'error');
    const res = await apiFetch(`${API_BASE}/admin/users/${id}/password`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '重置失败', 'error');
    showToast('密码已重置');
};

window.Pivot.legacy.updatePublicRegistrationSetting = async () => {
    const toggle = document.getElementById('public-registration-toggle');
    if (!toggle || !isSuperAdminUser()) return;
    const previous = !toggle.checked;
    toggle.disabled = true;
    try {
        const res = await apiFetch(`${API_BASE}/admin/users/registration`, {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ allowPublicRegistration: toggle.checked })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '开放注册设置保存失败');
        setPublicRegistrationToggle(data.allowPublicRegistration === true);
        window.Pivot.legacy.allowPublicRegistration = data.allowPublicRegistration === true;
        window.Pivot.legacy.setPublicRegistrationState?.(window.Pivot.legacy.allowPublicRegistration);
        document.getElementById('auth-toggle')?.classList.toggle('hidden', !window.Pivot.legacy.allowPublicRegistration);
        showToast(data.allowPublicRegistration ? '开放注册已开启' : '开放注册已关闭');
    } catch (e) {
        setPublicRegistrationToggle(previous);
        showToast(e.message, 'error');
    } finally {
        toggle.disabled = false;
    }
};

window.Pivot.legacy.exportUsers = () => {
    const { search, unit, role } = getUserFilterParams();
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (unit) params.set('unit', unit);
    if (role) params.set('role', role);
    const queryStr = params.toString();
    downloadFileByFetch(`${API_BASE}/admin/users/export${queryStr ? `?${queryStr}` : ''}`, 'users.csv');
};

let userRecordsTarget = null;
let userRecordsEventsBound = false;

function scrollUserRecordsToBottom() {
    const wrapper = document.querySelector('.user-records-table-wrap');
    if (!wrapper) return;
    const apply = () => { wrapper.scrollTop = wrapper.scrollHeight; };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 80);
    setTimeout(apply, 240);
}

function bindUserRecordsEvents() {
    if (userRecordsEventsBound) return;
    userRecordsEventsBound = true;
    document.getElementById('user-record-session-select')?.addEventListener('change', () => {
        pageState.userRecords = 1;
        window.Pivot.legacy.loadUserRecordMessages(1);
    });
    document.getElementById('user-record-include-deleted')?.addEventListener('change', async () => {
        await window.Pivot.legacy.loadUserRecordSessions();
        pageState.userRecords = 1;
        await window.Pivot.legacy.loadUserRecordMessages(1);
    });
    document.getElementById('user-record-refresh-btn')?.addEventListener('click', async () => {
        await window.Pivot.legacy.loadUserRecordSessions();
        await window.Pivot.legacy.loadUserRecordMessages(pageState.userRecords || 1);
    });
}

window.Pivot.legacy.openUserRecords = async (user) => {
    if (!isSuperAdminUser()) return showToast('仅 admin 权限层级可查看用户详细记录', 'error');
    userRecordsTarget = user;
    bindUserRecordsEvents();
    document.getElementById('user-records-title').innerText = `${user.nickname || user.username}（${user.username}）`;
    const includeDeleted = document.getElementById('user-record-include-deleted');
    if (includeDeleted) includeDeleted.checked = true;
    document.getElementById('user-records-modal').classList.remove('hidden');
    pageState.userRecords = 1;
    await window.Pivot.legacy.loadUserRecordSessions();
    await window.Pivot.legacy.loadUserRecordMessages(1);
};

window.Pivot.legacy.closeUserRecordsModal = () => {
    document.getElementById('user-records-modal')?.classList.add('hidden');
    const pagination = document.getElementById('pagination-userRecords');
    if (pagination) PivotSafeHtml.setHtml(pagination, '');
    userRecordsTarget = null;
};

window.Pivot.legacy.loadUserRecordSessions = async () => {
    if (!userRecordsTarget) return;
    const select = document.getElementById('user-record-session-select');
    const includeDeleted = document.getElementById('user-record-include-deleted')?.checked === true;
    if (!select) return;
    const previous = select.value;
    const res = await apiFetch(`${API_BASE}/admin/users/${userRecordsTarget.id}/sessions?includeDeleted=${includeDeleted}`, { headers: authHeaders() });
    const { data = [] } = await res.json();
    PivotSafeHtml.setHtml(select, '<option value="">全部会话</option>' + data.map(s => {
        const title = escapeHtml(s.title || '未命名会话');
        const deleted = s.deleted_at ? '（已删除）' : '';
        const msgCount = Number(s.msg_count || 0);
        return `<option value="${escapeHtml(s.id)}">${title}${deleted} - ${msgCount} 条</option>`;
    }).join(''));
    if (previous && data.some(s => String(s.id) === previous)) select.value = previous;
};

window.Pivot.legacy.loadUserRecordMessages = async (page = 1) => {
    if (!userRecordsTarget) return;
    pageState.userRecords = page;
    const body = document.getElementById('user-records-body');
    const sessionId = document.getElementById('user-record-session-select')?.value || '';
    const includeDeleted = document.getElementById('user-record-include-deleted')?.checked === true;
    if (!body) return;
    renderTableMessage(body, 7, '正在加载记录...');
    const limit = pageState.limit || 15;
    const params = new URLSearchParams({ includeDeleted: String(includeDeleted), page, limit });
    if (sessionId) params.set('sessionId', sessionId);
    const res = await apiFetch(`${API_BASE}/admin/users/${userRecordsTarget.id}/messages?${params.toString()}`, { headers: authHeaders() });
    const { data = [], total = 0 } = await res.json();
    if (!res.ok) {
        renderTableMessage(body, 7, '记录加载失败');
        renderPagination('userRecords', 0, 1);
        return;
    }
    if (!data.length) {
        renderTableMessage(body, 7, '暂无输入输出记录');
        renderPagination('userRecords', total, page);
        return;
    }
    const displayData = sessionId ? data.slice().reverse() : data;
    PivotSafeHtml.setHtml(body, displayData.map(record => {
        const userContent = escapeHtml(record.user_content || '');
        const assistantContent = escapeHtml(record.assistant_content || '');
        const sessionTitle = escapeHtml(record.session_title || '未命名会话');
        const deleted = record.deleted_at ? '<span class="record-deleted">已删除</span>' : '';
        const inputTokens = Number(record.input_tokens || 0);
        const outputTokens = Number(record.output_tokens || 0);
        return `
            <tr>
                <td title="${escapeHtml(formatDateToCN(record.created_at))}">${escapeHtml(formatDateToCN(record.created_at))}</td>
                <td title="${sessionTitle}">${sessionTitle}${deleted}</td>
                <td title="${escapeHtml(record.model_name || '')}">${escapeHtml(record.model_name || '-')}</td>
                <td class="text-center" title="${inputTokens.toLocaleString()}">${escapeHtml(formatTokenCount(inputTokens))}</td>
                <td class="text-center" title="${outputTokens.toLocaleString()}">${escapeHtml(formatTokenCount(outputTokens))}</td>
                <td class="user-record-content" title="${userContent}">${userContent || '-'}</td>
                <td class="user-record-content" title="${assistantContent}">${assistantContent || '-'}</td>
            </tr>
        `;
    }).join(''));
    renderPagination('userRecords', total, page);
    if (sessionId) scrollUserRecordsToBottom();
};

window.Pivot.legacy.importUsers = async () => {
    const fileInput = document.getElementById('user-import-input');
    const file = fileInput.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await apiFetch(`${API_BASE}/admin/users/import`, {
            method: 'POST',
            headers: authHeaders(),
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            showToast(`成功导入 ${data.count} 名用户`);
            window.Pivot.legacy.loadUsers();
        } else if (data.error) {
            showToast(data.error, 'error');
        }
    } catch (e) { showToast(e.message || '导入失败', 'error'); }
    fileInput.value = '';
};

window.Pivot.legacy.deleteUser = (id) => {
    window.Pivot.legacy.showConfirm('删除用户', '确定删除该用户吗？账号将被禁用，历史对话、附件、审计和用量数据会保留，仅 admin 权限层级可追溯查看。', async () => {
        const res = await apiFetch(API_BASE + `/admin/users/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.ok) { showToast('用户已删除'); window.Pivot.legacy.loadUsers(pageState.users); }
    });
};
