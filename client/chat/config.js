/* 对话页面逻辑 Chat Page Logic */

/* exported API_BASE, APP_NAME, APP_VERSION, APP_COPYRIGHT, csrfToken, currentUser, currentSessionId, authHeaders, authFetch, apiFetch, checkLogin, setCsrfToken, isAdminUser, isSuperAdminUser, getPermissionTier, getPermissionLabel */
const API_BASE = '/api';
const APP_NAME = '智枢';
const appVersionTag = document.documentElement?.dataset?.appVersion || window.APP_VERSION_TAG || '';
const APP_VERSION = (appVersionTag && appVersionTag !== '__APP_VERSION__') ? appVersionTag : 'v0.0.67';
const APP_COPYRIGHT = `© ${new Date().getFullYear()} ${APP_NAME} ${APP_VERSION} 保留所有权利`;
localStorage.removeItem('pivot_token');
let csrfToken = sessionStorage.getItem('pivot_csrf_token') || '';
let currentUser = null;
let currentSessionId = null;

function isAdminUser(user = currentUser) {
    return user?.isAdmin === true || user?.is_admin === true || user?.role === 'admin';
}

function isSuperAdminUser(user = currentUser) {
    if (user?.isSuperAdmin === true || user?.is_super_admin === true) return true;
    return (user?.permissionTier || user?.permission_tier) === 'admin';
}

function getPermissionTier(user = currentUser) {
    if (user?.permissionTier) return user.permissionTier;
    if (user?.permission_tier) return user.permission_tier;
    if (isSuperAdminUser(user)) return 'admin';
    return isAdminUser(user) ? 'manager' : 'user';
}

function getPermissionLabel(user = currentUser) {
    if (user?.permissionLabel) return user.permissionLabel;
    if (user?.permission_label) return user.permission_label;
    const tier = getPermissionTier(user);
    if (tier === 'admin') return '系统管理员';
    if (tier === 'manager') return '管理员';
    return '用户';
}

// 刷新状态管理
const REFRESHABLE_AUTH_CODES = new Set(['TOKEN_EXPIRED', 'AUTH_MISSING', 'TOKEN_INVALID']);
const CSRF_INVALID_CODE = 'CSRF_INVALID';
const DEFAULT_API_TIMEOUT_MS = 30000;
const AUTH_REFRESH_TIMEOUT_MS = 15000;
let isRefreshing = false;
let refreshQueue = [];
let authFailureHandled = false;

function resolveRequestTimeout(options = {}, fallback = DEFAULT_API_TIMEOUT_MS) {
    if (Object.prototype.hasOwnProperty.call(options, 'timeoutMs')) {
        const value = Number(options.timeoutMs);
        return Number.isFinite(value) ? Math.max(0, value) : fallback;
    }
    // 流式请求已有自己的 AbortController，由调用方负责生命周期。
    if (options.signal) return 0;
    return fallback;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
    const timeout = Math.max(0, Number(timeoutMs) || 0);
    if (!timeout || typeof AbortController === 'undefined') return fetch(url, options);

    const controller = new AbortController();
    const externalSignal = options.signal;
    let timedOut = false;
    let timer = null;
    const abortFromCaller = () => {
        try {
            controller.abort(externalSignal?.reason);
        } catch (_) {
            controller.abort();
        }
    };

    if (externalSignal) {
        if (externalSignal.aborted) abortFromCaller();
        else externalSignal.addEventListener('abort', abortFromCaller, { once: true });
    }

    timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeout);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (!timedOut) throw error;
        const timeoutError = new Error(`请求超时（已等待 ${timeout} 毫秒）`);
        timeoutError.name = 'TimeoutError';
        timeoutError.code = 'CLIENT_REQUEST_TIMEOUT';
        timeoutError.cause = error;
        throw timeoutError;
    } finally {
        if (timer) clearTimeout(timer);
        externalSignal?.removeEventListener?.('abort', abortFromCaller);
    }
}

async function refreshAccessToken() {
    if (!isRefreshing) {
        isRefreshing = true;
        try {
            const refreshRes = await fetchWithTimeout(
                `${API_BASE}/auth/refresh`,
                { method: 'POST', credentials: 'same-origin' },
                AUTH_REFRESH_TIMEOUT_MS
            );
            if (!refreshRes.ok) throw new Error('令牌刷新失败');
            const refreshData = await refreshRes.json().catch(() => ({}));
            if (refreshData.csrfToken) {
                setCsrfToken(refreshData.csrfToken);
            }
            isRefreshing = false;
            flushRefreshQueue();
            return true;
        } catch (e) {
            isRefreshing = false;
            flushRefreshQueue(e);
            throw e;
        }
    }

    return new Promise((resolve, reject) => {
        refreshQueue.push({ resolve, reject });
    });
}

