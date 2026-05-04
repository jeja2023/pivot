/* AI concurrency protection */
const { logger } = require('../logger');

const parsePositiveInt = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

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
        this.queueTimeoutMs = Math.max(1000, options.queueTimeoutMs || 60000);
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

    async acquire() {
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
            logger.info({
                queueLength: this.queue.length,
                active: this.currentConcurrent,
                max: this.maxConcurrent
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
    maxConcurrent: parsePositiveInt(process.env.MAX_CONCURRENT_AI_REQUESTS, 5),
    maxQueueSize: parsePositiveInt(process.env.MAX_AI_QUEUE_SIZE, 20),
    queueTimeoutMs: parsePositiveInt(process.env.AI_QUEUE_TIMEOUT_MS, 60000)
});

module.exports = {
    aiSemaphore,
    ConcurrencyLimitError
};
