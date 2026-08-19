const DEFAULT_SSE_HEARTBEAT_MS = 15000;
const MIN_SSE_HEARTBEAT_MS = 1000;
const MAX_SSE_HEARTBEAT_MS = 60000;

function normalizeSseHeartbeatMs(value = process.env.SSE_HEARTBEAT_MS) {
    if (value === 0 || value === '0') return 0;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_SSE_HEARTBEAT_MS;
    return Math.min(Math.max(parsed, MIN_SSE_HEARTBEAT_MS), MAX_SSE_HEARTBEAT_MS);
}

function setSseResponseHeaders(res, options = {}) {
    res.setHeader('Content-Type', options.contentType || 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.socket?.setNoDelay?.(true);
    res.socket?.setKeepAlive?.(true);
    res.flushHeaders?.();
}

function encodeSseComment(comment = 'keep-alive') {
    const lines = String(comment || 'keep-alive').replace(/[\r\n]+/g, '\n').split('\n');
    return `${lines.map(line => `: ${line}`).join('\n')}\n\n`;
}

function encodeSseData(payload, event = '') {
    const prefix = event ? `event: ${String(event).replace(/[\r\n]+/g, '')}\n` : '';
    const value = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const data = String(value).split(/\r?\n/).map(line => `data: ${line}`).join('\n');
    return `${prefix}${data}\n\n`;
}

function createSseResponseWriter(res, options = {}) {
    if (options.setHeaders !== false) setSseResponseHeaders(res, options);

    const heartbeatMs = normalizeSseHeartbeatMs(options.heartbeatMs);
    let lastActivityAt = Date.now();
    let closed = false;
    let timer = null;

    const isWritable = () => !closed && !res.writableEnded && !res.destroyed;
    const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
    };
    const writeRaw = chunk => {
        if (!isWritable()) {
            cleanup();
            return false;
        }
        try {
            res.write(chunk);
            lastActivityAt = Date.now();
            if (options.flush !== false) res.flush?.();
            // Node.js response.write 返回 false 表示背压排队，而非连接断开
            // 保持客户端注册状态；writableNeedDrain 会抑制空闲心跳
            return true;
        } catch (error) {
            cleanup();
            options.onError?.(error);
            return false;
        }
    };
    const writeComment = comment => writeRaw(encodeSseComment(comment));
    const writeData = (payload, event = '') => writeRaw(encodeSseData(payload, event));

    res.once?.('close', cleanup);
    res.once?.('finish', cleanup);
    res.once?.('error', cleanup);

    if (heartbeatMs > 0) {
        timer = setInterval(() => {
            if (!isWritable()) {
                cleanup();
                return;
            }
            if (res.writableNeedDrain || Date.now() - lastActivityAt < heartbeatMs) return;
            const frame = typeof options.heartbeatFactory === 'function'
                ? options.heartbeatFactory()
                : encodeSseComment(options.heartbeatComment || 'keep-alive');
            if (frame) writeRaw(frame);
        }, heartbeatMs);
        timer.unref?.();
    }

    return {
        cleanup,
        isWritable,
        touch() { lastActivityAt = Date.now(); },
        writeComment,
        writeData,
        writeEvent(event, payload) { return writeData(payload, event); },
        writeRaw
    };
}

module.exports = {
    DEFAULT_SSE_HEARTBEAT_MS,
    createSseResponseWriter,
    encodeSseComment,
    encodeSseData,
    normalizeSseHeartbeatMs,
    setSseResponseHeaders
};