function flushRefreshQueue(error) {
    const queue = refreshQueue;
    refreshQueue = [];
    queue.forEach(({ resolve, reject }) => {
        if (error) reject(error);
        else resolve(true);
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

function resolveApiPath(url) {
    try {
        return new URL(url, window.location?.origin || 'http://localhost').pathname;
    } catch (e) {
        return String(url || '').split('?')[0];
    }
}

function isAuthLifecycleRequest(url) {
    const path = resolveApiPath(url);
    return path === `${API_BASE}/auth/login`
        || path === `${API_BASE}/auth/register`
        || path === `${API_BASE}/auth/config`
        || path === `${API_BASE}/auth/refresh`;
}

function isRefreshableAuthCode(code) {
    return REFRESHABLE_AUTH_CODES.has(code);
}

function shouldRefreshAfterAuthFailure(res, data, url) {
    if (isAuthLifecycleRequest(url)) return false;
    if (res.status === 401) return isRefreshableAuthCode(data.code);
    if (res.status === 403) return data.code === CSRF_INVALID_CODE;
    return false;
}

function shouldEndSessionAfterRetry(res, data, url) {
    if (isAuthLifecycleRequest(url)) return false;
    return (res.status === 401 && isRefreshableAuthCode(data.code))
        || (res.status === 403 && data.code === CSRF_INVALID_CODE);
}

// 通用请求包装器 (支持自动刷新)
async function apiFetch(url, options = {}) {
    const timeoutMs = resolveRequestTimeout(options);
    const requestOptions = { ...options };
    delete requestOptions.timeoutMs;
    const originalRequest = async () => {
        const headers = authHeaders(requestOptions.headers || {});
        return fetchWithTimeout(url, { credentials: 'same-origin', ...requestOptions, headers }, timeoutMs);
    };

    const res = await originalRequest();
    const data = (res.status === 401 || res.status === 403) ? await res.clone().json().catch(() => ({})) : {};

    if (shouldRefreshAfterAuthFailure(res, data, url)) {
        try {
            await refreshAccessToken();
            const retryRes = await originalRequest();
            const retryData = (retryRes.status === 401 || retryRes.status === 403) ? await retryRes.clone().json().catch(() => ({})) : {};
            if (shouldEndSessionAfterRetry(retryRes, retryData, url)) {
                handleUnauthorized();
            }
            return retryRes;
        } catch (e) {
            handleUnauthorized();
            throw e;
        }
    }

    return res;
}

window.Pivot.api = {
    fetch: apiFetch,
    authFetch,
    authHeaders,
    refreshAccessToken
};
window.Pivot.permissions = {
    isAdminUser,
    isSuperAdminUser,
    getPermissionTier,
    getPermissionLabel
};

Object.defineProperties(window.Pivot.legacy, {
    API_BASE: { get: () => API_BASE },
    apiFetch: { get: () => apiFetch },
    authFetch: { get: () => authFetch },
    authHeaders: { get: () => authHeaders },
    currentUser: { get: () => currentUser, set: value => { currentUser = value; } },
    currentSessionId: { get: () => currentSessionId, set: value => { currentSessionId = value; } }
});

async function checkLogin(hasRetried = false) {
    try {
        const res = await apiFetch(`${API_BASE}/auth/me`);
        if (res.ok) {
            const data = await res.json();
            if (data.authenticated === false) {
                if (!hasRetried && isRefreshableAuthCode(data.code)) {
                    try {
                        await refreshAccessToken();
                        return checkLogin(true);
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
            authFailureHandled = false;
            if (window.Pivot.legacy.showApp) window.Pivot.legacy.showApp();
        } else {
            handleUnauthorized();
        }
    } catch (e) {
        console.error('自动登录失败:', e);
        handleUnauthorized();
    }
}

function handleUnauthorized() {
    currentUser = null;
    currentSessionId = null;
    localStorage.removeItem('pivot_token');
    try {
        localStorage.removeItem('pivot_official_writing_state_v1');
        localStorage.removeItem('pivot_official_writing_library_v2');
    } catch (_) {}
    setCsrfToken('');
    if (window.Pivot.legacy.closeAgentRealtime) window.Pivot.legacy.closeAgentRealtime();
    if (window.Pivot.legacy.stopAnnouncements) window.Pivot.legacy.stopAnnouncements();
    if (authFailureHandled) return;
    authFailureHandled = true;
    if (window.Pivot.legacy.showAuth) window.Pivot.legacy.showAuth();
}

function setCsrfToken(value) {
    csrfToken = value || '';
    if (csrfToken) {
        authFailureHandled = false;
        sessionStorage.setItem('pivot_csrf_token', csrfToken);
    } else {
        sessionStorage.removeItem('pivot_csrf_token');
    }
}
