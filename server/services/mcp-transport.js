'use strict';

const STATELESS_MCP_PROTOCOL_VERSION = '2026-07-28';
const DEFAULT_MCP_STREAM_IDLE_MS = 120000;

function resolveMcpStreamIdleMs(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_MCP_STREAM_IDLE_MS;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MCP_STREAM_IDLE_MS;
    if (parsed === 0) return 0;
    return Math.max(1000, Math.min(Math.floor(parsed), 3600000));
}

function createMcpIdleTimer(idleTimeoutMs, onIdle) {
    const timeout = resolveMcpStreamIdleMs(idleTimeoutMs);
    let timer = null;
    const stop = () => { if (timer) clearTimeout(timer); timer = null; };
    const touch = () => {
        stop();
        if (!timeout) return;
        timer = setTimeout(() => {
            timer = null;
            const error = new Error(`MCP 响应流在 ${Math.ceil(timeout / 1000)} 秒内没有收到新数据。`);
            error.code = 'MCP_STREAM_IDLE_TIMEOUT';
            onIdle(error);
        }, timeout);
    };
    touch();
    return { touch, stop };
}

function destroyMcpResponse(response, error) {
    response?.data?.destroy?.(error);
    // Axios 可能会包装底层数据流：仅销毁数据流可能导致底层 HTTP Socket 残留未释放。
    response?.request?.destroy?.();
}

function headerValue(headers = {}, name) {
    const target = String(name || '').toLowerCase();
    const key = Object.keys(headers || {}).find(item => String(item).toLowerCase() === target);
    return key ? headers[key] : undefined;
}

function usesStatelessMcpTransport(protocolVersion = '') {
    return String(protocolVersion || '').trim() >= STATELESS_MCP_PROTOCOL_VERSION;
}

function traceHeaders(traceContext = {}) {
    const source = traceContext && typeof traceContext === 'object' ? traceContext : {};
    const pairs = [['traceparent', source.traceparent || source.traceParent], ['tracestate', source.tracestate], ['baggage', source.baggage]];
    return Object.fromEntries(pairs.map(([key, value]) => [key, String(value || '').trim().slice(0, 4096)]).filter(([, value]) => value));
}

function traceMeta(traceContext = {}) {
    const headers = traceHeaders(traceContext);
    return Object.keys(headers).length ? headers : null;
}

function parseMcpJsonRpcPayload(payload) {
    if (payload && typeof payload === 'object') return payload;
    const text = String(payload || '').trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) {
        const dataLines = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
        const candidate = dataLines.at(-1) || text;
        try { return JSON.parse(candidate); } catch (error) {
            error.message = 'MCP 服务返回了无法解析的 JSON-RPC 响应。';
            throw error;
        }
    }
}

function readMcpStreamResponse(response, requestId, { onNotification, signal, maxBytes = 4 * 1024 * 1024, onReconnect = null, keepAlive = false, idleTimeoutMs } = {}) {
    const stream = response?.data;
    if (!stream || typeof stream.on !== 'function') return Promise.resolve(parseMcpJsonRpcPayload(stream));
    return new Promise((resolve, reject) => {
        let buffer = '', dataLines = [], bytes = 0, settled = false, ended = false, reconnecting = false, currentEventId = '', lastEventId = '', retryMs = null;
        const idle = createMcpIdleTimer(idleTimeoutMs, error => {
            if (settled) return;
            settled = true;
            reject(error);
            destroyMcpResponse(response, error);
        });
        const handleMessage = message => {
            if (!message || typeof message !== 'object') return;
            if (requestId && String(message.id ?? '') === String(requestId)) {
                if (!settled) { settled = true; idle.stop(); resolve(message); }
                if (!keepAlive) destroyMcpResponse(response);
                return;
            }
            try { onNotification?.(message); } catch (_) {}
        };
        const flush = () => {
            if (!dataLines.length) { if (currentEventId) lastEventId = currentEventId; currentEventId = ''; return; }
            const payload = dataLines.join('\n'); dataLines = [];
            if (currentEventId) lastEventId = currentEventId;
            currentEventId = '';
            if (payload === '[DONE]') return;
            try { handleMessage(parseMcpJsonRpcPayload(payload)); } catch (error) { if (!settled) { settled = true; idle.stop(); reject(error); destroyMcpResponse(response); } }
        };
        const consume = text => {
            buffer += text;
            const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) flush();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                else if (line.startsWith('id:')) currentEventId = line.slice(3).trim();
                else if (line.startsWith('retry:')) { const value = Number.parseInt(line.slice(6).trim(), 10); if (Number.isFinite(value) && value >= 0) retryMs = value; }
                else if (!dataLines.length && line.trim().startsWith('{')) dataLines.push(line.trim());
            }
        };
        const onData = chunk => {
            if (!settled) idle.touch();
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxBytes) {
                const error = new Error('MCP SSE 响应超过大小限制。'); error.code = 'MCP_RESPONSE_TOO_LARGE';
                if (!settled) { settled = true; idle.stop(); reject(error); }
                destroyMcpResponse(response, error); return;
            }
            consume(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        };
        const onEnd = async () => {
            ended = true; idle.stop(); if (buffer) consume('\n'); flush();
            if (!settled) {
                if (typeof onReconnect === 'function' && !reconnecting) {
                    reconnecting = true;
                    try { const message = await onReconnect({ lastEventId, retryMs }); if (!settled) { settled = true; resolve(message); } }
                    catch (error) { if (!settled) { settled = true; reject(error); } }
                    return;
                }
                settled = true; reject(new Error('MCP SSE 响应在返回 JSON-RPC 结果前结束。'));
            }
        };
        const onError = error => {
            idle.stop();
            if (!settled) { settled = true; reject(error); }
            else if (keepAlive) { try { onNotification?.({ type: 'stream.error', error: { message: String(error?.message || error) } }); } catch (_) {} }
        };
        stream.on('data', onData); stream.once('end', () => { void onEnd(); }); stream.once('error', onError);
        stream.once('close', () => {
            idle.stop();
            if (!settled && !ended && !reconnecting) { settled = true; reject(new Error('MCP SSE 响应在返回结果前关闭。')); }
        });
        if (signal) {
            const abort = () => destroyMcpResponse(response, signal.reason || new Error('MCP 请求已取消。'));
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
            stream.once('close', () => signal.removeEventListener?.('abort', abort));
        }
        if (ended) onEnd();
    });
}

function drainMcpResponse(response, { idleTimeoutMs, signal } = {}) {
    const stream = response?.data;
    if (!stream || typeof stream.on !== 'function') return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true; idle.stop(); stream.removeListener('data', idle.touch); signal?.removeEventListener?.('abort', abort);
            if (error) reject(error); else resolve();
        };
        const idle = createMcpIdleTimer(idleTimeoutMs, error => { finish(error); destroyMcpResponse(response, error); });
        const abort = () => { const error = signal.reason || new Error('MCP 请求已取消。'); finish(error); destroyMcpResponse(response, error); };
        stream.on('data', idle.touch);
        stream.once('end', () => finish());
        stream.once('error', error => finish(error));
        stream.once('close', () => finish());
        if (signal?.aborted) abort(); else signal?.addEventListener?.('abort', abort, { once: true });
        stream.resume?.();
    });
}

module.exports = { STATELESS_MCP_PROTOCOL_VERSION, drainMcpResponse, headerValue, readMcpStreamResponse, resolveMcpStreamIdleMs, traceHeaders, traceMeta, usesStatelessMcpTransport };
