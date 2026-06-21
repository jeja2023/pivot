// --- 模型管理模块 Model Management ---
const pendingTests = new Set();

function formatModelPriceCurrency(value) {
    const raw = String(value || '').trim();
    if (!raw) return '人民币';
    return /[一-龥]/.test(raw) ? raw : '人民币';
}

function ensureModelCostFields() {
    if (document.getElementById('m-input-price')) return;
    const dailyInput = document.getElementById('m-daily-limit');
    const anchorRow = dailyInput?.closest('.model-form-row');
    if (!anchorRow) return;
    const row = document.createElement('div');
    row.className = 'model-form-row model-cost-row';
    row.innerHTML = `
        <div class="form-item">
            <label>输入单价（每百万 Token）</label>
            <input type="number" id="m-input-price" class="form-input" min="0" step="0.000001" placeholder="0 表示不统计成本">
        </div>
        <div class="form-item">
            <label>输出单价（每百万 Token）</label>
            <input type="number" id="m-output-price" class="form-input" min="0" step="0.000001" placeholder="0 表示不统计成本">
        </div>
        <div class="form-item">
            <label>计价币种</label>
            <select id="m-price-currency" class="form-input">
                <option value="人民币">人民币</option>
                <option value="美元">美元</option>
                <option value="欧元">欧元</option>
                <option value="港币">港币</option>
                <option value="日元">日元</option>
                <option value="英镑">英镑</option>
            </select>
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

function canTestModelConnection(model) {
    if (!model || !currentUser?.id) return false;
    if (String(model.user_id) === String(currentUser.id)) return true;
    return !model.user_id && isAdminUser();
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
        const isSuperAdmin = isSuperAdminUser();
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
        const priceCurrency = formatModelPriceCurrency(m.price_currency);

        return `
        <tr id="model-row-${m.id}">
            <td class="text-center">${(page - 1) * pageState.limit + idx + 1}</td>
            <td title="${escapeHtml(m.name)}">
                <div class="model-name-cell">
                    <span>${escapeHtml(m.name)}${m.user_id ? ' <small>(私有)</small>' : ' <small>(全局)</small>'}</span>
                </div>
            </td>
            <td title="${displayUrl}">${displayUrl}</td>
            <td title="${Number(m.daily_token_limit || 0).toLocaleString()} Tokens / ${escapeHtml(priceCurrency)} ${Number(m.input_price_per_million || 0)}/${Number(m.output_price_per_million || 0)}">${formatTokenAmount(m.daily_token_limit)} / <small>${escapeHtml(priceCurrency)} ${Number(m.input_price_per_million || 0)}/${Number(m.output_price_per_million || 0)}</small></td>
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

    data.filter(model => !canTestModelConnection(model)).forEach(model => {
        document.querySelector(`#model-row-${model.id} [data-model-action="test"]`)?.remove();
    });
    
    data.filter(canTestModelConnection).forEach(m => checkSingleModelStatus(m.id));
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
    const contextWindowTokensEl = document.getElementById('m-context-window-tokens');
    if (contextWindowTokensEl) contextWindowTokensEl.value = formatTokenInputValue(model.context_window_tokens);
    const maxConcurrentEl = document.getElementById('m-max-concurrent');
    if (maxConcurrentEl) maxConcurrentEl.value = model.max_concurrent || '';
    const monitorUrlEl = document.getElementById('m-monitor-url');
    if (monitorUrlEl) monitorUrlEl.value = model.monitor_url || '';
    const supportsVisionEl = document.getElementById('m-supports-vision');
    if (supportsVisionEl) supportsVisionEl.checked = Number(model.supports_vision || 0) === 1;
    const supportsReasoningEl = document.getElementById('m-supports-reasoning');
    if (supportsReasoningEl) supportsReasoningEl.checked = Number(model.supports_reasoning || 0) === 1;
    const chatThinkingEnabledEl = document.getElementById('m-chat-thinking-enabled');
    if (chatThinkingEnabledEl) chatThinkingEnabledEl.checked = Number(model.chat_thinking_enabled || 0) === 1;
    const inputPriceEl = document.getElementById('m-input-price');
    if (inputPriceEl) inputPriceEl.value = model.input_price_per_million || '';
    const outputPriceEl = document.getElementById('m-output-price');
    if (outputPriceEl) outputPriceEl.value = model.output_price_per_million || '';
    const currencyEl = document.getElementById('m-price-currency');
    if (currencyEl) currencyEl.value = formatModelPriceCurrency(model.price_currency);
    document.getElementById('model-modal-title').innerText = '编辑模型配置';
    window.updateModelScopeControls?.(model);
    document.getElementById('model-modal-container').classList.remove('hidden');
};

window.testExistingModel = async (model) => {
    if (!canTestModelConnection(model)) return showToast('无权测试该模型', 'error');
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
    ['m-id', 'm-name', 'm-url', 'm-model', 'm-key', 'm-daily-limit', 'm-units', 'm-temp', 'm-max-input-tokens', 'm-max-tokens', 'm-context-window-tokens', 'm-max-concurrent', 'm-monitor-url', 'm-input-price', 'm-output-price'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const currencyEl = document.getElementById('m-price-currency');
    if (currencyEl) currencyEl.value = '人民币';
    const scopeEl = document.getElementById('m-scope');
    if (scopeEl) scopeEl.value = 'personal';
    const supportsVisionEl = document.getElementById('m-supports-vision');
    if (supportsVisionEl) supportsVisionEl.checked = false;
    const supportsReasoningEl = document.getElementById('m-supports-reasoning');
    if (supportsReasoningEl) supportsReasoningEl.checked = false;
    const chatThinkingEnabledEl = document.getElementById('m-chat-thinking-enabled');
    if (chatThinkingEnabledEl) chatThinkingEnabledEl.checked = false;
    const keyInput = document.getElementById('m-key');
    if (keyInput) keyInput.type = 'password';
};

window.updateModelScopeControls = (model = null) => {
    const isSuperAdmin = isSuperAdminUser();
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
