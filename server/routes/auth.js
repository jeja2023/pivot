/* 认证路由模块 Authentication Routes */
const express = require('express');
const {
    register,
    login,
    refreshTokens,
    getCookie,
    AUTH_COOKIE_NAME,
    REFRESH_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    ACCESS_COOKIE_OPTIONS,
    REFRESH_COOKIE_OPTIONS,
    CLEAR_COOKIE_OPTIONS,
    CLEAR_REFRESH_COOKIE_OPTIONS,
    CLEAR_LEGACY_REFRESH_COOKIE_OPTIONS,
    CLEAR_CSRF_COOKIE_OPTIONS,
    generateCsrfToken,
    resolveAuthenticatedUserAsync,
    hashRefreshToken
} = require('../auth');
const { asyncHandler } = require('../http');
const { query, execute } = require('../db/client');
const crypto = require('crypto');
const { hashApiKey, previewApiKey } = require('../auth');
const { getApiAccessSetting } = require('../services/api-access-settings');

function createAuthRouter({
    authMiddleware,
    loginLimiter,
    registerLimiter,
    isPublicRegistrationEnabled,
    logAction,
    publicUrl
}) {
    const router = express.Router();
    const effectiveRegisterLimiter = registerLimiter || ((_req, _res, next) => next());

    router.post('/auth/register', effectiveRegisterLimiter, asyncHandler(async (req, res) => {
        if (!isPublicRegistrationEnabled()) {
            logAction(req, '注册拦截', `尝试注册账号: ${req.body?.username || '-'}`);
            return res.status(403).json({ error: '当前已关闭公开注册，请联系管理员创建账号' });
        }
        const { username, password, nickname, unit } = req.body;
        try {
            const user = register(username, password, nickname, unit);
            logAction(req, '用户注册', `注册账号: ${username}`);
            res.json(user);
        } catch (e) {
            if (e.status === 400) {
                logAction(req, '用户注册失败', `注册账号: ${username || '-'}，原因: ${e.message}`);
                return res.status(400).json({ error: e.message });
            }
            throw e;
        }
    }));

    router.get('/auth/config', (req, res) => {
        // Docker 环境默认禁用客户端下载（因为镜像中不包含 .exe）
        const enableDesktopDownload = process.env.ENABLE_DESKTOP_DOWNLOAD === 'true';
        res.json({
            allowPublicRegistration: isPublicRegistrationEnabled(),
            publicUrl: publicUrl,
            desktopDownloadEnabled: enableDesktopDownload
        });
    });

    router.post('/auth/login', loginLimiter, asyncHandler(async (req, res) => {
        try {
            const data = await login(req.body.username, req.body.password);
            req.user = data.user;
            logAction(req, '用户登录', '登录成功');
            
            // 设置两个 Cookie
            res.cookie(AUTH_COOKIE_NAME, data.accessToken, ACCESS_COOKIE_OPTIONS);
            res.clearCookie(REFRESH_COOKIE_NAME, CLEAR_LEGACY_REFRESH_COOKIE_OPTIONS);
            res.cookie(REFRESH_COOKIE_NAME, data.refreshToken, REFRESH_COOKIE_OPTIONS);
            const csrfToken = generateCsrfToken();
            res.cookie(CSRF_COOKIE_NAME, csrfToken, {
                sameSite: 'lax',
                path: '/',
                secure: process.env.COOKIE_SECURE === 'true',
                maxAge: ACCESS_COOKIE_OPTIONS.maxAge
            });
            
            res.json({ 
                user: data.user,
                csrfToken
            });
        } catch (e) {
            logAction(req, '登录失败', `账号: ${req.body?.username || '-'}，原因: ${e.message}`);
            res.status(401).json({ error: e.message });
        }
    }));

    router.post('/auth/refresh', asyncHandler(async (req, res) => {
        const refreshToken = getCookie(req, REFRESH_COOKIE_NAME);
        if (!refreshToken) {
            return res.status(401).json({ error: '缺失刷新令牌', code: 'REFRESH_TOKEN_MISSING' });
        }

        try {
            const data = await refreshTokens(refreshToken);
            res.cookie(AUTH_COOKIE_NAME, data.accessToken, ACCESS_COOKIE_OPTIONS);
            res.clearCookie(REFRESH_COOKIE_NAME, CLEAR_LEGACY_REFRESH_COOKIE_OPTIONS);
            res.cookie(REFRESH_COOKIE_NAME, data.refreshToken, REFRESH_COOKIE_OPTIONS);
            const csrfToken = generateCsrfToken();
            res.cookie(CSRF_COOKIE_NAME, csrfToken, {
                sameSite: 'lax',
                path: '/',
                secure: process.env.COOKIE_SECURE === 'true',
                maxAge: ACCESS_COOKIE_OPTIONS.maxAge
            });
            res.json({ success: true, csrfToken });
        } catch (e) {
            res.clearCookie(AUTH_COOKIE_NAME, CLEAR_COOKIE_OPTIONS);
            res.clearCookie(REFRESH_COOKIE_NAME, CLEAR_REFRESH_COOKIE_OPTIONS);
            res.status(401).json({ error: e.message, code: 'REFRESH_TOKEN_INVALID' });
        }
    }));

    router.get('/auth/me', asyncHandler(async (req, res) => {
        const auth = await resolveAuthenticatedUserAsync(req);
        if (!auth.user) {
            return res.json({ authenticated: false, code: auth.code });
        }

        const csrfToken = generateCsrfToken();
        res.cookie(CSRF_COOKIE_NAME, csrfToken, {
            sameSite: 'lax',
            path: '/',
            secure: process.env.COOKIE_SECURE === 'true',
            maxAge: ACCESS_COOKIE_OPTIONS.maxAge
        });
        res.json({ authenticated: true, user: auth.user, csrfToken });
    }));

    router.post('/auth/logout', asyncHandler(async (req, res) => {
        try {
            const auth = await resolveAuthenticatedUserAsync(req);
            if (auth?.user) {
                req.user = auth.user;
                logAction(req, '用户退出', '退出登录');
            }
        } catch (_) {}
        
        // 尝试从 Cookie 中获取并删除数据库中的 Refresh Token
        const refreshToken = getCookie(req, REFRESH_COOKIE_NAME);
        if (refreshToken) {
            try {
                await execute('DELETE FROM refresh_tokens WHERE token = ?', [hashRefreshToken(refreshToken)]);
            } catch (_) {}
        }

        res.clearCookie(AUTH_COOKIE_NAME, CLEAR_COOKIE_OPTIONS);
        res.clearCookie(REFRESH_COOKIE_NAME, CLEAR_REFRESH_COOKIE_OPTIONS);
        res.clearCookie(REFRESH_COOKIE_NAME, CLEAR_LEGACY_REFRESH_COOKIE_OPTIONS);
        res.clearCookie(CSRF_COOKIE_NAME, CLEAR_CSRF_COOKIE_OPTIONS);
        res.json({ success: true });
    }));

    // --- API Key 管理 ---
    router.get('/auth/keys', authMiddleware, asyncHandler(async (req, res) => {
        const maxOutputExpr = "GREATEST(COALESCE(output_tokens, 0), COALESCE(usage_tokens, 0) - COALESCE(input_tokens, 0))";
        const keys = await query(`
            SELECT id, name, key_preview, created_at, last_used_at, status, usage_tokens,
                   COALESCE(input_tokens, 0) AS input_tokens,
                   ${maxOutputExpr} AS output_tokens
            FROM api_keys
            WHERE user_id = ?
            ORDER BY created_at DESC
        `, [req.user.id]);
        res.json({
            apiAccessEnabled: getApiAccessSetting(),
            keys: keys.map(k => ({ ...k, key: k.key_preview || 'sk-****' }))
        });
    }));

    router.post('/auth/keys', authMiddleware, asyncHandler(async (req, res) => {
        if (!getApiAccessSetting()) {
            return res.status(403).json({ error: 'API 接入已由管理员关闭，暂不能创建新密钥' });
        }
        const { name } = req.body;
        const key = 'sk-' + crypto.randomBytes(24).toString('hex');
        await execute('INSERT INTO api_keys (user_id, name, key_hash, key_preview, key) VALUES (?, ?, ?, ?, NULL)', [
            req.user.id,
            name || '未命名密钥',
            hashApiKey(key),
            previewApiKey(key)
        ]);
        logAction(req, '创建 API Key', `名称: ${name}`);
        res.json({ key, name });
    }));

    router.delete('/auth/keys/:id', authMiddleware, asyncHandler(async (req, res) => {
        const changes = await execute('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (changes === 0) return res.status(404).json({ error: '密钥不存在' });
        logAction(req, '删除 API Key', `ID: ${req.params.id}`);
        res.json({ success: true });
    }));

    return router;
}

module.exports = { createAuthRouter };
