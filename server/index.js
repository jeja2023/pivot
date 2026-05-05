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
const { v4: uuidv4 } = require('uuid');
const { validateConfig } = require('./config');
const appConfig = validateConfig();
const PORT = appConfig.port;

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
process.on('unhandledRejection', (reason, promise) => {
    fatalExit('未处理的 Promise 拒绝 (Unhandled Rejection)', reason);
});
const { db, stmts } = require('./db');
const { authMiddleware } = require('./auth');
const {
    escapeCsvCell
} = require('./security');
const { getBeijingTimestamp } = require('./time');
const { createUploadMiddleware, uploadSecurityMiddleware } = require('./upload');
const { createAuthRouter } = require('./routes/auth');
const { createAttachmentsRouter } = require('./routes/attachments');
const { createChatRouter } = require('./routes/chat');
const { createModelsRouter } = require('./routes/models');
const { createPromptsRouter } = require('./routes/prompts');
const { createSessionsRouter } = require('./routes/sessions');
const { createAdminUsersRouter } = require('./routes/admin-users');
const { createAdminStatsRouter } = require('./routes/admin-stats');
const { createSettingsRouter, isSettingEnabled } = require('./routes/settings');
const { createOpenAIRouter } = require('./routes/openai');
const { ragRouter, retrieveContext } = require('./rag');
const {
    migrateModelSecrets
} = require('./services/models');
const { startGpuMonitor } = require('./services/gpu-monitor');
const { startModelEndpointMonitor } = require('./services/model-runtime');

// 启动 GPU 监控 (非阻塞)
startGpuMonitor().catch(() => {});
startModelEndpointMonitor().catch(() => {});

const getClientIp = (req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    return ip.replace(/^.*:ffff:/, '');
};

const logAction = (req, action, details) => {
    const userId = req.user ? req.user.id : null;
    const ip = getClientIp(req);
    stmts.insertLog.run(userId, action, details, ip, getBeijingTimestamp());
};

const normalizePage = (value, fallback = 1) => Math.max(parseInt(value, 10) || fallback, 1);
const normalizeLimit = (value, fallback = 10, max = 100) => Math.min(Math.max(parseInt(value, 10) || fallback, 1), max);
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
app.use(httpLogger); // 注入请求日志和请求 ID
app.use(metricsMiddleware);
const rateLimit = require('express-rate-limit');

migrateModelSecrets();

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: '登录请求过于频繁，请15分钟后再试' }
});

// 开启 Helmet 安全防护 (内网兼容模式)
app.use(helmet({
    contentSecurityPolicy: false, // 允许加载各种外部资源
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false, // 禁用 COOP，避免非 HTTPS 环境警告
    originAgentCluster: false,      // 禁用 Origin-Agent-Cluster 冲突
    hsts: false // 禁用强制 HTTPS，适配局域网环境
}));

const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: '您的提问速度过快，请稍作休息' }
});

app.locals.loginLimiter = loginLimiter;
app.locals.chatLimiter = chatLimiter;

const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(v => v.trim()).filter(Boolean);
if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins, credentials: true }));
}
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// 请求 ID 与结构化日志中间件由 httpLogger 处理，此处移除旧的逻辑

app.get('/api/health', (req, res) => {
    try {
        db.prepare('SELECT 1').get();
        res.json({
            status: 'ok',
            service: 'pivot-ai',
            timestamp: getBeijingTimestamp()
        });
    } catch (e) {
        res.status(500).json({ status: 'error', error: '数据库不可用' });
    }
});

app.get('/api/metrics', metricsAuthMiddleware, (req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderPrometheusMetrics());
});

// --- 模型接口 ---
app.use('/api', createModelsRouter({ authMiddleware, logAction, normalizePage, normalizeLimit }));

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

// 开启静态文件缓存
app.use('/common/vendor', express.static(path.join(__dirname, '../client/common/vendor'), {
    maxAge: appConfig.vendorMaxAge,
    immutable: true
}));
app.use(express.static('client', { maxAge: appConfig.staticMaxAge }));
const upload = createUploadMiddleware();
const secureUpload = {
    single: (field) => [upload.single(field), uploadSecurityMiddleware]
};
app.use(createAttachmentsRouter({
    authMiddleware,
    upload: secureUpload,
    normalizePage,
    normalizeLimit,
    logAction
}));

// 根路径跳转至对话页面
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/chat/chat.html'));
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
    getCachedDirSize
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

app.use('/api/rag', (req, res, next) => {
    if (!isSettingEnabled('rag_enabled')) {
        return res.status(403).json({ error: 'RAG 知识库功能未开启' });
    }
    next();
}, ragRouter);

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

app.use('/api', createChatRouter({
    authMiddleware,
    chatLimiter: app.locals.chatLimiter,
    logAction,
    retrieveContext,
    isRagEnabled: () => isSettingEnabled('rag_enabled'),
    publicUrl: appConfig.publicUrl
}));

app.use('/v1', createOpenAIRouter({
    authMiddleware,
    logAction
}));

// --- 全局错误处理中间件 ---
app.use((err, req, res, next) => {
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
            logAction(req, 'SYSTEM_ERROR', JSON.stringify({
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
        error: (process.env.NODE_ENV === 'production' && status >= 500) 
            ? '服务器内部错误，请联系管理员' 
            : err.message
    });
});

const server = app.listen(PORT, () => {
    logger.info({ port: PORT, url: `http://localhost:${PORT}` }, 'Pivot AI (智枢) 服务已启动');
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
