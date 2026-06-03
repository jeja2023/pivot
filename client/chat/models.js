// --- 模型管理模块 Model Management ---
const pendingTests = new Set();

function ensureModelCostFields() {
    if (document.getElementById('m-input-price')) return;
    const dailyInput = document.getElementById('m-daily-limit');
    const anchorRow = dailyInput?.closest('.model-form-row');
    if (!anchorRow) return;
    const row = document.createElement('div');
    row.className = 'model-form-row model-cost-row';
    row.innerHTML = `
        <div class="form-item">
            <label>Input price / 1M Token</label>
            <input type="number" id="m-input-price" class="form-input" min="0" step="0.000001" placeholder="0 = no cost tracking">
        </div>
        <div class="form-item">
            <label>Output price / 1M Token</label>
            <input type="number" id="m-output-price" class="form-input" min="0" step="0.000001" placeholder="0 = no cost tracking">
        </div>
        <div class="form-item">
            <label>Currency</label>
            <input type="text" id="m-price-currency" class="form-input" placeholder="CNY">
        </div>
    `;
    anchorRow.insertAdjacentElement('afterend', row);
}

function renderModelCapabilityBadges(model) {
    const icons = [
        '<span class="model-capability-icon cap-icon text" title="文本模型" aria-label="文本模型"><svg viewBox="0 0 24 24"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg></span>'
    ];

    if (Number(model.supports_vision || 0) === 1) {
        icons.push('<span class="model-capability-icon cap-icon vision" title="支持视觉输入" aria-label="支持视觉输入"><svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span>');
    }

    if (Number(model.supports_reasoning || 0) === 1) {
        icons.push('<span class="model-capability-icon cap-icon reasoning" title="支持思考/推理" aria-label="支持思考/推理"><svg viewBox="0 0 24 24"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 1 0 7.5 11.5C8.3 12.3 8.8 13 9 14"/></svg></span>');
    }

    return icons.join('');
}

window.loadModels = async function(page = 1) {
    const [modelRes, settingsRes] = await Promise.all([
        apiFetch(`${API_BASE}/models?page=${page}&limit=${pageState.limit}`, { headers: authHeaders() }),
        apiFetch(`${API_BASE}/settings`, { headers: authHeaders() })
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
        const isSuperAdmin = currentUser.username === 'admin';
        const isMyModel = String(m.user_id) === String(currentUser.id);
        
        let defaultBtn = '';
        if (isSuperAdmin) {
            if (isGlobalDefault) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--danger); color: var(--danger);" data-model-action="set-global-default" data-model-id="" data-page="${page}">取消默认</button>`;
            } else if (isGlobalModel) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" data-model-action="set-global-default" data-model-id="${m.id}" data-page="${page}">设为默认</button>`;
            } else if (isMyModel && isPersonalDefault) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--danger); color: var(--danger);" data-model-action="set-personal-default" data-model-id="" data-page="${page}">取消个人默认</button>`;
            } else if (isMyModel) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" data-model-action="set-personal-default" data-model-id="${m.id}" data-page="${page}">设为个人默认</button>`;
            }
        } else {
            if (isPersonalDefault) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--danger); color: var(--danger);" data-model-action="set-personal-default" data-model-id="" data-page="${page}">取消默认</button>`;
            } else if (isMyModel) {
                defaultBtn = `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" data-model-action="set-personal-default" data-model-id="${m.id}" data-page="${page}">设为默认</button>`;
            }
        }

        const isOwnModel = String(m.user_id) === String(currentUser.id);
        const canEdit = isOwnModel || (isSuperAdmin && isGlobalModel);
        const canDelete = canEdit;
        
        let displayUrl = escapeHtml(m.url);
        if (isSuperAdmin) {
            if (!isGlobalModel && !isOwnModel) displayUrl = '********';
        } else {
            if (!isOwnModel) displayUrl = '********';
        }

        const capabilityBadge = renderModelCapabilityBadges(m);

        return `
        <tr id="model-row-${m.id}">
            <td class="text-center">${(page - 1) * pageState.limit + idx + 1}</td>
            <td title="${escapeHtml(m.name)}">
                <div class="model-name-cell">
                    <span>${escapeHtml(m.name)}${m.user_id ? ' <small>(私有)</small>' : ' <small>(全局)</small>'}</span>
                </div>
            </td>
            <td title="${displayUrl}">${displayUrl}</td>
            <td title="${Number(m.daily_token_limit || 0).toLocaleString()} Tokens / ${escapeHtml(m.price_currency || 'CNY')} ${Number(m.input_price_per_million || 0)}/${Number(m.output_price_per_million || 0)}">${formatTokenAmount(m.daily_token_limit)} / <small>${escapeHtml(m.price_currency || 'CNY')} ${Number(m.input_price_per_million || 0)}/${Number(m.output_price_per_million || 0)}</small></td>
            <td class="model-capability-cell"><div class="model-capability-icons">${capabilityBadge}</div></td>
            <td title="${escapeHtml(m.allowed_units || '')}">${escapeHtml(m.allowed_units || '全部')}</td>
            <td title="${escapeHtml(m.owner_nickname || m.owner_name || '全局')}">${escapeHtml(m.owner_nickname || m.owner_name || '全局')}</td>
            <td class="text-center">
                <span class="status-dot status-unknown" id="status-${m.id}" title="等待检测"></span>
                <small id="latency-${m.id}"></small>
            </td>
            <td title="${escapeHtml(formatDateToCN(m.created_at))}">${escapeHtml(formatDateToCN(m.created_at))}</td>
            <td class="text-center">
                <div style="display: flex; gap: 4px; justify-content: center; align-items: center;">
                    <button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem; border-color: var(--primary); color: var(--primary);" data-model-action="test" data-model="${encodeActionArg(m)}">测试</button>
                    ${defaultBtn}
                    ${canEdit ? `<button class="btn-secondary" style="padding: 1px 5px; font-size: 0.68rem;" data-model-action="edit" data-model="${encodeActionArg(m)}">编辑</button>` : ''}
                    ${canDelete ? `<button class="btn-danger" style="padding: 1px 5px; font-size: 0.68rem;" data-model-action="delete" data-model-id="${m.id}">删除</button>` : ''}
                </div>
            </td>
        </tr>
    `; }).join('');
    
    data.forEach(m => checkSingleModelStatus(m.id));
    renderPagination('models', total, page);
}

