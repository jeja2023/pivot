// --- 模型管理模块 Model Management ---
const pendingTests = new Set();

window.loadModels = async function(page = 1) {
    const [modelRes, settingsRes] = await Promise.all([
        fetch(`${API_BASE}/models?page=${page}&limit=${pageState.limit}`, { headers: authHeaders() }),
        fetch(`${API_BASE}/settings`, { headers: authHeaders() })
    ]);

    if (modelRes.status === 401) {
        handleUnauthorized();
        return;
    }
    const result = await modelRes.json();
    const settings = settingsRes.ok ? await settingsRes.json() : {};
    const personalDefaultId = settings.personalDefaultModelId;
    const globalDefaultId = settings.defaultModelId;
    const data = result.data || [];
    const total = result.total || 0;
    
    if (page === 1) refreshModelSelector();

    document.getElementById('model-list-body').innerHTML = data.map((m, idx) => {
        const isGlobalModel = !m.user_id;
        const isPersonalDefault = String(m.id) === String(personalDefaultId);
        const isGlobalDefault = isGlobalModel && String(m.id) === String(globalDefaultId);
        const isAdmin = currentUser.role === 'admin';
        const isMyModel = !isAdmin && String(m.user_id) === String(currentUser.id);
        
        let defaultBtn = '';
        if (isAdmin) {
            if (isGlobalDefault) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--danger); color: var(--danger);" onclick="setGlobalDefaultModel(null, this).then(() => loadModels(${page}))">取消默认</button>`;
            } else if (isGlobalModel) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" onclick="setGlobalDefaultModel(${m.id}, this).then(() => loadModels(${page}))">设为默认</button>`;
            }
        } else {
            if (isPersonalDefault) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--danger); color: var(--danger);" onclick="saveMyDefaultModel(null, this).then(() => loadModels(${page}))">取消默认</button>`;
            } else if (isMyModel) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" onclick="saveMyDefaultModel(${m.id}, this).then(() => loadModels(${page})).catch(() => {})">设为默认</button>`;
            }
        }

        const isUserPrivateModel = m.user_id && m.owner_role !== 'admin';
        const isOwnModel = String(m.user_id) === String(currentUser.id);
        const canEdit = isAdmin ? !isUserPrivateModel : isOwnModel;
        const canDelete = isAdmin || isOwnModel;
        
        let displayUrl = escapeHtml(m.url);
        if (isAdmin) {
            if (isUserPrivateModel) displayUrl = '********';
        } else {
            if (!isOwnModel) displayUrl = '********';
        }

        return `
        <tr id="model-row-${m.id}">
            <td class="text-center">${(page - 1) * pageState.limit + idx + 1}</td>
            <td title="${escapeHtml(m.name)}">
                <div class="model-name-cell">
                    <span>${escapeHtml(m.name)}${m.user_id ? ' <small>(私有)</small>' : ' <small>(全局)</small>'}</span>
                </div>
            </td>
            <td title="${displayUrl}">${displayUrl}</td>
            <td>${Number(m.daily_token_limit || 0) > 0 ? Number(m.daily_token_limit).toLocaleString() : '不限'}</td>
            <td title="${escapeHtml(m.allowed_units || '')}">${escapeHtml(m.allowed_units || '全部')}</td>
            <td title="${escapeHtml(m.owner_nickname || m.owner_name || '全局')}">${escapeHtml(m.owner_nickname || m.owner_name || '全局')}</td>
            <td class="text-center">
                <span class="status-dot status-unknown" id="status-${m.id}" title="等待检测"></span>
                <small id="latency-${m.id}"></small>
            </td>
            <td title="${escapeHtml(formatDateToCN(m.created_at))}">${escapeHtml(formatDateToCN(m.created_at))}</td>
            <td class="text-center">
                <div style="display: flex; gap: 4px; justify-content: center; align-items: center;">
                    <button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" onclick="testExistingModel(JSON.parse(decodeURIComponent('${encodeActionArg(m)}')))">测试</button>
                    ${defaultBtn}
                    ${canEdit ? `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem;" onclick="prepareEditModel(JSON.parse(decodeURIComponent('${encodeActionArg(m)}')))">编辑</button>` : ''}
                    ${canDelete ? `<button class="btn-danger" style="padding: 1px 5px; font-size: 0.68rem;" onclick="deleteModel(${m.id})">删除</button>` : ''}
                </div>
            </td>
        </tr>
    `; }).join('');
    
    data.forEach(m => checkSingleModelStatus(m.id));
    renderPagination('models', total, page);
}

async function checkSingleModelStatus(id) {
    if (pendingTests.has(id)) return;
    const dot = document.getElementById(`status-${id}`);
    const latencyEl = document.getElementById(`latency-${id}`);
    if (!dot) return;
    pendingTests.add(id);
    const startTime = Date.now();
    try {
        const res = await fetch('/api/models/test', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id, source: 'auto' })
        });
        const duration = Date.now() - startTime;
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success !== false) {
            dot.className = 'status-dot status-online';
            dot.title = '在线';
            latencyEl.innerText = `${duration}ms`;
        } else {
            dot.className = 'status-dot status-offline';
            dot.title = data.error || '连接失败';
            latencyEl.innerText = '';
        }
    } catch (e) {
        dot.className = 'status-dot status-offline';
        dot.title = '网络错误';
    } finally {
        pendingTests.delete(id);
    }
}

window.openModelModal = () => {
    resetModelForm();
    document.getElementById('model-modal-title').innerText = '添加新模型';
    document.getElementById('model-modal-container').classList.remove('hidden');
};

window.closeModelModal = () => document.getElementById('model-modal-container').classList.add('hidden');

window.prepareEditModel = (model) => {
    document.getElementById('m-id').value = model.id;
    document.getElementById('m-name').value = model.name;
    document.getElementById('m-url').value = model.url;
    document.getElementById('m-model').value = model.model_name;
    document.getElementById('m-key').value = model.api_key || '';
    document.getElementById('m-daily-limit').value = model.daily_token_limit || '';
    document.getElementById('m-units').value = model.allowed_units || '';
    const tempEl = document.getElementById('m-temp');
    if (tempEl) tempEl.value = model.temperature !== null && model.temperature !== undefined ? model.temperature : '';
    const maxTokensEl = document.getElementById('m-max-tokens');
    if (maxTokensEl) maxTokensEl.value = model.max_tokens || '';
    const maxConcurrentEl = document.getElementById('m-max-concurrent');
    if (maxConcurrentEl) maxConcurrentEl.value = model.max_concurrent || '';
    const monitorUrlEl = document.getElementById('m-monitor-url');
    if (monitorUrlEl) monitorUrlEl.value = model.monitor_url || '';
    document.getElementById('model-modal-title').innerText = '编辑模型配置';
    document.getElementById('model-modal-container').classList.remove('hidden');
};

window.testExistingModel = async (model) => {
    if (pendingTests.has(model.id)) return showToast('该模型正在自动检测，请稍后再试', 'info');
    await testConnection(null, null, null, model.id);
};

window.testModelConfig = async () => {
    const id = document.getElementById('m-id').value;
    const url = document.getElementById('m-url').value;
    const api_key = document.getElementById('m-key').value;
    const model_name = document.getElementById('m-model').value;
    await testConnection(url, api_key, model_name, id);
};

async function testConnection(url, api_key, model_name, id = null) {
    if (!id && !url) return showToast('请输入接口地址', 'error');
    showToast('正在测试连接...', 'info');
    try {
        const res = await fetch('/api/models/test', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id, url, api_key, model_name, source: 'manual' })
        });
        const data = await res.json();
        if (res.ok && data.success === false) return showToast('连接失败: ' + (data.error || '未知错误'), 'error');
        if (res.ok) showToast('连接成功');
        else showToast('连接失败: ' + (data.error || '未知错误'), 'error');
    } catch (e) { showToast('网络错误', 'error'); }
}

window.refreshModelSelector = async function() {
    const selector = document.getElementById('model-selector');
    if (!selector) return;
    const selected = selector.value;
    const describeModelOption = (m, simple = false) => {
        if (simple) return m.name + (m.user_id ? ' (私有)' : '');
        const parts = [m.name];
        if (m.user_id) parts.push('私有');
        if (m.model_name && m.model_name !== m.name) parts.push(m.model_name);
        const limit = Number(m.daily_token_limit || 0);
        if (limit > 0) parts.push(`限额: ${limit.toLocaleString()} /日`);
        if (!m.user_id && m.allowed_units) parts.push(`范围: ${m.allowed_units}`);
        return parts.join(' · ');
    };
    try {
        const [modelRes, settingsRes] = await Promise.all([
            fetch(`${API_BASE}/models?page=1&limit=100`, { headers: authHeaders() }),
            fetch(`${API_BASE}/settings`, { headers: authHeaders() })
        ]);
        if (!modelRes.ok) throw new Error('模型列表加载失败');
        const { data } = await modelRes.json();
        const settings = settingsRes.ok ? await settingsRes.json() : {};
        const defaultModelId = settings.personalDefaultModelId || settings.defaultModelId;

        // 管理员过滤：不显示普通用户的私有模型
        const filteredData = currentUser.role === 'admin'
            ? data.filter(m => !m.user_id || m.owner_role === 'admin')
            : data;

        selector.innerHTML = filteredData.length
            ? filteredData.map(m => `<option value="${m.id}" title="${escapeHtml(describeModelOption(m, false))}">${escapeHtml(describeModelOption(m, true))}</option>`).join('')
            : '<option value="">暂无可用模型</option>';
        selector.disabled = filteredData.length === 0;

        if (selected && filteredData.some(m => String(m.id) === String(selected))) selector.value = selected;
        else if (defaultModelId && filteredData.some(m => String(m.id) === String(defaultModelId))) selector.value = defaultModelId;
        else if (filteredData.length > 0) selector.value = filteredData[0].id;
    } catch (e) {
        selector.innerHTML = '<option value="">模型加载失败</option>';
        selector.disabled = true;
    }
}

window.resetModelForm = () => {
    ['m-id', 'm-name', 'm-url', 'm-model', 'm-key', 'm-daily-limit', 'm-units', 'm-temp', 'm-max-tokens', 'm-max-concurrent', 'm-monitor-url'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const keyInput = document.getElementById('m-key');
    if (keyInput) keyInput.type = 'password';
};

window.toggleKeyVisibility = async () => {
    const keyInput = document.getElementById('m-key');
    const eyeIcon = document.getElementById('eye-icon');
    const modelId = document.getElementById('m-id').value;

    const hideKey = () => {
        keyInput.type = 'password';
        keyInput.value = '********';
        eyeIcon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>`;
    };

    if (keyInput.type === 'password' && keyInput.value === '********' && modelId) {
        // 使用标准的系统 prompt 替代简单的显示
        const pwd = prompt("安全验证：请输入当前登录密码以查看明文密钥", "");
        if (!pwd) return;

        try {
            const res = await fetch(`${API_BASE}/models/${modelId}/key`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pwd })
            });
            const data = await res.json();
            if (res.ok && data.key) {
                keyInput.value = data.key;
                keyInput.type = 'text';
                eyeIcon.innerHTML = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>`;
                showToast('已显示明文，5秒后自动隐藏', 'success');
                setTimeout(hideKey, 5000);
            } else {
                showToast(data.error || '获取密钥失败', 'error');
            }
        } catch (e) { 
            showToast('请求失败，请检查网络', 'error'); 
        }
    } else {
        const isPassword = keyInput.type === 'password';
        if (!isPassword && modelId) {
            hideKey();
        } else {
            keyInput.type = isPassword ? 'text' : 'password';
            eyeIcon.innerHTML = isPassword ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>` : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>`;
        }
    }
};

window.addModel = async () => {
    const id = document.getElementById('m-id').value;
    const payload = {
        name: document.getElementById('m-name').value,
        url: document.getElementById('m-url').value,
        model_name: document.getElementById('m-model').value,
        api_key: document.getElementById('m-key').value,
        daily_token_limit: Number(document.getElementById('m-daily-limit').value || 0),
        allowed_units: document.getElementById('m-units').value,
        temperature: document.getElementById('m-temp') ? document.getElementById('m-temp').value : undefined,
        max_tokens: document.getElementById('m-max-tokens') ? document.getElementById('m-max-tokens').value : undefined,
        max_concurrent: document.getElementById('m-max-concurrent') ? Number(document.getElementById('m-max-concurrent').value || 0) : 0,
        monitor_url: document.getElementById('m-monitor-url') ? document.getElementById('m-monitor-url').value.trim() : ''
    };
    if (!payload.name || !payload.url) return showToast('模型名称和接口地址不能为空', 'error');
    const btn = document.getElementById('m-submit-btn');
    const oldText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '正在保存...';
    try {
        const res = await fetch(API_BASE + (id ? `/models/${id}` : '/models'), {
            method: id ? 'PUT' : 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload)
        });
        if (res.ok) { loadModels(); closeModelModal(); showToast(id ? '更新成功' : '添加成功'); }
        else { const err = await res.json(); showToast(err.error || '操作失败', 'error'); }
    } catch (e) { showToast('请求失败', 'error'); }
    finally { btn.disabled = false; btn.innerText = oldText; }
};

window.deleteModel = (id) => {
    showConfirm('删除模型', '确定要删除该模型配置吗？', async () => {
        const res = await fetch(`${API_BASE}/models/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (res.ok) { showToast('模型已删除'); loadModels(pageState.models); }
    });
};

window.setGlobalDefaultModel = async (modelId, btn = null) => {
    if (btn) {
        btn.innerText = modelId ? '取消默认' : '设为默认';
        btn.style.borderColor = modelId ? 'var(--danger)' : 'var(--primary)';
        btn.style.color = modelId ? 'var(--danger)' : 'var(--primary)';
    }
    try {
        const res = await fetch(`${API_BASE}/admin/settings`, {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ default_model_id: modelId })
        });
        if (res.ok) {
            showToast(modelId ? '已设为系统默认模型' : '已取消系统默认设置');
            const selector = document.getElementById('model-selector');
            if (selector) selector.value = modelId;
        }
        else { const data = await res.json(); showToast(data.error || '设置失败', 'error'); }
    } catch (e) { showToast('设置失败', 'error'); }
};
