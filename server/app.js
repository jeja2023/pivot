require('dotenv').config();

// 自动处理 Windows 控制台中文乱码
if (process.platform === 'win32') {
    try {
        require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
    } catch (e) {
        // 忽略切换失败的情况
    }
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const { logger, httpLogger } = require('./logger');
const {
    metricsMiddleware,
    metricsAuthMiddleware,
    renderPrometheusMetrics
} = require('./metrics');
const { 
    getClientIp, 
    normalizePage, 
    normalizeLimit
} = require('./http');
const { validateConfig } = require('./config');
const { applyAppVersionTemplate, getAppVersion } = require('./version');
const { loadChatHtmlTemplate } = require('./chat-template');
const { MANUAL_PATH, renderManualHtml } = require('./manual-page');
const {
    configureDirSizeCache,
    getCachedDirSize
} = require('./services/dir-size-cache');
const {
    enqueueAuditLog,
    flushAllSqliteWrites
} = require('./services/db-write-queue');
const appConfig = validateConfig();
const appVersion = getAppVersion();
const chatHtmlTemplate = loadChatHtmlTemplate();
configureDirSizeCache({
    ttlMs: appConfig.directorySizeCacheMs,
    max: 64,
    depth: 32
});

const { authMiddleware, csrfMiddleware } = require('./auth');
const { isAdmin } = require('./permissions');
const {
    escapeCsvCell
} = require('./security');
const { getBeijingTimestamp } = require('./time');
const { normalizeAuditAction } = require('./audit-actions');
const { createUploadMiddleware, uploadSecurityMiddleware } = require('./upload');
const { createAuthRouter } = require('./routes/auth');
const { createAttachmentsRouter } = require('./routes/attachments');
const { createChatRouter } = require('./routes/chat');
const { createModelsRouter } = require('./routes/models');
const { createPromptsRouter } = require('./routes/prompts');
const { createSessionsRouter } = require('./routes/sessions');
const { createAdminUsersRouter } = require('./routes/admin-users');
const { createAdminStatsRouter } = require('./routes/admin-stats');
const { createSettingsRouter } = require('./routes/settings');
const { createOpenAIRouter } = require('./routes/openai');
const { createAppsRouter } = require('./routes/apps');
const { createAgentsRouter } = require('./routes/agents');
const { createTriggersRouter } = require('./routes/triggers');
const { createMcpRouter } = require('./routes/mcp');
const { createEventsRouter } = require('./routes/events');
const { createAnnouncementsRouter } = require('./routes/announcements');
const { createMemoriesRouter } = require('./routes/memories');
const { ragRouter, retrieveContext } = require('./rag');
const {
    migrateModelSecrets
} = require('./services/models');
const { getPublicRegistrationSetting } = require('./services/registration-settings');
const { getSystemHealthSnapshot } = require('./services/system-health');

// 移除冗余的 getClientIp 定义，已由 http.js 提供

const logAction = (req, action, details) => {
    const userId = req.user ? req.user.id : null;
    const ip = getClientIp(req);
    const serializedDetails = typeof details === 'string'
        ? details
        : (() => {
            try {
                return JSON.stringify(details);
            } catch (err) {
                return String(details ?? '');
            }
        })();
    enqueueAuditLog({
        userId,
        action: normalizeAuditAction(action),
        details: serializedDetails,
        ipAddress: ip,
        timestamp: getBeijingTimestamp()
    });
};

// 移除冗余的分页格式化函数，已由 http.js 提供
const isPublicRegistrationEnabled = () => getPublicRegistrationSetting();
const app = express();
app.locals.appVersion = appVersion;
app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
});
app.use(httpLogger); // 注入请求日志和请求 ID
app.use(metricsMiddleware);
const rateLimit = require('express-rate-limit');

migrateModelSecrets();

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => getClientIp(req), // 统一使用 getClientIp
    message: { error: '登录请求过于频繁，请15分钟后再试' }
});

const registerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => getClientIp(req),
    message: { error: '注册请求过于频繁，请15分钟后再试' }
});

const healthLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req) => getClientIp(req),
    message: { error: '健康检查请求过于频繁，请稍后再试' }
});

// 开启 Helmet 安全防护 (精细化安全配置)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "script-src": ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, "blob:"],
            "script-src-elem": ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, "blob:"],
            "script-src-attr": ["'none'"],
            "img-src": ["'self'", "data:", "blob:"],
            "style-src": ["'self'", "'unsafe-inline'"],
            "connect-src": ["'self'"],
            "upgrade-insecure-requests": null
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    hsts: false
}));

