/* AI concurrency protection */
const { logger } = require('../logger');
const { getGlobalAiConcurrencyConfig } = require('./runtime-settings');

class ConcurrencyLimitError extends Error {
    constructor(message, code = 'AI_QUEUE_FULL') {
        super(message);
        this.name = 'ConcurrencyLimitError';
        this.code = code;
        this.statusCode = 503;
    }
}

class ConcurrencySemaphore {
    constructor(options = {}) {
        this.maxConcurrent = Math.max(1, options.maxConcurrent || 10);
        this.maxQueueSize = Math.max(0, options.maxQueueSize ?? 20);
        this.queueTimeoutMs = Math.max(1000, options.queueTimeoutMs || 300000);
        this.currentConcurrent = 0;
        this.queue = [];
        this.rejectingNewRequests = false;
        this.rejectReason = '';
    }

    setRejectingNewRequests(enabled, reason = '') {
        const nextEnabled = Boolean(enabled);
        if (this.rejectingNewRequests === nextEnabled && this.rejectReason === reason) return;
        this.rejectingNewRequests = nextEnabled;
        this.rejectReason = nextEnabled ? reason : '';
        logger.warn({
            rejectingNewRequests: this.rejectingNewRequests,
            reason: this.rejectReason
        }, nextEnabled ? 'AI 请求保护已开启' : 'AI 请求保护已恢复');
    }

    async acquire(options = {}) {
        const onQueued = typeof options.onQueued === 'function' ? options.onQueued : null;

        if (this.rejectingNewRequests) {
            throw new ConcurrencyLimitError(
                this.rejectReason || '模型服务当前负载过高，请稍后重试。',
                'AI_OVERLOADED'
            );
        }

        if (this.currentConcurrent < this.maxConcurrent) {
            this.currentConcurrent += 1;
            return;
        }

        if (this.queue.length >= this.maxQueueSize) {
            throw new ConcurrencyLimitError(
                `模型服务排队已满，请稍后重试。当前排队 ${this.queue.length}/${this.maxQueueSize}`,
                'AI_QUEUE_FULL'
            );
        }

        return new Promise((resolve, reject) => {
            const item = {
                resolve,
                reject,
                createdAt: Date.now(),
                timer: null
            };

            item.timer = setTimeout(() => {
                const index = this.queue.indexOf(item);
                if (index >= 0) this.queue.splice(index, 1);
                reject(new ConcurrencyLimitError(
                    `模型服务排队超时，请稍后重试。超时时间 ${Math.round(this.queueTimeoutMs / 1000)} 秒`,
                    'AI_QUEUE_TIMEOUT'
                ));
            }, this.queueTimeoutMs);

            this.queue.push(item);
            const queueInfo = {
                position: this.queue.length,
                queueAhead: Math.max(0, this.queue.length - 1),
                queueLength: this.queue.length,
                active: this.currentConcurrent,
                max: this.maxConcurrent,
                maxQueue: this.maxQueueSize,
                queueTimeoutMs: this.queueTimeoutMs
            };
            if (onQueued) {
                try {
                    onQueued(queueInfo);
                } catch (e) {
                    logger.warn({ err: e.message }, 'AI 排队提醒回调执行失败');
                }
            }
            logger.info({
                ...queueInfo
            }, 'AI 并发已满，请求进入排队');
        });
    }

    rejectQueuedRequests(reason, code = 'AI_OVERLOADED') {
        if (this.queue.length === 0) return 0;
        const queued = this.queue.splice(0);
        queued.forEach(item => clearTimeout(item.timer));
        const error = new ConcurrencyLimitError(reason, code);
        queued.forEach(item => item.reject(error));
        logger.warn({
            count: queued.length,
            code
        }, 'AI 队列已被保护策略清空');
        return queued.length;
    }

    release() {
        this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
        this.drainQueue();
    }

    drainQueue() {
        while (!this.rejectingNewRequests && this.currentConcurrent < this.maxConcurrent && this.queue.length > 0) {
            const item = this.queue.shift();
            clearTimeout(item.timer);
            this.currentConcurrent += 1;
            item.resolve();
        }
    }

    updateMaxConcurrent(newMax) {
        const oldMax = this.maxConcurrent;
        this.maxConcurrent = Math.max(1, parseInt(newMax, 10) || oldMax);
        if (this.maxConcurrent !== oldMax) {
            logger.info({ old: oldMax, next: this.maxConcurrent }, 'AI 并发限制已动态调整');
        }
        if (this.maxConcurrent > oldMax) this.drainQueue();
    }

