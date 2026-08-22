// --- 认证逻辑 ---
let isLogin = true;
let allowPublicRegistration = false;
window.allowPublicRegistration = false;
function syncAuthModeClass() {
    const authContainer = document.getElementById('auth-container');
    if (!authContainer) return;
    authContainer.classList.toggle('is-login-mode', isLogin);
    authContainer.classList.toggle('is-register-mode', !isLogin);
}
window.setPublicRegistrationState = (enabled) => {
    allowPublicRegistration = enabled === true;
    window.allowPublicRegistration = allowPublicRegistration;
    document.getElementById('auth-toggle')?.classList.toggle('hidden', !allowPublicRegistration);
};
window.PASSWORD_RULE_DESCRIPTION = '至少 8 位，并同时包含字母和数字';
window.getPasswordValidationMessage = (password, label = '密码') => {
    const value = String(password || '');
    const missing = [];
    if (!value) return `请输入${label}。${label}要求：${window.PASSWORD_RULE_DESCRIPTION}。`;
    if (value.length < 8) missing.push('至少 8 位');
    if (!/[A-Za-z]/.test(value)) missing.push('包含字母');
    if (!/[0-9]/.test(value)) missing.push('包含数字');
    return missing.length ? `${label}不符合要求：请确保${missing.join('、')}。完整规则：${window.PASSWORD_RULE_DESCRIPTION}。` : '';
};

window.toggleAuthPassword = (inputId, iconId) => {
    const input = document.getElementById(inputId);
    const icon = document.getElementById(iconId);
    if (!input || !icon) return;
    if (input.type === 'password') {
        input.type = 'text';
        PivotSafeHtml.setHtml(icon, '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>');
    } else {
        input.type = 'password';
        PivotSafeHtml.setHtml(icon, '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />');
    }
};

async function loadAuthConfig() {
    try {
        const res = await apiFetch(API_BASE + '/auth/config');
        const data = await res.json();
        window.setPublicRegistrationState(data.allowPublicRegistration === true);
        window.publicUrl = data.publicUrl || '';
    } catch (e) {
        window.setPublicRegistrationState(false);
    }
}

// 显式定义界面显示控制逻辑
window.showAuth = () => {
    const authContainer = document.getElementById('auth-container');
    authContainer?.classList.remove('hidden');
    syncAuthModeClass();
    document.getElementById('app').classList.add('hidden');
    document.body?.classList.add('auth-active');
    document.body?.classList.remove('is-main-workspace-full');
    document.body?.setAttribute('data-active-workspace', 'auth');
    document.querySelector('.chat-container')?.setAttribute('data-active-workspace', 'chat');
    if (window.updateContextUsage) window.updateContextUsage(null);
    window.loadLoginAnnouncements?.();
};

window.showApp = (options = {}) => {
    if (!currentUser) return;
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.body?.classList.remove('auth-active');
    const restoreWorkspace = options.restoreWorkspace !== false;
    if (restoreWorkspace && window.restoreMainWorkspaceAfterLogin) {
        Promise.resolve(window.restoreMainWorkspaceAfterLogin()).catch(err => {
            console.error('恢复主工作区失败:', err);
            window.showMainWorkspace?.('chat');
        });
    } else if (window.showMainWorkspace) {
        window.showMainWorkspace('chat');
    }

    // 更新用户信息显示
    const userDisplay = document.getElementById('user-info') || document.getElementById('current-username');
    const displayName = currentUser.nickname || currentUser.username;
    if (userDisplay) {
        userDisplay.innerText = displayName;
        userDisplay.title = currentUser.nickname && currentUser.username && currentUser.nickname !== currentUser.username
            ? `${currentUser.nickname} (${currentUser.username})`
            : displayName;
    }
    
    const isSuperAdmin = isSuperAdminUser(currentUser);
    const isAdminRole = isAdminUser(currentUser);
    const tag = document.getElementById('admin-tag');
    if (tag) {
        tag.classList.toggle('hidden', !isAdminRole);
        tag.classList.toggle('is-super-admin', isSuperAdmin);
        tag.classList.toggle('is-role-admin', isAdminRole && !isSuperAdmin);
        const label = getPermissionLabel(currentUser);
        tag.title = label;
        tag.setAttribute('aria-label', label);
    }

    if (isAdminRole) {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
        const btn = document.getElementById('admin-panel-btn');
        if (btn) btn.classList.remove('hidden');
    }

    // 登录成功后加载必要数据
    if (window.loadSessions) window.loadSessions();
    if (window.loadSettings) window.loadSettings();
    if (window.refreshModelSelector) window.refreshModelSelector();
    if (window.initAgentRealtime) window.initAgentRealtime();
    if (window.initAnnouncements) window.initAnnouncements();
    if (window.loadKnowledgeCollections) window.loadKnowledgeCollections();
    if (window.refreshRagTagControlsForSelectedCollections) window.refreshRagTagControlsForSelectedCollections();
};

