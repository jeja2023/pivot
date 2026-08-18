/**
 * server/services/sqlite-write-queue.js
 * SQLite 专属写入队列实现（同步事务攒批）
 *
 * 业务代码不应直接引用本模块 —— 请统一使用 services/db-write-queue.js，
 * 它会按 PIVOT_DB_DIALECT 路由到 SQLite 或 PostgreSQL 实现。
 * 本模块在 PG 模式下不会被加载（顶层 db.prepare 依赖 SQLite 连接）。
 */
const { db } = require('../db');
const { logger } = require('../logger');

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_QUEUE_SIZE = 5000;
const SYNC_MODE = /^(1|true|yes)$/i.test(String(process.env.PIVOT_SQLITE_WRITE_QUEUE_SYNC || ''));

const QUEUE_LIMITS = {
    auditLogs: Number.parseInt(process.env.PIVOT_SQLITE_AUDIT_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    apiCallLogs: Number.parseInt(process.env.PIVOT_SQLITE_API_LOG_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    mcpCallLogs: Number.parseInt(process.env.PIVOT_SQLITE_MCP_LOG_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE,
    modelUsageEvents: Number.parseInt(process.env.PIVOT_SQLITE_USAGE_QUEUE_MAX, 10) || DEFAULT_MAX_QUEUE_SIZE
};

const FLUSH_INTERVAL_MS = Number.parseInt(process.env.PIVOT_SQLITE_WRITE_FLUSH_MS, 10) || DEFAULT_FLUSH_INTERVAL_MS;
const MAX_BATCH_SIZE = Number.parseInt(process.env.PIVOT_SQLITE_WRITE_BATCH_SIZE, 10) || DEFAULT_MAX_BATCH_SIZE;

const queues = {
    auditLogs: [],
    apiCallLogs: [],
    mcpCallLogs: [],
    modelUsageEvents: []
};

let flushTimer = null;
let flushing = false;
const BASE_RETRY_DELAY_MS = Math.max(FLUSH_INTERVAL_MS, 10);
const MAX_RETRY_DELAY_MS = Math.max(BASE_RETRY_DELAY_MS * 16, 1000);
let retryDelayMs = BASE_RETRY_DELAY_MS;

const statements = {
    auditLogs: db.prepare(`
        INSERT INTO audit_logs (user_id, action, details, ip_address, timestamp)
        VALUES (@userId, @action, @details, @ipAddress, @timestamp)
    `),
    apiCallLogs: db.prepare(`
        INSERT INTO api_call_logs (
            user_id, api_key_id, model_id, model_name, request_messages, response_text,
            status, error_message, input_tokens, output_tokens, total_tokens, stream,
            ip_address, created_at
        ) VALUES (
            @userId, @apiKeyId, @modelId, @modelName, @requestMessages, @responseText,
            @status, @errorMessage, @inputTokens, @outputTokens, @totalTokens, @stream,
            @ipAddress, @createdAt
        )
    `),
    mcpCallLogs: db.prepare(`
        INSERT INTO mcp_call_logs (
            user_id, server_id, tool_name, source, status, duration_ms,
            input_preview, output_preview, error_message, created_at
        ) VALUES (
            @userId, @serverId, @toolName, @source, @status, @durationMs,
            @inputPreview, @outputPreview, @errorMessage, @createdAt
        )
    `),
    modelUsageEvents: db.prepare(`
        INSERT INTO model_usage_events (user_id, model_id, source, token_count, input_tokens, output_tokens, created_at)
        VALUES (@userId, @modelId, @source, @tokenCount, @inputTokens, @outputTokens, @createdAt)
    `)
};

const transactions = Object.fromEntries(
    Object.entries(statements).map(([name, statement]) => [
        name,
        db.transaction((items) => {
            for (const item of items) statement.run(item);
        })
    ])
);

function scheduleFlush(delayMs = FLUSH_INTERVAL_MS) {
    if (flushTimer) return;
    if (SYNC_MODE) {
        flushAllSqliteWrites();
        return;
    }
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushSqliteWriteQueue();
    }, Math.max(10, delayMs));
    flushTimer.unref?.();
}

function scheduleRetryFlush() {
    if (SYNC_MODE) return;
    retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, Math.max(BASE_RETRY_DELAY_MS, retryDelayMs * 2));
    scheduleFlush(retryDelayMs);
}