    updateLimits(options = {}) {
        const oldMax = this.maxConcurrent;
        const oldQueue = this.maxQueueSize;
        const oldTimeout = this.queueTimeoutMs;
        const nextMax = Number.parseInt(options.maxConcurrent, 10);
        const nextQueue = Number.parseInt(options.maxQueueSize, 10);
        const nextTimeout = Number.parseInt(options.queueTimeoutMs, 10);

        if (Number.isFinite(nextMax) && nextMax > 0) this.maxConcurrent = nextMax;
        if (Number.isFinite(nextQueue) && nextQueue >= 0) this.maxQueueSize = nextQueue;
        if (Number.isFinite(nextTimeout) && nextTimeout >= 1000) this.queueTimeoutMs = nextTimeout;

        if (this.maxConcurrent !== oldMax || this.maxQueueSize !== oldQueue || this.queueTimeoutMs !== oldTimeout) {
            logger.info({
                old: { maxConcurrent: oldMax, maxQueueSize: oldQueue, queueTimeoutMs: oldTimeout },
                next: {
                    maxConcurrent: this.maxConcurrent,
                    maxQueueSize: this.maxQueueSize,
                    queueTimeoutMs: this.queueTimeoutMs
                }
            }, 'AI 并发限制已动态调整');
        }
        if (this.maxConcurrent > oldMax) this.drainQueue();
    }

    getStatus() {
        return {
            active: this.currentConcurrent,
            queued: this.queue.length,
            max: this.maxConcurrent,
            maxQueue: this.maxQueueSize,
            queueTimeoutMs: this.queueTimeoutMs,
            rejectingNewRequests: this.rejectingNewRequests,
            rejectReason: this.rejectReason,
            oldestQueuedMs: this.queue.length > 0 ? Date.now() - this.queue[0].createdAt : 0
        };
    }
}

const aiSemaphore = new ConcurrencySemaphore({
    maxConcurrent: getGlobalAiConcurrencyConfig().maxConcurrent,
    maxQueueSize: getGlobalAiConcurrencyConfig().maxQueueSize,
    queueTimeoutMs: getGlobalAiConcurrencyConfig().queueTimeoutMs
});

function syncGlobalAiConcurrencySettings() {
    aiSemaphore.updateLimits(getGlobalAiConcurrencyConfig());
    return aiSemaphore.getStatus();
}

// 数据分析的重型 DuckDB 查询（图表/比对/导出/详情预览）独立限流，
// 避免大表并发查询瞬间吃满 CPU/内存，且与 AI 调用的信号量隔离互不影响。
const analysisSemaphore = new ConcurrencySemaphore({
    maxConcurrent: Math.max(1, Number.parseInt(process.env.DATA_ANALYSIS_MAX_CONCURRENT || '4', 10) || 4),
    maxQueueSize: Math.max(0, Number.parseInt(process.env.DATA_ANALYSIS_MAX_QUEUE || '16', 10) || 16),
    queueTimeoutMs: Math.max(1000, Number.parseInt(process.env.DATA_ANALYSIS_QUEUE_TIMEOUT_MS || '120000', 10) || 120000)
});

class TimeoutError extends Error {
    constructor(message, code = 'OPERATION_TIMEOUT') {
        super(message);
        this.name = 'TimeoutError';
        this.code = code;
    }
}

/**
 * 为任意 Promise 加超时保护，超时后抛出 TimeoutError。
 * 调用方需自行实现取消逻辑（例如关闭网络请求），本工具仅控制等待时间。
 */
function withTimeout(promiseFactory, timeoutMs, label = '操作') {
    const ms = Math.max(1000, Number(timeoutMs) || 0);
    return new Promise((resolve, reject) => {
        let settled = false;
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (controller) controller.abort();
            reject(new TimeoutError(`${label}超时（${Math.round(ms / 1000)} 秒）`));
        }, ms);
        Promise.resolve()
            .then(() => typeof promiseFactory === 'function' ? promiseFactory(controller?.signal) : promiseFactory)
            .then(value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            })
            .catch(err => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
    });
}

/**
 * 简单的"键限并发"调度器：相同 key 同时只允许一个任务执行；
 * 总并发上限独立控制，超出会按 key 维度排队。
 * 用于压缩记忆、智能体后台任务等"同会话不重复触发"的场景。
 */
class KeyedConcurrencyGuard {
    constructor(options = {}) {
        this.maxGlobal = Math.max(1, options.maxConcurrent || 4);
        this.running = new Set();
        this.pending = new Map();
    }

    isRunning(key) {
        return this.running.has(String(key));
    }

    updateMaxConcurrent(newMaxConcurrent) {
        const next = Math.max(1, Number.parseInt(newMaxConcurrent, 10) || this.maxGlobal);
        this.maxGlobal = next;
        return this.maxGlobal;
    }

    async run(key, task) {
        const id = String(key);
        if (this.running.has(id)) {
            return { skipped: true, reason: 'duplicate' };
        }
        if (this.running.size >= this.maxGlobal) {
            return { skipped: true, reason: 'too_many' };
        }
        this.running.add(id);
        try {
            const value = await task();
            return { skipped: false, value };
        } finally {
            this.running.delete(id);
        }
    }
}

module.exports = {
    aiSemaphore,
    analysisSemaphore,
    ConcurrencySemaphore,
    ConcurrencyLimitError,
    TimeoutError,
    syncGlobalAiConcurrencySettings,
    withTimeout,
    KeyedConcurrencyGuard
};
