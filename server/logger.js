const pino = require('pino');
const pinoHttp = require('pino-http');
const path = require('path');
const fs = require('fs');

const isProduction = process.env.NODE_ENV === 'production';
const logDir = path.resolve(__dirname, '../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// 敏感字段脱敏配置
const redactFields = [
    'password', 'password_hash', 'api_key', 'key', 'key_hash', 
    '*.password', '*.api_key', 'headers.authorization', 'headers.cookie'
];

// 构建输出流
const streams = [];
if (isProduction) {
    // 生产环境：控制台输出原始 JSON (高性能)
    streams.push({ stream: process.stdout });
    // 同时写入文件
    streams.push({ 
        level: 'info',
        stream: pino.destination({
            dest: path.join(logDir, 'pivot.log'),
            sync: false, // 异步写入，提升性能
            mkdir: true
        })
    });
} else {
    // 开发环境：使用 pino-pretty 美化输出
    streams.push({
        stream: require('pino-pretty')({
            colorize: true,
            translateTime: 'HH:mm:ss',
            ignore: 'pid,hostname,version,req,res,responseTime,reqId',
            singleLine: true,
            messageFormat: '{msg}'
        })
    });
}

const logger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    redact: {
        paths: redactFields,
        censor: '[REDACTED]'
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label.toUpperCase() })
    }
}, pino.multistream(streams));

// HTTP 请求日志中间件
const httpLogger = pinoHttp({
    logger,
    // 深度过滤：忽略静态资源（含参数）、健康检查和高频轮询
    autoLogging: {
        ignore: (req) => {
            const url = (req.url || '').split(/[?#]/)[0];
            return /\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2?|map)$/i.test(url) || 
                   url === '/api/health' || 
                   url === '/favicon.ico' ||
                   url === '/favicon.png' ||
                   url === '/common/logo.png';
        }
    },
    // 自定义日志级别：成功的 GET 请求和已手动记录的测试请求设为 trace (默认不显示)
    customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        // 屏蔽已手动记录详细信息的接口，避免重复
        const url = (req.url || '').split(/[?#]/)[0];
        if (url === '/api/models/test' && res.statusCode === 200) return 'trace';
        // 成功的 GET/OPTIONS 请求通常不需要持续关注
        if (req.method === 'GET' || req.method === 'OPTIONS') return 'trace';
        return 'info';
    },
    // 自动生成请求 ID
    genReqId: (req) => req.headers['x-request-id'] || require('uuid').v4(),
    // 自定义请求日志内容
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode} - 完成`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.url} ${res.statusCode} - 失败: ${err.message}`,
    // 序列化配置
    serializers: {
        req: (req) => ({
            id: req.id,
            method: req.method,
            url: req.url,
            ip: req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
            user: req.raw?.user ? req.raw.user.username : 'guest'
        }),
        res: (res) => ({
            statusCode: res.statusCode
        })
    }
});

// 导出
logger.logger = logger;
logger.httpLogger = httpLogger;

module.exports = logger;

