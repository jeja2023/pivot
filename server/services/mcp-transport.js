'use strict';

const STATELESS_MCP_PROTOCOL_VERSION = '2026-07-28';

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

function readMcpStreamResponse(response, requestId, { onNotification, signal, maxBytes = 4 * 1024 * 1024, onReconnect = null, keepAlive = false } = {}) {
    const stream = response?.data;
    if (!stream || typeof stream.on !== 'function') return Promise.resolve(parseMcpJsonRpcPayload(stream));
    return new Promise((resolve, reject) => {
        let buffer = '', dataLines = [], bytes = 0, settled = false, ended = false, reconnecting = false, currentEventId = '', lastEventId = '', retryMs = null;
        const handleMessage = message => {
            if (!message || typeof message !== 'object') return;
            if (requestId && String(message.id ?? '') === String(requestId)) {
                if (!settled) { settled = true; resolve(message); }
                if (!keepAlive) stream.destroy?.();
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
            try { handleMessage(parseMcpJsonRpcPayload(payload)); } catch (error) { if (!settled) { settled = true; reject(error); } }
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
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxBytes) {
                const error = new Error('MCP SSE 响应超过大小限制。'); error.code = 'MCP_RESPONSE_TOO_LARGE';
                if (!settled) { settled = true; reject(error); }
                stream.destroy?.(error); return;
            }
            consume(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        };
        const onEnd = async () => {
            ended = true; if (buffer) consume('\n'); flush();
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
            if (!settled) { settled = true; reject(error); }
            else { try { onNotification?.({ type: 'stream.error', error: { message: String(error?.message || error) } }); } catch (_) {} }
        };
        stream.on('data', onData); stream.once('end', () => { void onEnd(); }); stream.once('error', onError);
        if (signal) {
            const abort = () => stream.destroy?.(signal.reason || new Error('MCP 请求已取消。'));
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
            stream.once('close', () => signal.removeEventListener?.('abort', abort));
        }
        if (ended) onEnd();
    });
}

function drainMcpResponse(response) {
    const stream = response?.data;
    if (!stream || typeof stream.on !== 'function') return Promise.resolve();
    return new Promise(resolve => { stream.once('end', resolve); stream.once('error', resolve); stream.once('close', resolve); stream.resume?.(); });
}

module.exports = { STATELESS_MCP_PROTOCOL_VERSION, drainMcpResponse, headerValue, readMcpStreamResponse, traceHeaders, traceMeta, usesStatelessMcpTransport };