const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => {
        // 优先使用用户 ID 进行限流，防止多设备/代理下的误伤，同时也防止单一用户刷接口
        return req.user ? `user_${req.user.id}` : getClientIp(req);
    },
    message: { error: '您的提问速度过快，请稍作休息' }
});

const automationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.user ? `user_${req.user.id}` : getClientIp(req),
    message: { error: '自动化操作过于频繁，请稍后再试' }
});

const probeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    keyGenerator: (req) => {
        if (req.isApiKey && req.apiKeyId) return `api_key_${req.apiKeyId}`;
        return req.user ? `user_${req.user.id}` : getClientIp(req);
    },
    message: { error: '接口探测请求过于频繁，请稍后再试' }
});

const embeddingLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req) => {
        if (req.isApiKey && req.apiKeyId) return `api_key_${req.apiKeyId}`;
        return req.user ? `user_${req.user.id}` : getClientIp(req);
    },
    message: { error: '向量模型调用过于频繁，请稍后再试' }
});

// 入站触发按来源 IP 限流：未登录场景下只能依据来源地址识别调用方
const triggerLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req) => getClientIp(req),
    message: { error: '触发请求过于频繁，请稍后再试' }
});

app.locals.loginLimiter = loginLimiter;
app.locals.registerLimiter = registerLimiter;
app.locals.chatLimiter = chatLimiter;
app.locals.probeLimiter = probeLimiter;
app.locals.embeddingLimiter = embeddingLimiter;
app.locals.automationLimiter = automationLimiter;
app.locals.triggerLimiter = triggerLimiter;

const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(v => v.trim()).filter(Boolean);
if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins, credentials: true }));
}
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use('/api', csrfMiddleware);
app.use('/v1', csrfMiddleware);

app.get('/api/health', healthLimiter, (req, res) => {
    const health = getSystemHealthSnapshot({ public: true });
    return res.status(health.status === 'error' ? 503 : 200).json({
        service: 'pivot-ai',
        timestamp: getBeijingTimestamp(),
        ...health
    });
});

app.get('/api/health/details', healthLimiter, authMiddleware, (req, res) => {
    const health = getSystemHealthSnapshot();
    return res.status(health.status === 'error' ? 503 : 200).json({
        service: 'pivot-ai',
        timestamp: getBeijingTimestamp(),
        ...health
    });
});

app.get('/api/metrics', metricsAuthMiddleware, (req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderPrometheusMetrics());
});

// --- 模型接口 ---
app.use('/api', createModelsRouter({ authMiddleware, logAction, normalizePage, normalizeLimit, probeLimiter }));

if (appConfig.compressionEnabled) {
    try {
        const compression = require('compression');
        app.use(compression({
            filter: (req, res) => {
                // 显式跳过对话接口和流式内容，防止压缩导致缓冲（Buffering）
                if (req.originalUrl && req.originalUrl.includes('/api/chat')) return false;
                const contentType = res.getHeader('Content-Type');
                if (contentType && contentType.includes('text/event-stream')) return false;
                return compression.filter(req, res);
            }
        }));
    } catch (e) {
        logger.warn('性能提醒: compression 依赖未安装，已跳过响应压缩');
    }
}

// 禁止缓存的响应头
const noCacheHeaders = (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
};

