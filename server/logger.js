const pino = require('pino');
const pinoHttp = require('pino-http');
const path = require('path');
const fs = require('fs');
const { getClientIp } = require('./http');

const os = require('os');
const isProduction = process.env.NODE_ENV === 'production';
function resolveSafeLogDir() {
    if (process.env.LOG_DIR) return path.resolve(process.env.LOG_DIR);
    const candidate = path.resolve(__dirname, '../logs');
    if (candidate.includes('.asar')) {
        return path.join(os.tmpdir(), 'pivot-logs');
    }
    return candidate;
}
const logDir = resolveSafeLogDir();
try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
} catch (_err) {
    // 忽略只读或虚拟文件系统路径下的创建失败
}

// 敏感字段脱敏配置
const redactFields = [
    'password', 'password_hash', 'api_key', 'key', 'key_hash',
    '*.password', '*.api_key', 'headers.authorization', 'headers.cookie'
];

// 敏感查询参数：附件访问令牌、api_key 等不应随 URL 落入访问日志
const SENSITIVE_QUERY_KEYS = /^(token|access_token|api_key|apikey|key|signature|sig|secret)$/i;

function safeDecodeQueryKey(value) {
    try {
        return decodeURIComponent(value);
    } catch (e) {
        return value;
    }
}

// 脱敏 URL 中的敏感查询参数，保留路径与其余参数便于排查
function scrubUrl(rawUrl) {
    const url = String(rawUrl || '');
    const qIndex = url.indexOf('?');
    if (qIndex === -1) return url;
    const pathPart = url.slice(0, qIndex);
    const queryPart = url.slice(qIndex + 1);
    const scrubbed = queryPart.split('&').map(pair => {
        const eq = pair.indexOf('=');
        const name = eq === -1 ? pair : pair.slice(0, eq);
        if (SENSITIVE_QUERY_KEYS.test(safeDecodeQueryKey(name).trim())) {
            return `${name}=[REDACTED]`;
        }
        return pair;
    }).join('&');
    return `${pathPart}?${scrubbed}`;
}

// 构建输出流
const streams = [];
const consolePretty = process.env.CONSOLE_LOG_PRETTY === 'true' || 
                      process.env.NODE_ENV !== 'production' ||
                      (process.stdout.isTTY && process.env.LOG_FORMAT !== 'json');

if (consolePretty) {
    // 控制台终端：使用 pino-pretty 进行可读化单行输出
    streams.push({
        stream: require('pino-pretty')({
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname,version,req,res,responseTime,reqId',
            singleLine: true,
            messageFormat: (log, messageKey) => {
                const msg = log[messageKey] || '';
                if (log.req) {
                    const user = log.req.user === 'guest' ? '访客' : (log.req.user || '-');
                    const status = log.res?.statusCode ? ` [状态: ${log.res.statusCode}]` : '';
                    const duration = log.responseTime !== undefined ? ` [耗时: ${log.responseTime}ms]` : '';
                    const isDefaultReqMsg = !msg || msg.endsWith(' - 完成') || msg.startsWith('request completed') || msg.startsWith('request errored');
                    const extraMsg = isDefaultReqMsg ? '' : ` - ${msg}`;
                    return `${log.req.method} ${log.req.url}${status}${duration} (用户: ${user})${extraMsg}`;
                }
                return msg;
            }
        })
    });
} else {
    // 容器/生产标准无终端环境：控制台输出原始 JSON (便于 ELK / 收集系统解析)
    streams.push({ stream: process.stdout });
}

// 始终将结构化 JSON 日志写入文件（同步写入避免进程快速退出或单例检测退出时 sonic-boom 尚未就绪导致异常）
streams.push({ 
    level: 'info',
    stream: pino.destination({
        dest: path.join(logDir, 'pivot.log'),
        sync: true,
        mkdir: true
    })
});

const logger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    redact: {
        paths: redactFields,
        censor: '[REDACTED]'
    },
    timestamp: () => `,"time":"${new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00')}"`,
    formatters: {
        level: (label) => ({ level: label.toUpperCase() })
    }
}, pino.multistream(streams));

const HIGH_FREQUENCY_BACKGROUND_URLS = new Set([
    '/api/health',
    '/api/mcp/local-device/heartbeat',
    '/api/mcp/local-device/tasks/next',
    '/api/mcp/local-device/connector/heartbeat',
    '/api/mcp/local-device/connector/tasks/claim',
    '/api/agents/local-devices/challenge',
    '/api/agents/deliveries/claim',
    '/favicon.ico',
    '/favicon.png',
    '/common/logo.png'
]);

// HTTP 请求日志中间件
const httpLogger = pinoHttp({
    logger,
    // 深度过滤：忽略静态资源（含参数）、健康检查和高频轮询
    autoLogging: {
        ignore: (req) => {
            const url = (req.url || '').split(/[?#]/)[0];
            return /\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2?|map)$/i.test(url) || 
                   HIGH_FREQUENCY_BACKGROUND_URLS.has(url) ||
                   url.includes('com.chrome.devtools.json');
        }
    },
    // 自定义日志级别：成功的 GET 请求和已手动记录的测试请求设为 trace (默认不显示)
    customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        // 屏蔽已手动记录详细信息的接口与高频心跳，避免刷屏
        const url = (req.url || '').split(/[?#]/)[0];
        if ((url === '/api/models/test' || HIGH_FREQUENCY_BACKGROUND_URLS.has(url)) && res.statusCode < 400) return 'trace';
        // 成功的 GET/OPTIONS 请求通常不需要持续关注
        if (req.method === 'GET' || req.method === 'OPTIONS') return 'trace';
        return 'info';
    },
    // 自动生成请求 ID
    genReqId: (req) => req.headers['x-request-id'] || require('uuid').v4(),
    // 自定义请求日志内容
    customSuccessMessage: (req, res) => `${req.method} ${scrubUrl(req.url)} ${res.statusCode} - 完成`,
    customErrorMessage: (req, res, err) => `${req.method} ${scrubUrl(req.url)} ${res.statusCode} - 失败: ${err.message}`,
    // 序列化配置
    serializers: {
        req: (req) => {
            const userObj = req.user || req.raw?.user;
            const username = typeof userObj === 'string' ? userObj : (userObj?.username || userObj?.nickname || '');
            return {
                id: req.id,
                method: req.method,
                url: scrubUrl(req.url),
                ip: getClientIp(req) || 'unknown',
                user: username || 'guest'
            };
        },
        res: (res) => ({
            statusCode: res.statusCode
        })
    }
});

// 导出
module.exports = { logger, httpLogger };
