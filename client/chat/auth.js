// --- 认证逻辑 ---
let isLogin = true;
let allowPublicRegistration = false;

window.toggleAuthPassword = (inputId, iconId) => {
    const input = document.getElementById(inputId);
    const icon = document.getElementById(iconId);
    if (!input || !icon) return;
    if (input.type === 'password') {
        input.type = 'text';
        icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
    } else {
        input.type = 'password';
        icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />';
    }
};

async function loadAuthConfig() {
    try {
        const res = await fetch(API_BASE + '/auth/config');
        const data = await res.json();
        allowPublicRegistration = data.allowPublicRegistration === true;
        window.publicUrl = data.publicUrl || '';
        if (!allowPublicRegistration) {
            document.getElementById('auth-toggle')?.classList.add('hidden');
        }
    } catch (e) {
        allowPublicRegistration = false;
        document.getElementById('auth-toggle')?.classList.add('hidden');
    }
}

// 显式定义界面显示控制逻辑
window.showAuth = () => {
    document.getElementById('auth-container').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
};

window.showApp = () => {
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    // 登录成功后加载必要数据
    if (window.loadSessions) window.loadSessions();
    if (window.loadSettings) window.loadSettings();
};

document.getElementById('auth-toggle')?.addEventListener('click', () => {
    if (!allowPublicRegistration) return showToast('当前已关闭公开注册，请联系管理员创建账号', 'error');
    isLogin = !isLogin;
    document.getElementById('auth-title').innerText = isLogin ? '智枢' : '智枢 - 注册账号';
    document.getElementById('auth-toggle').innerText = isLogin ? '没有账号？点击注册' : '已有账号？点击登录';
    document.getElementById('auth-submit').innerText = isLogin ? '进入系统' : '立即注册';
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
        if (!nickname) return showToast('请输入显示名称', 'error');
        if (!/^[\u4e00-\u9fa5]+$/.test(nickname)) return showToast('显示名称必须是中文姓名', 'error');
        if (!unit) return showToast('请输入工作单位', 'error');
    }

    const path = isLogin ? '/auth/login' : '/auth/register';
    const body = isLogin ? { username, password } : { username, password, nickname, unit };

    try {
        const res = await fetch(API_BASE + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        if (isLogin) {
            setCsrfToken(data.csrfToken || '');
            currentUser = data.user;
            localStorage.removeItem('pivot_token');
            showApp();
        } else {
            showToast('注册成功，请登录');
            document.getElementById('auth-toggle').click();
        }
    } catch (e) { showToast(e.message, 'error'); }
});