function enqueue(queueName, item) {
    const queue = queues[queueName];
    if (!queue) throw new Error(`未知 SQLite 写入队列： ${queueName}`);
    if (queue.length >= QUEUE_LIMITS[queueName]) {
        queue.shift();
        logger.warn({ queueName, max: QUEUE_LIMITS[queueName] }, 'SQLite 写入队列溢出，已丢弃最早任务');
    }
    queue.push(item);
    if (SYNC_MODE) {
        flushAllSqliteWrites();
    } else {
        scheduleFlush();
    }
}

function takeBatch(queueName) {
    const queue = queues[queueName];
    if (!queue || queue.length === 0) return [];
    return queue.splice(0, Math.max(1, MAX_BATCH_SIZE));
}

function flushSqliteWriteQueue() {
    if (flushing) return;
    flushing = true;
    try {
        let didWork = false;
        while (Object.values(queues).some(queue => queue.length > 0)) {
            let progressed = false;
            for (const queueName of Object.keys(queues)) {
                const batch = takeBatch(queueName);
                if (batch.length === 0) continue;
                progressed = true;
                didWork = true;
                try {
                    transactions[queueName](batch);
                } catch (err) {
                    logger.warn({ err: err.message, queueName, count: batch.length }, 'SQLite 写入队列刷新失败，稍后重试');
                    queues[queueName].unshift(...batch);
                    scheduleRetryFlush();
                    return;
                }
            }
            if (!SYNC_MODE || !progressed) break;
        }
        retryDelayMs = BASE_RETRY_DELAY_MS;
        if (!SYNC_MODE && didWork && Object.values(queues).some(queue => queue.length > 0)) scheduleFlush();
    } finally {
        flushing = false;
    }
}

function flushAllSqliteWrites() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    while (Object.values(queues).some(queue => queue.length > 0)) {
        const before = Object.values(queues).reduce((sum, queue) => sum + queue.length, 0);
        flushSqliteWriteQueue();
        const after = Object.values(queues).reduce((sum, queue) => sum + queue.length, 0);
        if (after >= before) break;
    }
}

function getPendingModelUsageTotal(userId, modelId, datePrefix) {
    const uid = Number(userId);
    const mid = Number(modelId);
    if (!uid || !mid) return 0;
    return queues.modelUsageEvents.reduce((sum, item) => {
        if (Number(item.userId) !== uid || Number(item.modelId) !== mid) return sum;
        if (datePrefix && !String(item.createdAt || '').startsWith(datePrefix)) return sum;
        return sum + Number(item.tokenCount || 0);
    }, 0);
}

function getQueueStatus() {
    return Object.fromEntries(Object.entries(queues).map(([name, queue]) => [name, queue.length]));
}

module.exports = {
    enqueueAuditLog: (item) => enqueue('auditLogs', item),
    enqueueApiCallLog: (item) => enqueue('apiCallLogs', item),
    enqueueMcpCallLog: (item) => enqueue('mcpCallLogs', item),
    enqueueModelUsageEvent: (item) => enqueue('modelUsageEvents', item),
    flushAllSqliteWrites,
    flushSqliteWriteQueue,
    getPendingModelUsageTotal,
    getQueueStatus
};

process.once('beforeExit', () => {
    try {
        flushAllSqliteWrites();
    } catch (err) {
        logger.warn({ err: err && err.message ? err.message : err }, '退出时 SQLite 写入队列刷新失败');
    }
});