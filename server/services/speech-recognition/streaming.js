'use strict';

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { readSpeechSetting } = require('./settings');
const { providerRequestOptions, normalizeHotwords } = require('./provider');
const { speechError } = require('./audio');
const { speechCapacity } = require('./capacity');
const { embeddedSpeech } = require('./embedded');
const { resolveSpeechProvider } = require('./config');

function createVoiceStreaming({ read = readSpeechSetting, checkEndpoint = providerRequestOptions, embedded = embeddedSpeech,
    authenticate = async req => (await require('../../auth').resolveAuthenticatedUserAsync(req)).user, capacity = speechCapacity } = {}) {
    const tickets = new Map(); const users = new Set(); const sockets = new Set();
    const enabled = () => {
        try {
            if (!read('PIVOT_SERVER_VOICE_ENABLED')) return false;
            if (read('PIVOT_VOICE_PROVIDER') === 'embedded') return true;
            if (read('PIVOT_VOICE_PROVIDER') !== 'gateway') return false;
            const stream = new URL(read('PIVOT_VOICE_STREAM_ENDPOINT'));
            if (!['ws:', 'wss:'].includes(stream.protocol)) return false;
            stream.protocol = stream.protocol === 'ws:' ? 'http:' : 'https:';
            return stream.origin === new URL(read('PIVOT_VOICE_ENDPOINT')).origin;
        } catch (_) { return false; }
    };
    function issueTicket(user) {
        if (!user?.id) throw speechError('语音连接需要登录。', 'VOICE_AUTH_REQUIRED', 401);
        if (!enabled()) throw speechError('流式语音尚未启用，请联系管理员。', 'VOICE_STREAM_DISABLED', 503);
        for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
        if (tickets.size >= 128 || users.has(String(user.id))) throw speechError('语音连接繁忙，请稍后重试。', 'VOICE_BUSY', 429);
        for (const [key, value] of tickets) if (value.userId === String(user.id)) tickets.delete(key);
        const ticket = crypto.randomBytes(32).toString('base64url');
        tickets.set(ticket, { userId: String(user.id), expires: Date.now() + 15000 });
        return { ticket, path: '/api/chat/voice-stream', expiresInMs: 15000 };
    }
    function attach(server) {
        const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
        const upgrade = (req, socket, head) => {
            if (String(req.url).split('?')[0] !== '/api/chat/voice-stream') return;
            // 一次性票据只在首帧传输，不出现在 URL 或访问日志中。
            if (!enabled() || sockets.size >= 64) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
            wss.handleUpgrade(req, socket, head, client => { wss.emit('connection', client, req); });
        };
        server.on('upgrade', upgrade);
        wss.on('connection', (client, req) => {
            sockets.add(client);
            let upstream; let owner; let authenticated = false; let ending = false; let bytes = 0; let activeSegment = false; let segmentEnding = false; let closed = false; let release;
            const timers = new Set();
            const lifetimeController = new AbortController();
            const timeout = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; };
            const send = event => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); };
            const close = () => { if (closed) return; closed = true; lifetimeController.abort(); for (const timer of timers) clearTimeout(timer); upstream?.terminate(); client.terminate(); sockets.delete(client); if (owner) users.delete(owner); release?.(); };
            const fail = () => { send({ type: 'error', message: '语音连接中断或服务繁忙，请重新开始。' }); close(); };
            const startup = timeout(fail, 5000);
            const lifetime = timeout(fail, 30 * 60 * 1000);
            void lifetime;
            let segmentTimer; let upstreamStartup;
            client.on('error', close); client.on('close', close);
            let incoming = Promise.resolve(); let queuedBytes = 0; let queuedFrames = 0;
            client.on('message', (data, binary) => {
                if (closed || (queuedBytes += data.length) > 131072 || ++queuedFrames > 128) return fail();
                incoming = incoming.then(async () => {
                    if (closed) return;
                    try {
                        if (!authenticated) {
                            if (binary) return fail();
                            const message = JSON.parse(String(data));
                            const record = tickets.get(message.ticket); tickets.delete(message.ticket);
                            if (!record || record.expires < Date.now() || users.has(record.userId)) return fail();
                            authenticated = true;
                            const actor = await authenticate(req);
                            if (!actor || String(actor.id) !== record.userId || closed || users.has(record.userId)) return fail();
                            owner = record.userId; users.add(owner);
                            clearTimeout(startup);
                            upstreamStartup = timeout(fail, read('PIVOT_VOICE_PROVIDER') === 'embedded' ? read('PIVOT_EMBEDDED_VOICE_STARTUP_MS') : 5000);
                            const config = await resolveSpeechProvider(read, embedded, { signal: lifetimeController.signal });
                            const address = new URL(config.streamEndpoint);
                            if (!['ws:', 'wss:'].includes(address.protocol)) return fail();
                            const originalProtocol = address.protocol; address.protocol = originalProtocol === 'ws:' ? 'http:' : 'https:';
                            const options = await checkEndpoint(address.href, config.allowExternal);
                            if (client.readyState !== WebSocket.OPEN) { options.httpAgent?.destroy(); options.httpsAgent?.destroy(); return; }
                            upstream = new WebSocket(config.streamEndpoint, {
                                headers: { Authorization: `Bearer ${config.apiKey}` },
                                agent: originalProtocol === 'wss:' ? options.httpsAgent : options.httpAgent,
                                handshakeTimeout: 5000, maxPayload: 65536, perMessageDeflate: false, followRedirects: false
                            });
                            upstream.on('close', () => { options.httpAgent?.destroy(); options.httpsAgent?.destroy(); close(); });
                            upstream.on('error', fail);
                            upstream.on('open', () => { clearTimeout(upstreamStartup); send({ type: 'ready' }); });
                            upstream.on('message', payload => {
                                try {
                                    const event = JSON.parse(String(payload));
                                    if (!activeSegment) return fail();
                                    if (!['partial', 'final', 'error'].includes(event.type) || typeof event.text !== 'string' && event.type !== 'error') return fail();
                                    if (event.type === 'error') return fail();
                                    if (event.text.length > 4000 || client.bufferedAmount > 131072) return fail();
                                    if (event.type === 'final') {
                                        activeSegment = false; bytes = 0; clearTimeout(segmentTimer);
                                        release?.(); release = null;
                                        if (ending) { send(event); client.close(1000); return; }
                                    }
                                    const confidence = typeof event.confidence === 'number' && event.confidence >= 0 && event.confidence <= 1 ? event.confidence : null;
                                    send({ type: event.type, text: event.text, requiresReview: event.requiresReview === true || confidence !== null && confidence < read('PIVOT_VOICE_MIN_CONFIDENCE'),
                                        confidence });
                                } catch (_) { fail(); }
                            });
                            return;
                        }
                        if (!enabled() || !upstream || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 128000) return fail();
                        if (binary) {
                            if (!activeSegment || segmentEnding || ending || data.length % 2 || (bytes += data.length) > 640000) return fail();
                            upstream.send(data); return;
                        }
                        const message = JSON.parse(String(data));
                        if (message.type === 'begin' && !activeSegment) {
                            const actor = await authenticate(req);
                            if (!actor || String(actor.id) !== owner || closed || !enabled()) return fail();
                            release = capacity.claim(owner, read('PIVOT_VOICE_MAX_CONCURRENT'));
                            activeSegment = true; segmentEnding = false; bytes = 0;
                            upstream.send(JSON.stringify({ type: 'begin', hotwords: normalizeHotwords(read('PIVOT_VOICE_HOTWORDS')), language: 'zh-CN' }));
                            if (segmentTimer) timers.delete(segmentTimer);
                            segmentTimer = timeout(fail, 65000);
                        } else if (message.type === 'end' && activeSegment && !segmentEnding) { segmentEnding = true; upstream.send(JSON.stringify({ type: 'end' })); }
                        else if (message.type === 'finish') { ending = true; if (activeSegment && !segmentEnding) { segmentEnding = true; upstream.send(JSON.stringify({ type: 'end' })); } else if (!activeSegment) client.close(1000); }
                        else fail();
                    } catch (_) { fail(); }
                }).finally(() => { queuedBytes -= data.length; queuedFrames--; });
            });
        });
        let stopped = false;
        return () => { if (stopped) return; stopped = true; server.removeListener('upgrade', upgrade); for (const socket of sockets) socket.terminate(); tickets.clear(); users.clear(); wss.close(); };
    }
    return { enabled, issueTicket, attach, reset() { for (const socket of sockets) socket.terminate(); tickets.clear(); } };
}
const voiceStreaming = createVoiceStreaming();
module.exports = { createVoiceStreaming, voiceStreaming };