window.logout = () => {
    apiFetch(API_BASE + '/auth/logout', {
        method: 'POST'
    }).catch(() => {});
    localStorage.removeItem('pivot_token');
    setCsrfToken('');
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
        const res = await apiFetch(`${API_BASE}/auth/keys`);
        if (!res.ok) throw new Error('加载 API Key 失败');
        const data = await res.json();
        const body = document.getElementById('api-keys-body');
        if (data.length === 0) {
            body.innerHTML = '<tr><td colspan="6" class="text-center" style="padding: 30px; color: var(--text-muted);">暂无 API Key，点击右上角新建</td></tr>';
        } else {
            body.innerHTML = data.map((k, index) => `
                <tr>
                    <td class="text-center">${index + 1}</td>
                    <td>${escapeHtml(k.name)}</td>
                    <td style="font-family: monospace; font-size: 0.85rem;">${k.key.length > 12 ? k.key.slice(0, 3) + '...' + k.key.slice(-4) : k.key}</td>
                    <td style="font-size: 0.85rem; font-weight: 600; color: var(--primary);">${(k.usage_tokens || 0).toLocaleString()} <small style="font-weight: 400; color: var(--text-muted);">Tokens</small></td>
                    <td style="font-size: 0.8rem; color: var(--text-muted);">${formatDateToCN(k.created_at)}</td>
                    <td style="font-size: 0.8rem; color: var(--text-muted);">${k.last_used_at ? formatDateToCN(k.last_used_at) : '从未'}</td>
                    <td class="text-center">
                        <button onclick="window.deleteApiKey(${k.id})" class="btn-icon" style="color: var(--danger);" title="删除">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
                        </button>
                    </td>
                </tr>
            `).join('');
        }
        // 同步加载可用模型信息
        window.loadAvailableModels();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

window.loadAvailableModels = async function() {
    const listEl = document.getElementById('available-models-list');
    if (!listEl) return;
    try {
        const res = await apiFetch(`${API_BASE}/models/available`);
        if (!res.ok) throw new Error('加载可用模型失败');
        const models = await res.json();
        if (models.length === 0) {
            listEl.innerHTML = '<span style="color: var(--text-muted);">暂无可用全局模型</span>';
            return;
        }
        // 简化展示：只显示模型标识 (model 参数值)，使用标签形式排列
        listEl.innerHTML = `
            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">
                ${models.map(m => `
                    <code style="background: rgba(99, 102, 241, 0.06); padding: 4px 12px; border-radius: 6px; color: #6366f1; font-family: 'Fira Code', monospace; font-size: 0.85rem; border: 1px solid rgba(99, 102, 241, 0.15);" title="友好名称: ${escapeHtml(m.name)}">${escapeHtml(m.model_name || m.id)}</code>
                `).join('')}
            </div>
            <p style="margin-top: 12px; font-size: 0.75rem; color: var(--text-muted);">* 以上为外部调用时 model 参数需填写的具体值</p>
        `;
    } catch (e) {
        listEl.innerHTML = `<span style="color: var(--danger);">加载失败: ${escapeHtml(e.message)}</span>`;
    }
}

window.createApiKey = function() {
    document.getElementById('new-key-name').value = '我的第三方密钥';
    document.getElementById('key-input-view').classList.remove('hidden');
    document.getElementById('key-result-view').classList.add('hidden');
    document.getElementById('key-modal').classList.remove('hidden');
}

window.confirmCreateKey = async function() {
    const name = document.getElementById('new-key-name').value || '未命名密钥';
    try {
        const res = await apiFetch(`${API_BASE}/auth/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        // 显示结果视图
        document.getElementById('generated-key-text').innerText = data.key;
        document.getElementById('key-input-view').classList.add('hidden');
        document.getElementById('key-result-view').classList.remove('hidden');
        
        loadApiKeys();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

window.closeKeyModal = function() {
    document.getElementById('key-modal').classList.add('hidden');
}

window.copyGeneratedKey = function() {
    const text = document.getElementById('generated-key-text').innerText;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('密钥已复制到剪贴板');
        }).catch(err => {
            console.error('Clipboard write failed:', err);
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
    if (!confirm('确定要删除此 API Key 吗？相关服务将无法再通过此密钥访问。')) return;
    try {
        const res = await apiFetch(`${API_BASE}/auth/keys/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('密钥已注销');
            loadApiKeys();
        }
    } catch (e) {
        showToast('操作失败', 'error');
    }
}

window.updatePassword = async function() {
    const oldPassword = document.getElementById('pw-old').value;
    const newPassword = document.getElementById('pw-new').value;
    const confirmPassword = document.getElementById('pw-confirm').value;

    if (!oldPassword || !newPassword || !confirmPassword) return showToast('请填写所有密码项');
    if (newPassword !== confirmPassword) return showToast('新密码两次输入不一致', 'error');
    if (newPassword.length < 8) return showToast('新密码至少需要 8 位', 'error');

    try {
        const res = await apiFetch(`${API_BASE}/settings/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        showToast('密码修改成功，请重新登录');
        setTimeout(() => window.logout(), 1500);
    } catch (e) {
        showToast(e.message, 'error');
    }
}
