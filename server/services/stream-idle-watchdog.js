/**
 * server/services/stream-idle-watchdog.js
 * 上游流式响应的空闲看门狗。
 *
 * 为什么必须有：axios 的 `timeout` 对 `responseType: 'stream'` 只覆盖「发出请求到收到
 * 响应头」这一段，**不覆盖流体传输**。上游把头发完就静默挂住（网络黑洞、反代半开连接、
 * 模型服务假死）时，Node 侧既不会收到 'end' 也不会收到 'error'，于是：
 *   - aiSemaphore 与模型端点的并发许可被永久持有；
 *   - 客户端 socket 与整段消息历史（大对象）永久驻留；
 * 二者都只能靠重启进程释放。看门狗在「多久没有收到任何字节」这个维度上补上超时。
 *
 * 实现取「记录最后活跃时间 + 周期检查」而非「每个数据块重置定时器」：
 * token 级流式每秒会有几十上百个数据块，逐块 clearTimeout/setTimeout 是无谓开销。
 * 这与 services/sse-response.js 的心跳实现保持同一种写法。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const MIN_IDLE_TIMEOUT_MS = 5_000;
const MIN_CHECK_INTERVAL_MS = 1_000;

/**
 * 解析空闲超时配置。显式 0 或非法值表示关闭看门狗。
 * @param {string|number|undefined} value
 * @returns {number} 毫秒；0 表示不启用
 */
function resolveStreamIdleTimeoutMs(value = process.env.MODEL_STREAM_IDLE_TIMEOUT_MS) {
    if (value === undefined || value === null || value === '') return DEFAULT_IDLE_TIMEOUT_MS;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.max(MIN_IDLE_TIMEOUT_MS, parsed);
}

/**
 * 创建一个空闲看门狗。
 * @param {object} options
 * @param {number} [options.idleMs] 空闲阈值；省略时读环境变量，0 表示不启用
 * @param {(idleMs:number)=>void} options.onIdle 判定空闲后的回调，只会被调用一次
 * @param {() => number} [options.now] 便于测试注入时钟
 * @param {typeof setInterval} [options.setIntervalFn]
 * @param {typeof clearInterval} [options.clearIntervalFn]
 * @returns {{enabled:boolean, touch:()=>void, stop:()=>void, idleMs:number}}
 */
function createStreamIdleWatchdog({
    idleMs,
    onIdle,
    now = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
} = {}) {
    const timeoutMs = idleMs === undefined ? resolveStreamIdleTimeoutMs() : resolveStreamIdleTimeoutMs(idleMs);
    if (timeoutMs <= 0 || typeof onIdle !== 'function') {
        return { enabled: false, idleMs: 0, touch() {}, stop() {} };
    }

    let lastActivityAt = now();
    let stopped = false;
    let fired = false;

    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearIntervalFn(timer);
    };

    const timer = setIntervalFn(() => {
        if (stopped || fired) return;
        if (now() - lastActivityAt < timeoutMs) return;
        // 只触发一次：回调里会中止上游并结束响应，重复触发会造成重复写响应。
        fired = true;
        stop();
        onIdle(timeoutMs);
    }, Math.max(MIN_CHECK_INTERVAL_MS, Math.floor(timeoutMs / 2)));
    timer.unref?.();

    return {
        enabled: true,
        idleMs: timeoutMs,
        touch() {
            if (stopped || fired) return;
            lastActivityAt = now();
        },
        stop
    };
}

module.exports = {
    DEFAULT_IDLE_TIMEOUT_MS,
    MIN_IDLE_TIMEOUT_MS,
    createStreamIdleWatchdog,
    resolveStreamIdleTimeoutMs
};
