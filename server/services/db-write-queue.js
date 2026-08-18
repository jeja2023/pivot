/**
 * server/services/db-write-queue.js
 * 高频日志写入队列（SQLite / PostgreSQL 双模式门面）
 *
 * 审计日志、API 调用日志、MCP 调用日志、模型用量事件都是「高频、可容忍毫秒级
 * 延迟、不可阻塞主链路」的写入。本模块把它们缓冲成批，攒批落库。
 *
 * 模式路由：
 *  - SQLite：委托给 services/sqlite-write-queue.js（同步事务，行为保持不变）
 *  - PostgreSQL：本模块内的异步实现，多行 VALUES 批量 INSERT
 *
 * 对外 API 与 sqlite-write-queue.js 完全一致，调用方无需感知方言。
 * 注意 flushAllSqliteWrites() 在 PG 模式下返回 Promise：进程退出路径若需
 * 确保落库，应改用 await flushAllWrites()。
 */
const { logger } = require('../logger');

// ──────────────────────────────────────────────────────────────────────────
// 队列定义（两种方言共用的列映射）
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

const QUEUE_LIMITS = {
    auditLogs: Number.parseInt(process.env.PIVOT_SQLITE_AUDIT_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    apiCallLogs: Number.parseInt(process.env.PIVOT_SQLITE_API_LOG_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    mcpCallLogs: Number.parseInt(process.env.PIVOT_SQLITE_MCP_LOG_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    modelUsageEvents: Number.parseInt(process.env.PIVOT_SQLITE_USAGE_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
};

const FLUSH_INTERVAL_MS = Number.parseInt(process.env.PIVOT_SQLITE_WRITE_FLUSH_MS, 10) || DEFAULT_FLUSH_INTERVAL_MS;
const MAX_BATCH_SIZE = Number.parseInt(process.env.PIVOT_SQLITE_WRITE_BATCH_SIZE, 10) || DEFAULT_MAX_BATCH_SIZE;

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

let pgFlushTimer = null;
let pgFlushing = null;
const PG_BASE_RETRY_DELAY_MS = Math.max(FLUSH_INTERVAL_MS, 10);
const PG_MAX_RETRY_DELAY_MS = Math.max(PG_BASE_RETRY_DELAY_MS * 16, 1000);
let pgRetryDelayMs = PG_BASE_RETRY_DELAY_MS;

function pgSchedule(delayMs = FLUSH_INTERVAL_MS) {
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
    const queue = pgQueues[queueName];
    if (!queue) throw new Error(`未知数据库写入队列： ${queueName}`);
    if (queue.length >= QUEUE_LIMITS[queueName]) {
        queue.shift();
        logger.warn({ queueName, max: QUEUE_LIMITS[queueName] }, '[PG] 写入队列溢出，已丢弃最早任务');
    }
    queue.push(item);
    pgSchedule();
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
                params.push(item[field] === undefined ? null : item[field]);
            }
        }

        const sql = `INSERT INTO "${spec.table}" (${spec.columns.map(c => `"${c}"`).join(', ')}) VALUES ${rowPlaceholders.join(', ')}`;

        try {
            const { getPgPool } = require('../db/pg-connection');
            await getPgPool().query(sql, params);
        } catch (err) {
            // 失败的批次退回队首，指数退避后重试，避免丢日志
            queue.unshift(...batch);
            throw err;
        }
    }
}

async function pgFlush() {
    if (pgFlushing) return pgFlushing;

    pgFlushing = (async () => {
        try {
            for (const queueName of Object.keys(pgQueues)) {
                if (pgQueues[queueName].length === 0) continue;
                try {
                    await pgFlushQueue(queueName);
                } catch (err) {
                    logger.warn(
                        { err: err.message, queueName, pending: pgQueues[queueName].length },
                        '[PG] 写入队列刷新失败，稍后重试'
                    );
                    pgRetryDelayMs = Math.min(PG_MAX_RETRY_DELAY_MS, Math.max(PG_BASE_RETRY_DELAY_MS, pgRetryDelayMs * 2));
                    pgSchedule(pgRetryDelayMs);
                    return;
                }
            }
            pgRetryDelayMs = PG_BASE_RETRY_DELAY_MS;
        } finally {
            pgFlushing = null;
        }
    })();

    return pgFlushing;
}

async function pgFlushAll() {
    if (pgFlushTimer) {
        clearTimeout(pgFlushTimer);
        pgFlushTimer = null;
    }
    // 队列可能在刷新过程中继续积压，循环到清空或不再收敛为止
    for (let i = 0; i < 50; i += 1) {
        const before = Object.values(pgQueues).reduce((sum, q) => sum + q.length, 0);
        if (before === 0) return;
        await pgFlush();
        const after = Object.values(pgQueues).reduce((sum, q) => sum + q.length, 0);
        if (after >= before) return;
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

// ──────────────────────────────────────────────────────────────────────────
// 模式路由（SQLite 侧懒加载，避免 PG 模式下触发 db.prepare 于 null）
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
 * PG 模式返回 Promise —— 需要确保落库的调用方应 await。
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

module.exports = {
    enqueueAuditLog,
    enqueueApiCallLog,
    enqueueMcpCallLog,
    enqueueModelUsageEvent,
    flushAllWrites,
    flushWriteQueue,
    getPendingModelUsageTotal,
    getQueueStatus,
    // 向后兼容别名
    flushAllSqliteWrites: flushAllWrites,
    flushSqliteWriteQueue: flushWriteQueue,
};

// PostgreSQL 模式下退出前落库
process.once('beforeExit', () => {
    pgFlushAll().catch(err => {
        logger.warn({ err: err.message }, '[PG] 退出时写入队列刷新失败');
    });
});

