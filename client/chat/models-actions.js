// --- 模型管理动作模块 ---
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
        context_window_tokens: document.getElementById('m-context-window-tokens') ? parseTokenAmount(document.getElementById('m-context-window-tokens').value) || undefined : undefined,
        max_concurrent: document.getElementById('m-max-concurrent') ? Number(document.getElementById('m-max-concurrent').value || 0) : 0,
        monitor_url: document.getElementById('m-monitor-url') ? document.getElementById('m-monitor-url').value.trim() : '',
        supports_vision: document.getElementById('m-supports-vision')?.checked ? 1 : 0,
        supports_reasoning: document.getElementById('m-supports-reasoning')?.checked ? 1 : 0,
        disable_chat_thinking: document.getElementById('m-disable-chat-thinking')?.checked ? 1 : 0,
        input_price_per_million: Number(document.getElementById('m-input-price')?.value || 0),
        output_price_per_million: Number(document.getElementById('m-output-price')?.value || 0),
        price_currency: (document.getElementById('m-price-currency')?.value || 'CNY').trim(),
        scope: isSuperAdminUser() ? (document.getElementById('m-scope')?.value || 'personal') : 'personal'
    };
    if (!payload.name || !payload.url) return showToast('模型名称和接口地址不能为空', 'error');
    // 上下文关系校验（后端仍会权威校验）：输入/输出上限须小于上下文窗口。
    if (payload.context_window_tokens) {
        if (payload.max_input_tokens && payload.max_input_tokens >= payload.context_window_tokens) {
            return showToast('输入 Token 上限应小于上下文窗口', 'error');
        }
        if (payload.max_tokens && payload.max_tokens >= payload.context_window_tokens) {
            return showToast('输出 Token 上限应小于上下文窗口', 'error');
        }
    }
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
