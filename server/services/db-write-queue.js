/**
 * server/services/db-write-queue.js
 * 高频日志写入队列（PostgreSQL）
 *
 * 审计日志、API 调用日志、MCP 调用日志、模型用量事件都是「高频、可容忍毫秒级
 * 延迟、不可阻塞主链路」的写入。本模块把它们缓冲成批，攒批落库。
 */
const { logger } = require('../logger');

// ──────────────────────────────────────────────────────────────────────────
// 队列定义
// ──────────────────────────────────────────────────────────────────────────

const QUEUE_SPECS = {
    auditLogs: {
        table: 'audit_logs',
        columns: ['user_id', 'action', 'details', 'ip_address', 'timestamp'],
        fields: ['userId', 'action', 'details', 'ipAddress', 'timestamp'],
    },
    apiCallLogs: {
        table: 'api_call_logs',
        columns: [
            'user_id', 'api_key_id', 'model_id', 'model_name', 'request_messages',
            'response_text', 'status', 'error_message', 'input_tokens', 'output_tokens',
            'total_tokens', 'stream', 'ip_address', 'created_at',
        ],
        fields: [
            'userId', 'apiKeyId', 'modelId', 'modelName', 'requestMessages',
            'responseText', 'status', 'errorMessage', 'inputTokens', 'outputTokens',
            'totalTokens', 'stream', 'ipAddress', 'createdAt',
        ],
    },
    mcpCallLogs: {
        table: 'mcp_call_logs',
        columns: [
            'user_id', 'server_id', 'tool_name', 'source', 'status',
            'duration_ms', 'input_preview', 'output_preview', 'error_message', 'created_at',
        ],
        fields: [
            'userId', 'serverId', 'toolName', 'source', 'status',
            'durationMs', 'inputPreview', 'outputPreview', 'errorMessage', 'createdAt',
        ],
    },
    modelUsageEvents: {
        table: 'model_usage_events',
        columns: ['user_id', 'model_id', 'source', 'token_count', 'input_tokens', 'output_tokens', 'created_at'],
        fields: ['userId', 'modelId', 'source', 'tokenCount', 'inputTokens', 'outputTokens', 'createdAt'],
    },
};

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_QUEUE_SIZE = 5000;
const QUEUE_HIGH_WATERMARK = 0.8;
const HIGH_WATERMARK_FLUSH_INTERVAL_MS = 50;
const QUEUE_DISABLED = /^(1|true|yes)$/i.test(String(process.env.PIVOT_DB_WRITE_QUEUE_DISABLED || ''));

