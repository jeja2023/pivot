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
const appConfig = validateConfig();
const PORT = appConfig.port;
const appVersion = getAppVersion();
const chatHtmlTemplate = fs.readFileSync(path.join(__dirname, '../client/chat/chat.html'), 'utf8');

let shuttingDown = false;
const fatalExit = (reason, err) => {
    logger.fatal({ err }, reason);
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => process.exit(1), 250).unref();
};
process.on('uncaughtException', (err) => {
    fatalExit('未捕获的异常 (Uncaught Exception)', err);
});
process.on('unhandledRejection', (reason) => {
    fatalExit('未处理的 Promise 拒绝 (Unhandled Rejection)', reason);
});
const { stmts } = require('./db');
const { authMiddleware, csrfMiddleware } = require('./auth');
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
const { createAgentsRouter } = require('./routes/agents');
const { createMcpRouter } = require('./routes/mcp');
const { ragRouter, retrieveContext } = require('./rag');
const { recoverStaleKnowledgeDocumentIndexes } = require('./services/rag-documents');
const {
    migrateModelSecrets
} = require('./services/models');
const { startGpuMonitor } = require('./services/gpu-monitor');
const { startModelEndpointMonitor } = require('./services/model-runtime');
const { startMaintenanceTasks } = require('./services/maintenance');
const { getSystemHealthSnapshot } = require('./services/system-health');
const { recoverAgentRuns, startAgentScheduleRunner } = require('./services/agent-runtime');
// 启动后台维护任务
startMaintenanceTasks();

// 启动 GPU 监控 (非阻塞)
startGpuMonitor().catch(() => {});
startModelEndpointMonitor().catch(() => {});
setImmediate(() => {
    recoverStaleKnowledgeDocumentIndexes();
    recoverAgentRuns();
    startAgentScheduleRunner();
});

// 移除冗余的 getClientIp 定义，已由 http.js 提供

const logAction = (req, action, details) => {
    const userId = req.user ? req.user.id : null;
    const ip = getClientIp(req);
    stmts.insertLog.run(userId, normalizeAuditAction(action), details, ip, getBeijingTimestamp());
};

// 移除冗余的分页格式化函数，已由 http.js 提供
const isPublicRegistrationEnabled = () => process.env.ALLOW_PUBLIC_REGISTRATION === 'true';
async function getDirSizeAsync(dir) {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                total += await getDirSizeAsync(fullPath);
            } else if (entry.isFile()) {
                const stats = await fs.promises.stat(fullPath);
                total += stats.size;
            }
        }
    } catch (e) {
        logger.warn({ dir, err: e.message }, '目录统计失败');
    }
    return total;
}

const dirSizeCache = new Map();
async function getCachedDirSize(dir) {
    const cacheMs = appConfig.directorySizeCacheMs;
    const key = path.resolve(dir);
    const cached = dirSizeCache.get(key);
    if (cacheMs > 0 && cached && Date.now() - cached.at < cacheMs) {
        return cached.value;
    }
    const value = await getDirSizeAsync(key);
    dirSizeCache.set(key, { value, at: Date.now() });
    return value;
}

const app = express();
app.locals.appVersion = appVersion;
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

// 开启 Helmet 安全防护 (精细化安全配置)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "script-src": ["'self'", "'unsafe-inline'", "blob:"],
            "script-src-attr": ["'unsafe-inline'"], // 允许 HTML 标签中的 onclick 等内联事件
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

app.locals.loginLimiter = loginLimiter;
app.locals.chatLimiter = chatLimiter;
app.locals.probeLimiter = probeLimiter;
app.locals.embeddingLimiter = embeddingLimiter;

const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(v => v.trim()).filter(Boolean);
if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins, credentials: true }));
}
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use('/api', csrfMiddleware);
app.use('/v1', csrfMiddleware);

app.get('/api/health', (req, res) => {
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
const pwaResetHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pivot PWA 缓存清理</title>
    <style>
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
            <a href="/chat/chat.html">返回系统</a>
        </div>
        <div id="status">等待操作</div>
    </main>
    <script>
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
                setTimeout(function () { location.href = '/chat/chat.html'; }, 800);
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

// chat.html 由服务端注入版本号，必须单独处理
app.get('/chat/chat.html', (req, res) => {
    noCacheHeaders(res);
    res.type('html').send(applyAppVersionTemplate(chatHtmlTemplate, appVersion));
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
    res.type('html').send(pwaResetHtml);
});

// 静态文件服务：通过 setHeaders 动态控制缓存策略
// 注意：express.static 会在发送文件时覆盖已设置的 Cache-Control 头，
// 因此必须在 setHeaders 回调中设置，而不是在前置中间件中设置
app.use(express.static('client', {
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
    single: (field) => [upload.single(field), uploadSecurityMiddleware]
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
    const htmlPath = path.join(__dirname, '../client/chat/chat.html');
    try {
        const content = fs.readFileSync(htmlPath, 'utf8');
        res.send(applyAppVersionTemplate(content, getAppVersion()));
    } catch (e) {
        res.sendFile(htmlPath);
    }
});

app.use('/api', createAuthRouter({
    authMiddleware,
    loginLimiter: app.locals.loginLimiter,
    isPublicRegistrationEnabled,
    logAction,
    publicUrl: appConfig.publicUrl
}));

// --- 管理员权限中间件 ---
const adminMiddleware = (req, res, next) => {
    if (req.user.role !== 'admin') {
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

app.use('/api', createAgentsRouter({
    authMiddleware,
    logAction
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

// --- API 404 处理器 (确保 API 请求永远返回 JSON) ---
app.use(['/api', '/v1'], (req, res) => {
    res.status(404).json({ error: `接口不存在: ${req.method} ${req.originalUrl}` });
});

// --- 全局错误处理中间件 ---
app.use((err, req, res, _next) => {
    const status = err.status || 500;
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

    res.status(status).json({
        error: (process.env.NODE_ENV === 'production' && status >= 500 && status !== 503) 
            ? '服务器内部错误，请联系管理员' 
            : err.message
    });
});

const server = app.listen(PORT, () => {
    logger.info({ port: PORT, url: `http://localhost:${PORT}`, version: appVersion }, 'Pivot AI (智枢) 服务已启动');
});

const gracefulShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '进程退出，正在关闭 HTTP 服务...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