document.getElementById('model-list-body')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-model-action]');
    if (!button) return;
    const action = button.dataset.modelAction;
    const modelId = button.dataset.modelId || null;
    const page = Number.parseInt(button.dataset.page, 10) || pageState.models || 1;
    const model = button.dataset.model ? JSON.parse(decodeURIComponent(button.dataset.model)) : null;

    if (action === 'test' && model) return window.testExistingModel(model);
    if (action === 'edit' && model) return window.prepareEditModel(model);
    if (action === 'delete' && modelId) return window.deleteModel(modelId);
    if (action === 'set-global-default') {
        await window.setGlobalDefaultModel(modelId, button);
        return window.loadModels(page);
    }
    if (action === 'set-personal-default') {
        await window.saveMyDefaultModel(modelId, button);
        return window.loadModels(page);
    }
});

async function checkSingleModelStatus(id) {
    if (pendingTests.has(id)) return;
    const dot = document.getElementById(`status-${id}`);
    const latencyEl = document.getElementById(`latency-${id}`);
    if (!dot) return;
    pendingTests.add(id);
    const startTime = Date.now();
    try {
        const res = await apiFetch('/api/models/test', {
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
    ensureModelCostFields();
    resetModelForm();
    document.getElementById('model-modal-title').innerText = '添加新模型';
    window.updateModelScopeControls?.();
    document.getElementById('model-modal-container').classList.remove('hidden');
};

window.closeModelModal = () => document.getElementById('model-modal-container').classList.add('hidden');

window.prepareEditModel = (model) => {
    ensureModelCostFields();
    document.getElementById('m-id').value = model.id;
    const scopeEl = document.getElementById('m-scope');
    if (scopeEl) scopeEl.value = model.user_id ? 'personal' : 'global';
    document.getElementById('m-name').value = model.name;
    document.getElementById('m-url').value = model.url;
    document.getElementById('m-model').value = model.model_name;
    document.getElementById('m-key').value = model.api_key || '';
    document.getElementById('m-daily-limit').value = formatTokenInputValue(model.daily_token_limit);
    document.getElementById('m-units').value = model.allowed_units || '';
    const tempEl = document.getElementById('m-temp');
    if (tempEl) tempEl.value = model.temperature !== null && model.temperature !== undefined ? model.temperature : '';
    const maxTokensEl = document.getElementById('m-max-tokens');
    if (maxTokensEl) maxTokensEl.value = formatTokenInputValue(model.max_tokens);
    const maxInputTokensEl = document.getElementById('m-max-input-tokens');
    if (maxInputTokensEl) maxInputTokensEl.value = formatTokenInputValue(model.max_input_tokens);
    const maxConcurrentEl = document.getElementById('m-max-concurrent');
    if (maxConcurrentEl) maxConcurrentEl.value = model.max_concurrent || '';
    const monitorUrlEl = document.getElementById('m-monitor-url');
    if (monitorUrlEl) monitorUrlEl.value = model.monitor_url || '';
    const supportsVisionEl = document.getElementById('m-supports-vision');
    if (supportsVisionEl) supportsVisionEl.checked = Number(model.supports_vision || 0) === 1;
    const supportsReasoningEl = document.getElementById('m-supports-reasoning');
    if (supportsReasoningEl) supportsReasoningEl.checked = Number(model.supports_reasoning || 0) === 1;
    const inputPriceEl = document.getElementById('m-input-price');
    if (inputPriceEl) inputPriceEl.value = model.input_price_per_million || '';
    const outputPriceEl = document.getElementById('m-output-price');
    if (outputPriceEl) outputPriceEl.value = model.output_price_per_million || '';
    const currencyEl = document.getElementById('m-price-currency');
    if (currencyEl) currencyEl.value = model.price_currency || 'CNY';
    document.getElementById('model-modal-title').innerText = '编辑模型配置';
    window.updateModelScopeControls?.(model);
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
        const res = await apiFetch('/api/models/test', {
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

// refreshModelSelector 已在 ui.js 中定义
window.resetModelForm = () => {
    ensureModelCostFields();
    ['m-id', 'm-name', 'm-url', 'm-model', 'm-key', 'm-daily-limit', 'm-units', 'm-temp', 'm-max-input-tokens', 'm-max-tokens', 'm-max-concurrent', 'm-monitor-url', 'm-input-price', 'm-output-price'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const currencyEl = document.getElementById('m-price-currency');
    if (currencyEl) currencyEl.value = 'CNY';
    const scopeEl = document.getElementById('m-scope');
    if (scopeEl) scopeEl.value = 'personal';
    const supportsVisionEl = document.getElementById('m-supports-vision');
    if (supportsVisionEl) supportsVisionEl.checked = false;
    const supportsReasoningEl = document.getElementById('m-supports-reasoning');
    if (supportsReasoningEl) supportsReasoningEl.checked = false;
    const keyInput = document.getElementById('m-key');
    if (keyInput) keyInput.type = 'password';
};

window.updateModelScopeControls = (model = null) => {
    const isSuperAdmin = currentUser?.username === 'admin';
    const scopeWrap = document.getElementById('m-scope-wrap');
    const scopeUnitsRow = scopeWrap?.closest('.model-scope-units-row');
    const scopeEl = document.getElementById('m-scope');
    const unitsEl = document.getElementById('m-units');
    if (scopeWrap) scopeWrap.classList.toggle('hidden', !isSuperAdmin);
    if (scopeUnitsRow) scopeUnitsRow.classList.toggle('scope-hidden', !isSuperAdmin);
    if (scopeEl) {
        scopeEl.disabled = Boolean(model?.id);
        if (!isSuperAdmin) scopeEl.value = 'personal';
    }
    const isGlobal = isSuperAdmin && (scopeEl?.value === 'global' || (model && !model.user_id));
    if (unitsEl) {
        unitsEl.disabled = !isGlobal;
        unitsEl.placeholder = isGlobal ? '多个部门用逗号分隔，留空表示全部可见' : '个人模型不需要设置可见部门';
        if (!isGlobal) unitsEl.value = '';
    }
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
        const pwd = await window.showInputPrompt({
            title: '安全验证',
            message: '请输入当前登录密码以查看明文密钥。',
            type: 'password',
            placeholder: '当前登录密码',
            autocomplete: 'current-password'
        });
        if (!pwd) return;

        try {
            const res = await apiFetch(`${API_BASE}/models/${modelId}/key`, {
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
        daily_token_limit: parseTokenAmount(document.getElementById('m-daily-limit').value),
        allowed_units: document.getElementById('m-units').value,
        temperature: document.getElementById('m-temp') ? document.getElementById('m-temp').value : undefined,
        max_input_tokens: document.getElementById('m-max-input-tokens') ? parseTokenAmount(document.getElementById('m-max-input-tokens').value) || undefined : undefined,
        max_tokens: document.getElementById('m-max-tokens') ? parseTokenAmount(document.getElementById('m-max-tokens').value) || undefined : undefined,
        max_concurrent: document.getElementById('m-max-concurrent') ? Number(document.getElementById('m-max-concurrent').value || 0) : 0,
        monitor_url: document.getElementById('m-monitor-url') ? document.getElementById('m-monitor-url').value.trim() : '',
        supports_vision: document.getElementById('m-supports-vision')?.checked ? 1 : 0,
        supports_reasoning: document.getElementById('m-supports-reasoning')?.checked ? 1 : 0,
        input_price_per_million: Number(document.getElementById('m-input-price')?.value || 0),
        output_price_per_million: Number(document.getElementById('m-output-price')?.value || 0),
        price_currency: (document.getElementById('m-price-currency')?.value || 'CNY').trim(),
        scope: currentUser?.username === 'admin' ? (document.getElementById('m-scope')?.value || 'personal') : 'personal'
    };
    if (!payload.name || !payload.url) return showToast('模型名称和接口地址不能为空', 'error');
    const btn = document.getElementById('m-submit-btn');
    const oldText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '正在保存...';
    try {
        const res = await apiFetch(API_BASE + (id ? `/models/${id}` : '/models'), {
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
        const res = await apiFetch(`${API_BASE}/models/${id}`, { method: 'DELETE', headers: authHeaders() });
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
        const res = await apiFetch(`${API_BASE}/admin/settings`, {
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