const QUEUE_LIMITS = {
    auditLogs: Number.parseInt(process.env.PIVOT_DB_AUDIT_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    apiCallLogs: Number.parseInt(process.env.PIVOT_DB_API_LOG_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    mcpCallLogs: Number.parseInt(process.env.PIVOT_DB_MCP_LOG_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    modelUsageEvents: Number.parseInt(process.env.PIVOT_DB_USAGE_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
};

const FLUSH_INTERVAL_MS = Number.parseInt(process.env.PIVOT_DB_WRITE_FLUSH_MS, 10) || DEFAULT_FLUSH_INTERVAL_MS;
const MAX_BATCH_SIZE = Number.parseInt(process.env.PIVOT_DB_WRITE_BATCH_SIZE, 10) || DEFAULT_MAX_BATCH_SIZE;
const MAX_BURST_BATCH_SIZE = Math.max(
    MAX_BATCH_SIZE,
    Math.min(60000, Number.parseInt(process.env.PIVOT_DB_WRITE_MAX_BATCH_SIZE, 10) || 1000)
);
// 写入队列不能依赖 PostgreSQL 永远及时返回：网络黑洞或半开连接不能把队列 worker
// 永久挂住。该超时只保护队列连接，业务请求不会等待它。
const WRITE_QUERY_TIMEOUT_MS = Math.max(
    10,
    Number.parseInt(process.env.PIVOT_DB_WRITE_QUERY_TIMEOUT_MS, 10) || 15000
);

// PG 单条语句绑定参数上限 65535，按列数换算每批安全行数
function safeBatchRows(columnCount, queueName) {
    const postgresSafeRows = Math.max(1, Math.floor(60000 / Math.max(1, columnCount)));
    const queue = queueName ? pgQueues[queueName] : null;
    const limit = QUEUE_LIMITS[queueName] || DEFAULT_MAX_QUEUE_SIZE;
    const pressure = queue ? Math.max(0, Math.min(1, queue.length / Math.max(1, limit))) : 0;
    // 队列越接近上限，批量越大；始终受 PostgreSQL 参数上限和 burst 上限约束。
    const target = pressure >= QUEUE_HIGH_WATERMARK
        ? Math.ceil(MAX_BATCH_SIZE + (MAX_BURST_BATCH_SIZE - MAX_BATCH_SIZE) * ((pressure - QUEUE_HIGH_WATERMARK) / (1 - QUEUE_HIGH_WATERMARK || 1)))
        : MAX_BATCH_SIZE;
    return Math.max(1, Math.min(postgresSafeRows, MAX_BURST_BATCH_SIZE, target));
}

// ──────────────────────────────────────────────────────────────────────────
// PostgreSQL 异步实现
// ──────────────────────────────────────────────────────────────────────────

const pgQueues = {
    auditLogs: [],
    apiCallLogs: [],
    mcpCallLogs: [],
    modelUsageEvents: [],
};
const pgQueueDropped = {
    auditLogs: 0,
    apiCallLogs: 0,
    mcpCallLogs: 0,
    modelUsageEvents: 0,
};
const pgQueueLastError = {
    auditLogs: null,
    apiCallLogs: null,
    mcpCallLogs: null,
    modelUsageEvents: null,
};
const pgQueueLastSuccessAt = {
    auditLogs: null,
    apiCallLogs: null,
    mcpCallLogs: null,
    modelUsageEvents: null,
};

let pgFlushTimer = null;
let pgFlushTimerDelayMs = 0;
let pgFlushing = null;
const PG_BASE_RETRY_DELAY_MS = Math.max(FLUSH_INTERVAL_MS, 10);
const PG_MAX_RETRY_DELAY_MS = Math.max(PG_BASE_RETRY_DELAY_MS * 16, 1000);
let pgRetryDelayMs = PG_BASE_RETRY_DELAY_MS;
const pgQueueHighWaterAlerted = new Set();

function markQueueSuccess(queueName) {
    pgQueueLastError[queueName] = null;
    pgQueueLastSuccessAt[queueName] = new Date().toISOString();
}

function markQueueError(queueName, err) {
    pgQueueLastError[queueName] = {
        message: String(err?.message || err || '未知数据库错误').slice(0, 500),
        code: err?.code || null,
        at: new Date().toISOString()
    };
}

function pgSchedule(delayMs = FLUSH_INTERVAL_MS) {
    if (QUEUE_DISABLED) return;
    const nextDelay = Math.max(10, Number(delayMs) || FLUSH_INTERVAL_MS);
    if (pgFlushTimer && pgFlushTimerDelayMs <= nextDelay) return;
    if (pgFlushTimer) clearTimeout(pgFlushTimer);
    pgFlushTimer = setTimeout(() => {
        pgFlushTimer = null;
        pgFlushTimerDelayMs = 0;
        pgFlush().catch(err => {
            logger.warn({ err: err.message }, '[PG] 写入队列刷新异常');
        });
    }, nextDelay);
    pgFlushTimerDelayMs = nextDelay;
    pgFlushTimer.unref?.();
}

function pgEnqueue(queueName, item) {
    if (QUEUE_DISABLED) return;
    const queue = pgQueues[queueName];
    if (!queue) throw new Error(`未知数据库写入队列： ${queueName}`);
    if (queue.length >= QUEUE_LIMITS[queueName]) {
        queue.shift();
        pgQueueDropped[queueName] += 1;
        logger.warn({ queueName, max: QUEUE_LIMITS[queueName] }, '[PG] 写入队列溢出，已丢弃最早任务');
    }
    queue.push(item);
    const occupancy = queue.length / Math.max(1, QUEUE_LIMITS[queueName]);
    if (occupancy >= QUEUE_HIGH_WATERMARK) {
        if (!pgQueueHighWaterAlerted.has(queueName)) {
            pgQueueHighWaterAlerted.add(queueName);
            logger.warn({ queueName, pending: queue.length, max: QUEUE_LIMITS[queueName], threshold: QUEUE_HIGH_WATERMARK }, '[PG] 写入队列达到高水位，已启用快速刷新与批量扩展');
        }
        pgSchedule(Math.min(FLUSH_INTERVAL_MS, HIGH_WATERMARK_FLUSH_INTERVAL_MS));
    } else {
        pgQueueHighWaterAlerted.delete(queueName);
        pgSchedule();
    }
}

const UNRECOVERABLE_DB_ERRORS = /invalid input syntax|character not in repertoire|violates foreign key constraint|violates not-null constraint|violates check constraint|value too long|cannot cast/i;

/**
 * 使用独立 client 执行队列写入，以便超时后销毁坏连接。
 * 测试桩可能只提供 pool.query，此时退回普通调用。
 */
async function runPgWriteQuery(pool, sql, params) {
    if (!pool || typeof pool.connect !== 'function') return pool.query(sql, params);

    const client = await pool.connect();
    let released = false;
    let timer = null;
    let timedOut = false;
    const release = (err) => {
        if (released) return;
        released = true;
        try { client.release(err); } catch (_) {}
    };

    const queryPromise = Promise.resolve().then(() => client.query(sql, params));
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            const error = new Error(`数据库写入超时（已等待 ${WRITE_QUERY_TIMEOUT_MS} 毫秒）`);
            error.code = 'PG_WRITE_QUEUE_QUERY_TIMEOUT';
            // release(error) 会让 pg-pool 移除连接；主动断开 socket 可避免半开连接继续占池。
            try { client.connection?.stream?.destroy(); } catch (_) {}
            release(error);
            reject(error);
        }, WRITE_QUERY_TIMEOUT_MS);
        timer.unref?.();
    });

    try {
        return await Promise.race([queryPromise, timeoutPromise]);
    } catch (err) {
        if (!timedOut) release();
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
        if (!released) release();
    }
}

