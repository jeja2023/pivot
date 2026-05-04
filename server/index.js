/* 智枢后端主程序 Server Main Entry */
require('dotenv').config();
const { validateConfig } = require('./config');
const appConfig = validateConfig();

let shuttingDown = false;
const fatalExit = (reason, err) => {
    console.error(`[致命错误] ${reason}:`, err);
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

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { authMiddleware } = require('./auth');
const {
    escapeCsvCell
} = require('./security');
const { getBeijingTimestamp } = require('./time');
const { createUploadMiddleware } = require('./upload');
const { createAuthRouter } = require('./routes/auth');
const { createAttachmentsRouter } = require('./routes/attachments');
const { createChatRouter } = require('./routes/chat');
const { createModelsRouter } = require('./routes/models');
const { createPromptsRouter } = require('./routes/prompts');
const { createSessionsRouter } = require('./routes/sessions');
const { createAdminUsersRouter } = require('./routes/admin-users');
const { createAdminStatsRouter } = require('./routes/admin-stats');
const { createSettingsRouter, isSettingEnabled } = require('./routes/settings');
const { ragRouter, retrieveContext } = require('./rag');
const {
    migrateModelSecrets
} = require('./services/models');

const getClientIp = (req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    return ip.replace(/^.*:ffff:/, '');
};

const logAction = (req, action, details) => {
    const userId = req.user ? req.user.id : null;
    const ip = getClientIp(req);
    db.prepare('INSERT INTO audit_logs (user_id, action, details, ip_address, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(userId, action, details, ip, getBeijingTimestamp());
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
        console.warn(`[目录统计失败] ${dir}:`, e.message);
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
const rateLimit = require('express-rate-limit');

migrateModelSecrets();

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: '登录请求过于频繁，请15分钟后再试' }
});

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
        console.warn('[性能提醒] compression 依赖未安装，已跳过响应压缩');
    }
}

// 开启静态文件缓存
app.use('/common/vendor', express.static(path.join(__dirname, '../client/common/vendor'), {
    maxAge: appConfig.vendorMaxAge,
    immutable: true
}));
app.use(express.static('client', { maxAge: appConfig.staticMaxAge }));
const upload = createUploadMiddleware();
app.use(createAttachmentsRouter({
    authMiddleware,
    upload,
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
    logAction
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
    upload,
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
    isRagEnabled: () => isSettingEnabled('rag_enabled')
}));

// --- 全局错误处理中间件 ---
app.use((err, req, res, next) => {
    console.error('[应用错误]', {
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
        url: req.url,
        method: req.method
    });
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message
    });
});

const server = app.listen(appConfig.port, () => {
    console.log(`Pivot AI (智枢) 服务已启动: http://localhost:${appConfig.port} [${appConfig.instanceId}]`);
});

const gracefulShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[进程退出] 收到 ${signal}，正在关闭 HTTP 服务...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
