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
const QUEUE_DISABLED = /^(1|true|yes)$/i.test(String(process.env.PIVOT_DB_WRITE_QUEUE_DISABLED || ''));

const QUEUE_LIMITS = {
    auditLogs: Number.parseInt(process.env.PIVOT_DB_AUDIT_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    apiCallLogs: Number.parseInt(process.env.PIVOT_DB_API_LOG_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    mcpCallLogs: Number.parseInt(process.env.PIVOT_DB_MCP_LOG_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    modelUsageEvents: Number.parseInt(process.env.PIVOT_DB_USAGE_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
};

const FLUSH_INTERVAL_MS = Number.parseInt(process.env.PIVOT_DB_WRITE_FLUSH_MS, 10) || DEFAULT_FLUSH_INTERVAL_MS;
const MAX_BATCH_SIZE = Number.parseInt(process.env.PIVOT_DB_WRITE_BATCH_SIZE, 10) || DEFAULT_MAX_BATCH_SIZE;

// PG 单条语句绑定参数上限 65535，按列数换算每批安全行数
function safeBatchRows(columnCount) {
    return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(60000 / Math.max(1, columnCount))));
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

let pgFlushTimer = null;
let pgFlushing = null;
const PG_BASE_RETRY_DELAY_MS = Math.max(FLUSH_INTERVAL_MS, 10);
const PG_MAX_RETRY_DELAY_MS = Math.max(PG_BASE_RETRY_DELAY_MS * 16, 1000);
let pgRetryDelayMs = PG_BASE_RETRY_DELAY_MS;

function pgSchedule(delayMs = FLUSH_INTERVAL_MS) {
    if (QUEUE_DISABLED) return;
    if (pgFlushTimer) return;
    pgFlushTimer = setTimeout(() => {
        pgFlushTimer = null;
        pgFlush().catch(err => {
            logger.warn({ err: err.message }, '[PG] 写入队列刷新异常');
        });
    }, Math.max(10, delayMs));
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
    pgSchedule();
}

const UNRECOVERABLE_DB_ERRORS = /invalid input syntax|character not in repertoire|violates foreign key constraint|violates not-null constraint|violates check constraint|value too long|cannot cast/i;

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
    const batchRows = safeBatchRows(spec.columns.length);

    while (queue.length > 0) {
        const batch = queue.splice(0, batchRows);
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

        try {
            const { getPgPool } = require('../db/pg-connection');
            await getPgPool().query(sql, params);
        } catch (err) {
            const isUnrecoverable = UNRECOVERABLE_DB_ERRORS.test(err.message || '');
            // 如果是多条记录批量写入失败，先降级尝试单行逐条插入，避免 1 条脏数据阻塞整批 50 条正常日志
            if (batch.length > 1) {
                const { getPgPool } = require('../db/pg-connection');
                const pool = getPgPool();
                const singleSql = `INSERT INTO "${spec.table}" (${spec.columns.map(c => `"${c}"`).join(', ')}) VALUES (${spec.fields.map((_, i) => `$${i + 1}`).join(', ')})`;
                for (const item of batch) {
                    try {
                        const singleParams = spec.fields.map(f => sanitizeQueueValue(f, item[f]));
                        await pool.query(singleSql, singleParams);
                    } catch (singleErr) {
                        const singleUnrecoverable = UNRECOVERABLE_DB_ERRORS.test(singleErr.message || '');
                        if (singleUnrecoverable) {
                            logger.error({ err: singleErr.message, queueName, item }, '[PG] 写入队列发生不可恢复数据异常，已隔离单条');
                        } else {
                            // 临时数据库连接异常，单条放回队首并抛出重试
                            queue.unshift(item);
                            throw singleErr;
                        }
                    }
                }
            } else {
                if (isUnrecoverable) {
                    logger.error({ err: err.message, queueName, batchSample: batch[0] }, '[PG] 写入队列发生不可恢复数据异常，已丢弃');
                } else {
                    queue.unshift(...batch);
                    throw err;
                }
            }
        }
    }
}

async function pgFlush() {
    if (QUEUE_DISABLED) return;
    if (pgFlushing) return pgFlushing;

    pgFlushing = (async () => {
        try {
            let hasError = false;
            for (const queueName of Object.keys(pgQueues)) {
                if (pgQueues[queueName].length === 0) continue;
                try {
                    await pgFlushQueue(queueName);
                } catch (err) {
                    hasError = true;
                    logger.warn(
                        { err: err.message, queueName, pending: pgQueues[queueName].length },
                        '[PG] 写入队列刷新失败，稍后重试'
                    );
                }
            }
            if (hasError) {
                pgRetryDelayMs = Math.min(PG_MAX_RETRY_DELAY_MS, Math.max(PG_BASE_RETRY_DELAY_MS, pgRetryDelayMs * 2));
                pgSchedule(pgRetryDelayMs);
            } else {
                pgRetryDelayMs = PG_BASE_RETRY_DELAY_MS;
            }
        } finally {
            pgFlushing = null;
        }
    })();

    return pgFlushing;
}

async function pgFlushAll() {
    if (QUEUE_DISABLED) return;
    if (pgFlushTimer) {
        clearTimeout(pgFlushTimer);
        pgFlushTimer = null;
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
        max: QUEUE_LIMITS[name]
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