function sanitizeQueueValue(field, val) {
    if (val === undefined || val === null) return null;
    // 整型与主外键列校验：严格防范 Object/Promise/NaN/无效字符传进 PostgreSQL BIGINT/INTEGER 列
    if (/Id|Tokens|Count|durationMs/i.test(field)) {
        if (typeof val === 'number') {
            return Number.isFinite(val) ? (field.endsWith('Id') ? (val > 0 ? Math.floor(val) : null) : Math.floor(val)) : null;
        }
        if (typeof val === 'string') {
            const parsed = parseInt(val, 10);
            return Number.isNaN(parsed) ? null : (field.endsWith('Id') ? (parsed > 0 ? parsed : null) : parsed);
        }
        return null;
    }
    if (field === 'action') {
        const str = String(val || '').trim();
        return str || '系统操作';
    }
    if (field === 'stream') {
        return val === true || val === 1 || val === '1' ? 1 : 0;
    }
    if (typeof val === 'object' && !(val instanceof Date)) {
        try { return JSON.stringify(val); } catch (_) { return String(val); }
    }
    return val;
}

async function pgFlushQueue(queueName) {
    const spec = QUEUE_SPECS[queueName];
    const queue = pgQueues[queueName];
    const batchRows = safeBatchRows(spec.columns.length, queueName);

    // 只取刷新开始时的一批。若生产者持续入队，新记录留给下一轮，保证 flush 本身会返回。
    const batch = queue.splice(0, Math.min(queue.length, batchRows));
    if (batch.length === 0) return;
    const params = [];
    const rowPlaceholders = [];
    let paramIndex = 1;

    for (const item of batch) {
        const placeholders = spec.fields.map(() => `$${paramIndex++}`);
        rowPlaceholders.push(`(${placeholders.join(', ')})`);
        for (const field of spec.fields) {
            params.push(sanitizeQueueValue(field, item[field]));
        }
    }

    const sql = `INSERT INTO "${spec.table}" (${spec.columns.map(c => `"${c}"`).join(', ')}) VALUES ${rowPlaceholders.join(', ')}`;
    let pool = null;

    try {
        const { getPgPool } = require('../db/pg-connection');
        pool = getPgPool();
        await runPgWriteQuery(pool, sql, params);
        markQueueSuccess(queueName);
    } catch (err) {
        const isUnrecoverable = UNRECOVERABLE_DB_ERRORS.test(err.message || '');
        // 网络/连接/超时错误不做逐条降级：逐条尝试只会把一次故障放大成
        // batch.length 次超时。整批回队首并走指数退避，保持故障恢复边界明确。
        if (!isUnrecoverable) {
            queue.unshift(...batch);
            markQueueError(queueName, err);
            throw err;
        }
        // 多行批量失败时逐条降级，避免一条脏数据阻塞整批正常日志。
        if (batch.length > 1) {
            const singleSql = `INSERT INTO "${spec.table}" (${spec.columns.map(c => `"${c}"`).join(', ')}) VALUES (${spec.fields.map((_, i) => `$${i + 1}`).join(', ')})`;
            for (let index = 0; index < batch.length; index += 1) {
                const item = batch[index];
                try {
                    const singleParams = spec.fields.map(f => sanitizeQueueValue(f, item[f]));
                    await runPgWriteQuery(pool, singleSql, singleParams);
                } catch (singleErr) {
                    const singleUnrecoverable = UNRECOVERABLE_DB_ERRORS.test(singleErr.message || '');
                    if (singleUnrecoverable) {
                        logger.error({ err: singleErr.message, queueName, item }, '[PG] 写入队列发生不可恢复数据异常，已隔离单条');
                        continue;
                    }
                    // 当前失败项及其后续项都尚未尝试，必须完整放回队首，不能丢批次尾部数据。
                    queue.unshift(item, ...batch.slice(index + 1));
                    markQueueError(queueName, singleErr);
                    throw singleErr;
                }
            }
            markQueueSuccess(queueName);
            return;
        }

        logger.error({ err: err.message, queueName, batchSample: batch[0] }, '[PG] 写入队列发生不可恢复数据异常，已丢弃');
        markQueueError(queueName, err);
    }
}