document.getElementById('auth-toggle')?.addEventListener('click', () => {
    if (!allowPublicRegistration) return showToast('当前已关闭公开注册，请联系管理员创建账号', 'error');
    isLogin = !isLogin;
    syncAuthModeClass();
    const authTitleAction = document.getElementById('auth-title-action');
    if (authTitleAction) authTitleAction.innerText = isLogin ? '欢迎登录' : '注册账号';
    const authModeLabel = document.getElementById('auth-mode-label');
    if (authModeLabel) authModeLabel.innerText = isLogin ? '使用账号进入工作台' : '创建 Pivot 智枢账号';
    const authToggle = document.getElementById('auth-toggle');
    if (authToggle) authToggle.innerText = isLogin ? '没有账号？点击注册' : '已有账号？点击登录';
    const authSubmit = document.getElementById('auth-submit');
    const authSubmitLabel = authSubmit?.querySelector('span');
    if (authSubmitLabel) authSubmitLabel.innerText = isLogin ? '进入系统' : '立即注册';
    else if (authSubmit) authSubmit.innerText = isLogin ? '进入系统' : '立即注册';
    const passwordInput = document.getElementById('password');
    if (passwordInput) passwordInput.placeholder = isLogin ? '请输入密码' : '密码（至少8位，包含字母和数字）';
    document.querySelectorAll('.reg-only').forEach(el => el.classList.toggle('hidden', isLogin));
});

document.getElementById('auth-submit')?.addEventListener('click', async () => {
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const nicknameInput = document.getElementById('nickname');
    const unitInput = document.getElementById('unit');
    const confirmPwInput = document.getElementById('confirm-password');
    if (!usernameInput || !passwordInput || !nicknameInput || !unitInput || !confirmPwInput) {
        return showToast('登录表单未加载完成，请刷新页面', 'error');
    }

    const username = usernameInput.value;
    const password = passwordInput.value;
    const nickname = nicknameInput.value;
    const unit = unitInput.value;
    const confirmPw = confirmPwInput.value;

    if (!username || !password) return showToast('请输入账号密码');
    
    if (!isLogin) {
        if (password !== confirmPw) return showToast('两次输入的密码不一致', 'error');
        const passwordError = window.getPasswordValidationMessage(password);
        if (passwordError) return showToast(passwordError, 'error');
        if (!nickname) return showToast('请输入显示名称', 'error');
        if (!/^[\u4e00-\u9fa5]+$/.test(nickname)) return showToast('显示名称必须是中文姓名', 'error');
        if (!unit) return showToast('请输入工作单位', 'error');
    }

    const path = isLogin ? '/auth/login' : '/auth/register';
    const body = isLogin ? { username, password } : { username, password, nickname, unit };

    try {
        const res = await apiFetch(API_BASE + path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        if (isLogin) {
            setCsrfToken(data.csrfToken || '');
            currentUser = data.user;
            localStorage.removeItem('pivot_token');
            showApp({ restoreWorkspace: false });
        } else {
            showToast('注册成功，请登录');
            document.getElementById('auth-toggle').click();
        }
    } catch (e) { showToast(e.message, 'error'); }
});

window.logout = async () => {
    if (window.closeAgentRealtime) window.closeAgentRealtime();
    if (window.stopAnnouncements) window.stopAnnouncements();
    try {
        await apiFetch(API_BASE + '/auth/logout', {
            method: 'POST'
        });
    } catch (_) {}
    localStorage.removeItem('pivot_token');
    sessionStorage.clear();
    setCsrfToken('');
    currentUser = null;
    location.reload();
};

// --- 表单交互体验优化：支持回车键 (Enter) 提交 ---
document.getElementById('auth-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    document.getElementById('auth-submit')?.click();
});

