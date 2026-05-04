// --- 认证逻辑 ---
let isLogin = true;
let allowPublicRegistration = false;

async function loadAuthConfig() {
    try {
        const res = await fetch(API_BASE + '/auth/config');
        const data = await res.json();
        allowPublicRegistration = data.allowPublicRegistration === true;
        if (!allowPublicRegistration) {
            document.getElementById('auth-toggle').classList.add('hidden');
        }
    } catch (e) {
        allowPublicRegistration = false;
        document.getElementById('auth-toggle').classList.add('hidden');
    }
}

document.getElementById('auth-toggle').onclick = () => {
    if (!allowPublicRegistration) return showToast('企业模式已关闭公开注册，请联系管理员创建账号', 'error');
    isLogin = !isLogin;
    document.getElementById('auth-title').innerText = isLogin ? '智枢' : '智枢 - 注册账号';
    document.getElementById('auth-toggle').innerText = isLogin ? '没有账号？点击注册' : '已有账号？点击登录';
    document.getElementById('auth-submit').innerText = isLogin ? '进入系统' : '立即注册';
    document.querySelectorAll('.reg-only').forEach(el => el.classList.toggle('hidden', isLogin));
};

document.getElementById('auth-submit').onclick = async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const nickname = document.getElementById('nickname').value;
    const unit = document.getElementById('unit').value;
    const confirmPw = document.getElementById('confirm-password').value;

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
            token = null;
            currentUser = data.user;
            localStorage.removeItem('lite_chat_token');
            showApp();
        } else {
            showToast('注册成功，请登录');
            document.getElementById('auth-toggle').click();
        }
    } catch (e) { showToast(e.message, 'error'); }
};

document.getElementById('logout-btn').onclick = () => {
    fetch(API_BASE + '/auth/logout', {
        method: 'POST',
        headers: authHeaders()
    }).catch(() => {});
    localStorage.removeItem('lite_chat_token');
    token = null;
    location.reload();
};

// --- 表单交互体验优化：支持回车键 (Enter) 提交 ---
document.getElementById('auth-container').addEventListener('keydown', (e) => {
    // 监听任意输入框的回车键事件
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault(); // 阻止默认的回车行为
        document.getElementById('auth-submit').click(); // 触发按钮点击
    }
});

loadAuthConfig();