async function pgFlush() {
    if (QUEUE_DISABLED) return;
    if (pgFlushing) return pgFlushing;

    pgFlushing = (async () => {
        try {
            let hasError = false;
            // 每个队列本轮最多一批，且并行隔离：审计写入异常不能阻塞 API/MCP/用量队列。
            await Promise.all(Object.keys(pgQueues).map(async queueName => {
                if (pgQueues[queueName].length === 0) return;
                try {
                    await pgFlushQueue(queueName);
                } catch (err) {
                    hasError = true;
                    logger.warn(
                        { err: err.message, queueName, pending: pgQueues[queueName].length },
                        '[PG] 写入队列刷新失败，稍后重试'
                    );
                }
            }));
            if (hasError) {
                pgRetryDelayMs = Math.min(PG_MAX_RETRY_DELAY_MS, Math.max(PG_BASE_RETRY_DELAY_MS, pgRetryDelayMs * 2));
                pgSchedule(pgRetryDelayMs);
            } else {
                pgRetryDelayMs = PG_BASE_RETRY_DELAY_MS;
            }
        } finally {
            pgFlushing = null;
            const stillPending = Object.values(pgQueues).some(q => q.length > 0);
            if (stillPending && !pgFlushTimer) {
                pgSchedule();
            }
        }
    })();

    return pgFlushing;
}

async function pgFlushAll() {
    if (QUEUE_DISABLED) return;
    if (pgFlushTimer) {
        clearTimeout(pgFlushTimer);
        pgFlushTimer = null;
        pgFlushTimerDelayMs = 0;
    }
    while (pgFlushing) {
        await pgFlushing;
    }
    for (let i = 0; i < 50; i += 1) {
        const remaining = Object.values(pgQueues).reduce((sum, q) => sum + q.length, 0);
        if (remaining === 0) return;
        await pgFlush();
        while (pgFlushing) {
            await pgFlushing;
        }
        const after = Object.values(pgQueues).reduce((sum, q) => sum + q.length, 0);
        if (after === 0) return;
        if (after >= remaining) return;
    }
}

function pgPendingModelUsageTotal(userId, modelId, datePrefix) {
    const uid = Number(userId);
    const mid = Number(modelId);
    if (!uid || !mid) return 0;
    return pgQueues.modelUsageEvents.reduce((sum, item) => {
        if (Number(item.userId) !== uid || Number(item.modelId) !== mid) return sum;
        if (datePrefix && !String(item.createdAt || '').startsWith(datePrefix)) return sum;
        return sum + Number(item.tokenCount || 0);
    }, 0);
}

function pgQueueStatus() {
    return Object.fromEntries(Object.entries(pgQueues).map(([name, queue]) => [name, queue.length]));
}

function pgQueueDiagnostics() {
    return Object.fromEntries(Object.entries(pgQueues).map(([name, queue]) => [name, {
        pending: queue.length,
        dropped: pgQueueDropped[name] || 0,
        max: QUEUE_LIMITS[name],
        lastError: pgQueueLastError[name],
        lastSuccessAt: pgQueueLastSuccessAt[name]
    }]));
}

// ──────────────────────────────────────────────────────────────────────────
function enqueueAuditLog(item) {
    return pgEnqueue('auditLogs', item);
}

function enqueueApiCallLog(item) {
    return pgEnqueue('apiCallLogs', item);
}

function enqueueMcpCallLog(item) {
    return pgEnqueue('mcpCallLogs', item);
}

function enqueueModelUsageEvent(item) {
    return pgEnqueue('modelUsageEvents', item);
}

/**
 * 触发一次刷新（不保证刷完）
 */
function flushWriteQueue() {
    return pgFlush();
}

/**
 * 刷空全部队列。
 * 返回 Promise —— 需要确保落库的调用方应 await。
 */
function flushAllWrites() {
    return pgFlushAll();
}

function getPendingModelUsageTotal(userId, modelId, datePrefix) {
    return pgPendingModelUsageTotal(userId, modelId, datePrefix);
}

function getQueueStatus() {
    return pgQueueStatus();
}

function getQueueDiagnostics() {
    return pgQueueDiagnostics();
}

module.exports = {
    enqueueAuditLog,
    enqueueApiCallLog,
    enqueueMcpCallLog,
    enqueueModelUsageEvent,
    flushAllWrites,
    flushWriteQueue,
    getPendingModelUsageTotal,
    getQueueStatus,
    getQueueDiagnostics,
};

// 退出前落库
process.once('beforeExit', () => {
    pgFlushAll().catch(err => {
        logger.warn({ err: err.message }, '[PG] 退出时写入队列刷新失败');
    });
});