document.querySelectorAll('#auth-form input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('auth-submit')?.click();
        }
    });
});

loadAuthConfig();

// --- 账户安全与 API Key 管理 ---

window.loadApiKeys = async function() {
    try {
        document.querySelectorAll('.super-admin-only').forEach(el => {
            el.classList.toggle('hidden', !isSuperAdminUser());
        });
        const res = await apiFetch(`${API_BASE}/auth/keys`);
        if (!res.ok) throw new Error('加载 API Key 失败');
        const data = await res.json();
        const keys = Array.isArray(data) ? data : (data.keys || []);
        window.updateApiAccessState?.(data.apiAccessEnabled === true);
        const body = document.getElementById('api-keys-body');
        if (keys.length === 0) {
            renderTableMessage(body, 9, '暂无 API Key，点击右上角新建', { padding: '30px', color: 'var(--text-muted)' });
        } else {
            PivotSafeHtml.setHtml(body, keys.map((k, index) => `
                <tr>
                    <td class="text-center">${index + 1}</td>
                    <td>${escapeHtml(k.name)}</td>
                    <td style="font-family: monospace; font-size: 0.85rem;">${k.key.length > 12 ? k.key.slice(0, 3) + '...' + k.key.slice(-4) : k.key}</td>
                    <td class="text-center" title="${Number(k.input_tokens || 0).toLocaleString()} Tokens" style="font-size: 0.85rem; font-weight: 600; color: var(--primary);">${formatTokenCount(k.input_tokens)}</td>
                    <td class="text-center" title="${Number(k.output_tokens || 0).toLocaleString()} Tokens" style="font-size: 0.85rem; font-weight: 600; color: var(--primary);">${formatTokenCount(k.output_tokens)}</td>
                    <td class="text-center" title="${Number(k.usage_tokens || 0).toLocaleString()} Tokens" style="font-size: 0.85rem; font-weight: 600; color: var(--primary);">${formatTokenCount(k.usage_tokens)}</td>
                    <td style="font-size: 0.8rem; color: var(--text-muted);">${formatDateToCN(k.created_at)}</td>
                    <td style="font-size: 0.8rem; color: var(--text-muted);">${k.last_used_at ? formatDateToCN(k.last_used_at) : '从未'}</td>
                    <td class="text-center">
                        <button class="btn-danger" type="button" title="删除" data-api-key-action="delete" data-api-key-id="${k.id}">删除</button>
                    </td>
                </tr>
            `).join(''));
        }
        // 同步加载可用模型信息
        window.loadAvailableModels();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

document.getElementById('api-keys-body')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-api-key-action="delete"]');
    if (!button) return;
    window.deleteApiKey(button.dataset.apiKeyId);
});

window.openApiCallLogsModal = function() {
    if (!isSuperAdminUser()) return;
    const modal = document.getElementById('api-call-logs-modal');
    modal?.classList.remove('hidden');
    modal?.setAttribute('aria-hidden', 'false');
    document.getElementById('api-call-log-search')?.focus();
    window.loadApiCallLogs?.(1);
}

window.closeApiCallLogsModal = function() {
    const modal = document.getElementById('api-call-logs-modal');
    modal?.classList.add('hidden');
    modal?.setAttribute('aria-hidden', 'true');
}

