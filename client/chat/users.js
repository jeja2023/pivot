// --- 用户管理模块 User Management ---
window.loadUsers = async function(page = 1) {
    const res = await fetch(`${API_BASE}/admin/users?page=${page}&limit=${pageState.limit}`, { headers: authHeaders() });
    const { data, total } = await res.json();
    document.getElementById('user-list-body').innerHTML = data.map(u => `
        <tr>
            <td class="text-center" title="${u.id}">${u.id}</td>
            <td title="${escapeHtml(u.username)}">${escapeHtml(u.username)}</td>
            <td title="${escapeHtml(u.nickname || '')}">${escapeHtml(u.nickname || u.username)}</td>
            <td title="${escapeHtml(u.unit || '')}">${escapeHtml(u.unit || '-')}</td>
            <td title="${escapeHtml(u.role)}">${escapeHtml(u.role)}</td>
            <td title="${escapeHtml(u.status || 'active')}">${(u.status || 'active') === 'disabled' ? '禁用' : '启用'}</td>
            <td title="${escapeHtml(formatDateToCN(u.created_at))}">${escapeHtml(formatDateToCN(u.created_at))}</td>
            <td title="${escapeHtml(formatDateToCN(u.last_login_at))}">${escapeHtml(formatDateToCN(u.last_login_at))}</td>
            <td class="text-center">
                <div style="display: flex; gap: 4px; justify-content: center; align-items: center;">
                    <button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem;" onclick="prepareEditUser(JSON.parse(decodeURIComponent('${encodeActionArg(u)}')))">编辑</button>
                    <button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem;" onclick="resetUserPassword(${u.id})">重置密码</button>
                    ${u.id !== currentUser.id && u.username !== 'admin' ? `<button class="btn-danger" style="padding: 1px 5px; font-size: 0.68rem;" onclick="deleteUser(${u.id})">删除</button>` : ''}
                </div>
            </td>
        </tr>
    `).join('');
    renderPagination('users', total, page);
}

window.downloadUserTemplate = () => {
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

window.openUserModal = () => {
    resetUserForm();
    document.getElementById('user-modal-title').innerText = '添加用户';
    document.getElementById('u-password-wrap').classList.remove('hidden');
    document.getElementById('user-modal-container').classList.remove('hidden');
};

window.closeUserModal = () => document.getElementById('user-modal-container').classList.add('hidden');

window.resetUserForm = () => {
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

window.prepareEditUser = (user) => {
    document.getElementById('u-id').value = user.id;
    document.getElementById('u-username').value = user.username;
    document.getElementById('u-username').disabled = true;
    document.getElementById('u-nickname').value = user.nickname || '';
    document.getElementById('u-unit').value = user.unit || '';
    const isRootAdmin = user.username === 'admin';
    document.getElementById('u-role').value = user.role || 'user';
    document.getElementById('u-role').disabled = isRootAdmin;
    document.getElementById('u-status').value = user.status || 'active';
    document.getElementById('u-status').disabled = isRootAdmin;
    document.getElementById('u-password-wrap').classList.add('hidden');
    document.getElementById('user-modal-title').innerText = '编辑用户';
    document.getElementById('user-modal-container').classList.remove('hidden');
};

window.saveUser = async () => {
    const id = document.getElementById('u-id').value;
    const payload = {
        username: document.getElementById('u-username').value,
        password: document.getElementById('u-password').value,
        nickname: document.getElementById('u-nickname').value,
        unit: document.getElementById('u-unit').value,
        role: document.getElementById('u-role').value,
        status: document.getElementById('u-status').value
    };
    const res = await fetch(API_BASE + (id ? `/admin/users/${id}` : '/admin/users'), {
        method: id ? 'PUT' : 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '保存失败', 'error');
    closeUserModal();
    loadUsers(pageState.users);
    showToast('用户已保存');
};

window.resetUserPassword = async (id) => {
    const password = prompt('请输入新密码（至少 8 位，包含字母和数字）');
    if (!password) return;
    const res = await fetch(`${API_BASE}/admin/users/${id}/password`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '重置失败', 'error');
    showToast('密码已重置');
};

window.exportUsers = () => downloadFileByFetch(`${API_BASE}/admin/users/export`, 'users.csv');

window.importUsers = async () => {
    const fileInput = document.getElementById('user-import-input');
    const file = fileInput.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await fetch(`${API_BASE}/admin/users/import`, {
            method: 'POST',
            headers: authHeaders(),
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            showToast(`成功导入 ${data.count} 名用户`);
            loadUsers();
        }
    } catch (e) { showToast('导入失败', 'error'); }
    fileInput.value = '';
};

window.deleteUser = (id) => {
    showConfirm('删除用户', '确定删除该用户吗？所有历史对话将被清空。', async () => {
        const res = await fetch(API_BASE + `/admin/users/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.ok) { showToast('用户已删除'); loadUsers(pageState.users); }
    });
};
