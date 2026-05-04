/* 对话页面逻辑 Chat Page Logic */

const API_BASE = '/api';
const APP_NAME = '智枢 Pivot';
const APP_VERSION = 'v0.0.6';
const APP_COPYRIGHT = `© ${new Date().getFullYear()} ${APP_NAME}. 保留所有权利。`;
let token = localStorage.getItem('pivot_token');
let currentUser = null;
let currentSessionId = null;

// 刷新状态管理
let isRefreshing = false;
let refreshQueue = [];

function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (token && token !== 'null') headers.Authorization = `Bearer ${token}`;
    return headers;
}

// 通用请求包装器 (支持自动刷新)
async function apiFetch(url, options = {}) {
    const originalRequest = async () => {
        const headers = authHeaders(options.headers || {});
        return fetch(url, { ...options, headers });
    };

    const res = await originalRequest();

    // 只有 401 且错误码为 TOKEN_EXPIRED 时才尝试刷新
    if (res.status === 401) {
        const data = await res.clone().json().catch(() => ({}));
        if (data.code === 'TOKEN_EXPIRED') {
            if (!isRefreshing) {
                isRefreshing = true;
                try {
                    const refreshRes = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST' });
                    if (refreshRes.ok) {
                        const refreshData = await refreshRes.json();
                        token = refreshData.accessToken;
                        localStorage.setItem('pivot_token', token);
                        isRefreshing = false;
                        // 执行队列中的请求
                        refreshQueue.forEach(cb => cb(token));
                        refreshQueue = [];
                        // 重新发起原始请求
                        return originalRequest();
                    } else {
                        throw new Error('Refresh failed');
                    }
                } catch (e) {
                    isRefreshing = false;
                    refreshQueue = [];
                    handleUnauthorized();
                    throw e;
                }
            } else {
                // 等待正在进行的刷新
                return new Promise((resolve) => {
                    refreshQueue.push((newToken) => {
                        token = newToken;
                        resolve(originalRequest());
                    });
                });
            }
        }
    }

    return res;
}

// 初始化时检查登录状态
async function checkLogin() {
    try {
        const res = await apiFetch(`${API_BASE}/auth/me`);
        if (res.ok) {
            const data = await res.json();
            currentUser = data.user;
            if (window.showApp) window.showApp();
        } else {
            handleUnauthorized();
        }
    } catch (e) {
        console.error('自动登录失败:', e);
        handleUnauthorized();
    }
}

function handleUnauthorized() {
    localStorage.removeItem('pivot_token');
    token = null;
    if (window.showAuth) window.showAuth();
}
