/* 对话页面逻辑 Chat Page Logic */

/* exported API_BASE, APP_NAME, APP_VERSION, APP_COPYRIGHT, csrfToken, currentUser, currentSessionId, authHeaders, authFetch, apiFetch, checkLogin, setCsrfToken */
const API_BASE = '/api';
const APP_NAME = '智枢';
const appVersionTag = document.documentElement?.dataset?.appVersion || window.APP_VERSION_TAG || '';
const APP_VERSION = (appVersionTag && appVersionTag !== '__APP_VERSION__') ? appVersionTag : 'v0.0.64';
const APP_COPYRIGHT = `© ${new Date().getFullYear()} ${APP_NAME} ${APP_VERSION} 保留所有权利`;
localStorage.removeItem('pivot_token');
let csrfToken = sessionStorage.getItem('pivot_csrf_token') || '';
let currentUser = null;
let currentSessionId = null;

// 刷新状态管理
let isRefreshing = false;
let refreshQueue = [];

async function refreshAccessToken() {
    if (!isRefreshing) {
        isRefreshing = true;
        try {
            const refreshRes = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin' });
            if (!refreshRes.ok) throw new Error('Refresh failed');
            const refreshData = await refreshRes.json().catch(() => ({}));
            if (refreshData.csrfToken) {
                setCsrfToken(refreshData.csrfToken);
            }
            isRefreshing = false;
            refreshQueue.forEach(cb => cb(true));
            refreshQueue = [];
            return true;
        } catch (e) {
            isRefreshing = false;
            refreshQueue = [];
            throw e;
        }
    }

    return new Promise((resolve) => {
        refreshQueue.push(resolve);
    });
}

function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    return headers;
}

async function authFetch(url, options = {}) {
    return apiFetch(url, options);
}

// 通用请求包装器 (支持自动刷新)
async function apiFetch(url, options = {}) {
    const originalRequest = async () => {
        const headers = authHeaders(options.headers || {});
        return fetch(url, { credentials: 'same-origin', ...options, headers });
    };

    const res = await originalRequest();

    // 只有 401 且错误码为 TOKEN_EXPIRED 时才尝试刷新
    if (res.status === 401) {
        const data = await res.clone().json().catch(() => ({}));
        if (data.code === 'TOKEN_EXPIRED') {
            try {
                await refreshAccessToken();
                return originalRequest();
            } catch (e) {
                handleUnauthorized();
                throw e;
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
            if (data.authenticated === false) {
                if (data.code === 'TOKEN_EXPIRED') {
                    try {
                        await refreshAccessToken();
                        return checkLogin();
                    } catch (e) {
                        handleUnauthorized();
                        return;
                    }
                }
                handleUnauthorized();
                return;
            }
            if (data.csrfToken) setCsrfToken(data.csrfToken);
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
    setCsrfToken('');
    if (window.showAuth) window.showAuth();
}

function setCsrfToken(value) {
    csrfToken = value || '';
    if (csrfToken) {
        sessionStorage.setItem('pivot_csrf_token', csrfToken);
    } else {
        sessionStorage.removeItem('pivot_csrf_token');
    }
}
