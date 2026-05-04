/* 对话页面逻辑 Chat Page Logic */

const API_BASE = '/api';
const APP_NAME = '智枢 Pivot';
const APP_VERSION = 'v0.0.4';
const APP_COPYRIGHT = `© ${new Date().getFullYear()} ${APP_NAME}. 保留所有权利。`;
let token = localStorage.getItem('pivot_token');
if (token === 'null') token = null;
let currentUser = null;
let currentSessionId = null;

function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

// 初始化时检查登录状态
async function checkLogin() {
    try {
        const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
        if (res.ok) {
            const data = await res.json();
            currentUser = data.user;
            showApp();
        } else {
            localStorage.removeItem('pivot_token');
            token = null;
            showAuth();
        }
    } catch (e) {
        console.error('自动登录失败:', e);
        showAuth();
    }
}