window.loadApiCallLogs = async function(page = 1) {
    if (!isSuperAdminUser()) return;
    pageState.apiCallLogs = page;
    const body = document.getElementById('api-call-logs-body');
    if (!body) return;
    const keyword = document.getElementById('api-call-log-search')?.value || '';
    try {
        const limit = pageState.limit || 15;
        const params = new URLSearchParams({ page, limit, keyword });
        const res = await apiFetch(`${API_BASE}/stats/api-call-logs?${params.toString()}`);
        if (!res.ok) throw new Error('加载第三方 API 调用记录失败');
        const { data, total } = await res.json();
        if (!data.length) {
            renderTableMessage(body, 10, '暂无第三方 API 调用记录', { color: 'var(--text-muted)' });
            renderPagination('apiCallLogs', total, page);
            return;
        }
        PivotSafeHtml.setHtml(body, data.map((row, idx) => {
            const requestText = row.request_messages || '';
            const responseText = row.response_text || row.error_message || '';
            const statusText = row.status === 'error' ? '失败' : '成功';
            const statusColor = row.status === 'error' ? 'var(--danger)' : 'var(--primary)';
            return `
                <tr>
                    <td class="text-center">${(page - 1) * limit + idx + 1}</td>
                    <td title="${escapeHtml(formatDateToCN(row.created_at))}">${escapeHtml(formatDateToCN(row.created_at))}</td>
                    <td title="${escapeHtml(row.nickname || row.username)}">${escapeHtml(row.nickname || row.username)}</td>
                    <td title="${escapeHtml(row.api_key_name || row.key_preview || '-')}">${escapeHtml(row.api_key_name || row.key_preview || '-')}</td>
                    <td title="${escapeHtml(row.model_name || '-')}">${escapeHtml(row.model_name || '-')}</td>
                    <td class="text-center" title="${Number(row.input_tokens || 0).toLocaleString()}">${formatTokenCount(row.input_tokens)}</td>
                    <td class="text-center" title="${Number(row.output_tokens || 0).toLocaleString()}">${formatTokenCount(row.output_tokens)}</td>
                    <td title="${escapeHtml(requestText)}">${escapeHtml(requestText)}</td>
                    <td title="${escapeHtml(responseText)}">${escapeHtml(responseText)}</td>
                    <td class="text-center" style="color:${statusColor};font-weight:600;" title="${escapeHtml(row.error_message || statusText)}">${statusText}</td>
                </tr>
            `;
        }).join(''));
        renderPagination('apiCallLogs', total, page);
    } catch (e) {
        renderTableMessage(body, 10, e.message, { color: 'var(--danger)' });
    }
}

window.loadAvailableModels = async function() {
    const listEl = document.getElementById('available-models-list');
    if (!listEl) return;
    if (window.apiAccessEnabled === false) {
        PivotSafeHtml.setHtml(listEl, '<span style="color: var(--text-muted);">API 接入已关闭，暂无外部调用模型</span>');
        return;
    }
    try {
        const res = await apiFetch(`${API_BASE}/models/available`);
        if (!res.ok) throw new Error('加载可用模型失败');
        const models = await res.json();
        if (models.length === 0) {
            PivotSafeHtml.setHtml(listEl, '<span style="color: var(--text-muted);">暂无可用全局模型</span>');
            return;
        }
        const renderCapabilityText = (model) => {
            if (model.type === 'embedding') {
                return model.source === 'personal' ? '向量 · 个人配置' : '向量 · 系统配置';
            }
            const labels = ['聊天'];
            if (Number(model.supports_vision || 0) === 1 || model.capabilities?.includes('vision')) labels.push('视觉');
            if (Number(model.supports_reasoning || 0) === 1 || model.capabilities?.includes('reasoning')) labels.push('推理');
            return labels.join(' · ');
        };
        const renderModelChip = (model) => {
            const isEmbedding = model.type === 'embedding';
            const endpoint = model.endpoint || (isEmbedding ? '/v1/embeddings' : '/v1/chat/completions');
            const modelName = model.model_name || model.id;
            return `
                <code class="api-model-chip ${isEmbedding ? 'is-embedding' : 'is-chat'}" title="友好名称: ${escapeHtml(model.name || modelName)}&#10;接口: ${escapeHtml(endpoint)}">
                    <span>${escapeHtml(modelName)}</span>
                    <small>${escapeHtml(renderCapabilityText(model))}</small>
                </code>
            `;
        };
        // 简化展示：只显示模型标识 (model 参数值)，使用标签形式排列
        PivotSafeHtml.setHtml(listEl, `
            <div class="api-model-chip-list">
                ${models.map(renderModelChip).join('')}
            </div>
            <p class="api-model-note">* 以上为外部调用时 model 参数需填写的具体值；聊天对话使用 /v1/chat/completions，代码补全使用 /v1/completions（支持 prompt / input / prefix / suffix），向量生成使用 /v1/embeddings。</p>
        `);
    } catch (e) {
        PivotSafeHtml.setHtml(listEl, `<span style="color: var(--danger);">加载失败: ${escapeHtml(e.message)}</span>`);
    }
}