// 需要禁止缓存的路径前缀（业务代码，频繁更新）
const noCachePrefixes = ['/chat/', '/common/styles/'];
const noCacheExact = new Set(['/manifest.json', '/sw.js', '/version.json', '/pwa-manager.js']);
const renderPwaResetHtml = (nonce = '') => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pivot PWA 缓存清理</title>
    <style nonce="${nonce}">
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #1e293b; }
        main { width: min(520px, calc(100vw - 32px)); padding: 28px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.12); }
        h1 { margin: 0 0 12px; font-size: 22px; }
        p { margin: 8px 0; color: #64748b; line-height: 1.6; }
        button, a { display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid #dbe3ef; background: #fff; color: #334155; text-decoration: none; cursor: pointer; font-size: 14px; }
        button.primary { border-color: #10a37f; background: #10a37f; color: #fff; }
        .actions { display: flex; gap: 10px; margin-top: 18px; }
        #status { margin-top: 14px; font-size: 13px; color: #0f766e; }
    </style>
</head>
<body>
    <main>
        <h1>Pivot PWA 缓存清理</h1>
        <p>该页面会注销当前站点的 Service Worker，并删除 Pivot 相关缓存。</p>
        <p>清理完成后请返回系统页面。</p>
        <div class="actions">
            <button id="reset-btn" class="primary">立即清理</button>
            <a href="/chat">返回系统</a>
        </div>
        <div id="status">等待操作</div>
    </main>
    <script nonce="${nonce}">
        async function clearPivotPwa() {
            var status = document.getElementById('status');
            try {
                status.textContent = '正在注销 Service Worker...';
                if ('serviceWorker' in navigator) {
                    var regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(function (reg) { return reg.unregister(); }));
                }
                status.textContent = '正在删除 CacheStorage...';
                if (window.caches) {
                    var keys = await caches.keys();
                    await Promise.all(keys.filter(function (key) { return key.startsWith('pivot-'); }).map(function (key) { return caches.delete(key); }));
                }
                localStorage.removeItem('pivot-current-build');
                status.textContent = '清理完成，正在返回系统...';
                setTimeout(function () { location.href = '/chat'; }, 800);
            } catch (err) {
                status.textContent = '清理失败：' + (err && err.message ? err.message : err);
            }
        }
        document.getElementById('reset-btn').addEventListener('click', clearPivotPwa);
        window.addEventListener('load', clearPivotPwa);
    </script>
</body>
</html>`;

// 第三方库 vendor 目录长期缓存（内容几乎不变）
app.use('/common/vendor', express.static(path.join(__dirname, '../client/common/vendor'), {
    maxAge: appConfig.vendorMaxAge,
    immutable: true
}));

// 客户端下载目录（如果文件存在则提供下载）
app.use('/downloads', express.static(path.join(__dirname, '../downloads'), {
    maxAge: 0,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
}));

const sendChatPage = (req, res) => {
    noCacheHeaders(res);
    res.type('html').send(applyAppVersionTemplate(chatHtmlTemplate, appVersion));
};

app.get('/chat', sendChatPage);
app.get('/chat/', (req, res) => {
    noCacheHeaders(res);
    res.redirect(302, '/chat');
});
app.get('/chat/chat.html', (req, res) => {
    noCacheHeaders(res);
    res.redirect(302, '/chat');
});

// sw.js 必须禁止缓存，否则浏览器无法检测到新版本
app.get('/sw.js', (req, res) => {
    noCacheHeaders(res);
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '../client/sw.js'));
});

// manifest.json 禁止缓存
app.get('/manifest.json', (req, res) => {
    noCacheHeaders(res);
    res.sendFile(path.join(__dirname, '../client/manifest.json'));
});

app.get('/version.json', (req, res) => {
    noCacheHeaders(res);
    res.json({
        version: appVersion,
        build: `${appVersion}-vendor-only`,
        swPolicy: 'vendor-only',
        generatedAt: getBeijingTimestamp()
    });
});

app.get('/pwa-reset', (req, res) => {
    noCacheHeaders(res);
    res.type('html').send(renderPwaResetHtml(res.locals.cspNonce));
});

app.get(['/manual', '/manual/'], async (req, res) => {
    noCacheHeaders(res);
    try {
        const markdown = await fs.promises.readFile(MANUAL_PATH, 'utf8');
        res.type('html').send(renderManualHtml(markdown, {
            nonce: res.locals.cspNonce,
            embedded: req.query.embed === '1'
        }));
    } catch (err) {
        logger.error({ err, manualPath: MANUAL_PATH }, '使用帮助读取失败');
        res.status(500).type('text/plain; charset=utf-8').send('使用帮助暂时无法打开，请联系管理员检查部署文件。');
    }
});

// 静态文件服务：通过 setHeaders 动态控制缓存策略
// 注意：express.static 会在发送文件时覆盖已设置的 Cache-Control 头，
// 因此必须在 setHeaders 回调中设置，而不是在前置中间件中设置
app.use(express.static(path.join(__dirname, '../client'), {
    maxAge: appConfig.staticMaxAge,
    setHeaders: (res, filePath) => {
        const urlPath = '/' + path.relative(path.join(__dirname, '../client'), filePath).replace(/\\/g, '/');
        // 业务代码文件（JS/CSS/HTML）禁止缓存
        if (noCacheExact.has(urlPath) || noCachePrefixes.some(p => urlPath.startsWith(p)) || /\/common\/styles\//.test(urlPath)) {
            noCacheHeaders(res);
        }
    }
}));
const upload = createUploadMiddleware();
const secureUpload = {
    single: (field) => [upload.single(field), uploadSecurityMiddleware],
    array: (field, maxCount) => [upload.array(field, maxCount), uploadSecurityMiddleware]
};
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 12,
    keyGenerator: (req) => req.user ? `user_${req.user.id}` : getClientIp(req),
    message: { error: '上传请求过于频繁，请稍后再试' }
});
app.use(createAttachmentsRouter({
    authMiddleware,
    uploadLimiter,
    upload: secureUpload,
    normalizePage,
    normalizeLimit,
    logAction
}));

// 根路径跳转至对话页面
app.get('/', (req, res) => {
    noCacheHeaders(res);
    res.redirect(302, '/chat');
});

app.use('/api', createAuthRouter({
    authMiddleware,
    loginLimiter: app.locals.loginLimiter,
    registerLimiter: app.locals.registerLimiter,
    isPublicRegistrationEnabled,
    logAction,
    publicUrl: appConfig.publicUrl
}));

// --- 管理员权限中间件 ---
const adminMiddleware = (req, res, next) => {
    if (!isAdmin(req.user)) {
        logAction(req, '权限拒绝', `访问管理员接口: ${req.method} ${req.originalUrl}`);
        return res.status(403).json({ error: '权限不足' });
    }
    next();
};

app.use('/api/stats', createAdminStatsRouter({
    authMiddleware,
    adminMiddleware,
    logAction,
    escapeCsvCell,
    getCachedDirSize,
    publicUrl: appConfig.publicUrl
}));

app.use('/api', createAdminUsersRouter({
    authMiddleware,
    adminMiddleware,
    upload: secureUpload,
    logAction
}));

app.use('/api', createSettingsRouter({
    authMiddleware,
    adminMiddleware,
    logAction
}));

app.use('/api', createAnnouncementsRouter({
    authMiddleware,
    adminMiddleware,
    normalizePage,
    normalizeLimit,
    logAction
}));

app.use('/api', createMcpRouter({
    authMiddleware,
    adminMiddleware,
    logAction
}));

app.use('/api/rag', ragRouter);

// --- 对话接口 ---
app.use('/api', createSessionsRouter({
    authMiddleware,
    normalizePage,
    normalizeLimit,
    logAction
}));

app.use('/api', createPromptsRouter({
    authMiddleware,
    logAction
}));

app.use('/api', createMemoriesRouter({
    authMiddleware,
    logAction
}));

app.use('/api', createAgentsRouter({
    authMiddleware,
    logAction,
    automationLimiter: app.locals.automationLimiter
}));

// 入站触发挂在 /hooks 下：令牌即凭证，不参与浏览器会话鉴权和 CSRF 校验
app.use('/hooks', createTriggersRouter({
    triggerLimiter: app.locals.triggerLimiter,
    logAction
}));

app.use('/api', createEventsRouter({
    authMiddleware
}));

app.use('/api', createChatRouter({
    authMiddleware,
    chatLimiter: app.locals.chatLimiter,
    logAction,
    retrieveContext,
    isRagEnabled: () => true,
    publicUrl: appConfig.publicUrl
}));

app.use('/v1', createOpenAIRouter({
    authMiddleware,
    logAction,
    embeddingLimiter: app.locals.embeddingLimiter
}));

// --- 应用中心接口（公文写作 AI 等） ---
app.use('/api', createAppsRouter({
    authMiddleware,
    logAction,
    uploadLimiter,
    upload: secureUpload
}));

// --- API 404 处理器 (确保 API 请求永远返回 JSON) ---
app.use(['/api', '/v1'], (req, res) => {
    res.status(404).json({ error: `接口不存在: ${req.method} ${req.originalUrl}` });
});

// --- 全局错误处理中间件 ---
app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const isClientError = status >= 400 && status < 500;

    // 记录到日志系统
    const logMethod = status >= 500 ? 'error' : 'warn';
    (req.log || logger)[logMethod]({
        status,
        message: err.message,
        url: req.originalUrl || req.url,
        method: req.method,
        user: req.user ? req.user.username : 'anonymous',
        stack: status >= 500 ? err.stack : undefined
    }, isClientError ? '客户端错误 (Client Error)' : '系统错误 (System Error)');

    // 如果是服务器内部错误 (500+)，记录到数据库审计日志
    if (status >= 500) {
        try {
            logAction(req, '系统错误', JSON.stringify({
                message: err.message,
                url: req.originalUrl || req.url,
                method: req.method,
                stack: err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : 'no-stack'
            }));
        } catch (logErr) {
            logger.error({ err: logErr }, '日志入库失败');
        }
    }

    // 错误响应：4xx 客户端错误的提示对用户有意义，原样返回；
    // 5xx 服务端错误默认返回通用消息，避免泄漏 SQL 错误、内部路径或堆栈，
    // 不依赖 NODE_ENV（运维若漏设环境变量也不会泄漏）。503 保留原始提示以传递可重试信息。
    // 个别需要透出的 5xx 可在抛出时显式标记 err.expose = true。
    const exposeMessage = isClientError || status === 503 || err.expose === true;
    res.status(status).json({
        error: exposeMessage ? err.message : '服务器内部错误，请联系管理员'
    });
});

module.exports = { app, appConfig, appVersion, logger, flushAllSqliteWrites };