window.createApiKey = function() {
    if (window.apiAccessEnabled === false) {
        showToast('API 接入已关闭，暂不能新建密钥', 'error');
        return;
    }
    document.getElementById('new-key-name').value = '我的第三方密钥';
    document.getElementById('key-input-view').classList.remove('hidden');
    document.getElementById('key-result-view').classList.add('hidden');
    const modal = document.getElementById('key-modal');
    modal?.classList.remove('hidden');
    modal?.setAttribute('aria-hidden', 'false');
    document.getElementById('new-key-name')?.focus();
}

window.confirmCreateKey = async function() {
    const button = document.querySelector('[data-static-action="confirm-create-key"]');
    const name = document.getElementById('new-key-name').value || '未命名密钥';
    if (button) {
        button.disabled = true;
        button.dataset.originalText = button.innerText;
        button.innerText = '正在创建…';
    }
    try {
        const res = await apiFetch(`${API_BASE}/auth/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `创建密钥失败（HTTP ${res.status}）`);
        
        // 显示结果视图
        document.getElementById('generated-key-text').innerText = data.key;
        document.getElementById('key-input-view').classList.add('hidden');
        document.getElementById('key-result-view').classList.remove('hidden');
        
        loadApiKeys();
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.innerText = button.dataset.originalText || '确定创建';
        }
    }
}

window.closeKeyModal = function() {
    const modal = document.getElementById('key-modal');
    modal?.classList.add('hidden');
    modal?.setAttribute('aria-hidden', 'true');
}

window.copyGeneratedKey = function() {
    const text = document.getElementById('generated-key-text').innerText;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('密钥已复制到剪贴板');
        }).catch(err => {
            console.error('写入剪贴板失败:', err);
            fallbackCopyTextToClipboard(text);
        });
    } else {
        fallbackCopyTextToClipboard(text);
    }
}

function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    // 确保不可见且不影响布局
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showToast('密钥已复制到剪贴板 (兼容模式)');
        } else {
            showToast('复制失败，请手动选择复制', 'error');
        }
    } catch (err) {
        showToast('复制异常，请手动选择复制', 'error');
    }
    document.body.removeChild(textArea);
}

window.deleteApiKey = async function(id) {
    showConfirm('删除 API Key', '确定要删除此 API Key 吗？相关服务将无法再通过此密钥访问。', async () => {
        try {
            const res = await apiFetch(`${API_BASE}/auth/keys/${id}`, { method: 'DELETE' });
            if (res.ok) {
                showToast('密钥已注销');
                loadApiKeys();
            }
        } catch (e) {
            showToast('操作失败', 'error');
        }
    });
}

window.updatePassword = async function() {
    const oldPassword = document.getElementById('pw-old').value;
    const newPassword = document.getElementById('pw-new').value;
    const confirmPassword = document.getElementById('pw-confirm').value;

    if (!oldPassword || !newPassword || !confirmPassword) return showToast('请填写所有密码项');
    if (newPassword !== confirmPassword) return showToast('新密码两次输入不一致', 'error');
    const passwordError = window.getPasswordValidationMessage?.(newPassword, '新密码') || '';
    if (passwordError) return showToast(passwordError, 'error');

    const button = document.getElementById('pw-update-btn');
    if (button) {
        button.disabled = true;
        button.dataset.originalText = button.innerText;
        button.innerText = '正在更新…';
    }
    try {
        const res = await apiFetch(`${API_BASE}/settings/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `密码修改失败（HTTP ${res.status}）`);
        document.getElementById('pw-old').value = '';
        document.getElementById('pw-new').value = '';
        document.getElementById('pw-confirm').value = '';
        showToast('密码修改成功，请重新登录');
        setTimeout(() => window.logout(), 1500);
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.innerText = button.dataset.originalText || '立即更新密码';
        }
    }
}
