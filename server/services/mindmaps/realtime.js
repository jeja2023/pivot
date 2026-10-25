'use strict';
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const schema = require('../../../client/common/mindmap-document');
const { events } = require('./events');
function createMindmapRealtime({ authenticate = async req => (await require('../../auth').resolveAuthenticatedUserAsync(req)).user, get = (...args) => require('./documents').get(...args), heartbeatMs = 10000 } = {}) {
    const tickets = new Map(); const clients = new Set();
    async function issueTicket(user, id) {
        const document = await get(user, id);
        if (!document.collaboration) throw schema.error('请先开启协作。');
        for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key);
        if (tickets.size >= 1024 || [...clients].filter(client => String(client.user?.id) === String(user.id)).length >= 8) throw schema.error('协作连接数已达上限，请关闭多余窗口。', 'MINDMAP_CONNECTION_LIMIT', 429);
        const ticket = crypto.randomBytes(32).toString('base64url');
        tickets.set(ticket, { userId: String(user.id), id: document.id, expires: Date.now() + 15000 });
        return { ticket, path: '/api/apps/mindmaps-stream', expiresInMs: 15000 };
    }
    function attach(server) {
        const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
        function upgrade(req, socket, head) {
            if (String(req.url).split('?')[0] !== '/api/apps/mindmaps-stream') return;
            let validOrigin = false;
            try { const origin = new URL(req.headers.origin); validOrigin = ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host; } catch (_) { /* 缺少浏览器来源时拒绝连接。 */ }
            if (!validOrigin || clients.size >= 512) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
            wss.handleUpgrade(req, socket, head, socketClient => wss.emit('connection', socketClient, req));
        }
        server.on('upgrade', upgrade);
        wss.on('connection', (socket, req) => {
            const client = { socket, req, id: null, user: null, running: false, pending: false, closed: false, alive: true, revision: '', frames: 0, window: Date.now() }; clients.add(client);
            const close = () => { if (client.closed) return; client.closed = true; clearTimeout(startup); clients.delete(client); socket.terminate(); };
            const send = value => { if (client.closed) return; if (socket.bufferedAmount > 2 * 1024 * 1024) return close(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
            const fail = error => { send({ type: 'error', status: error?.status || 401, message: error?.status === 404 ? '共享访问已撤销，请另存本地副本。' : '协作连接已失效，请重新连接。' }); close(); };
            const startup = setTimeout(close, 5000).unref();
            client.refresh = async () => {
                if (client.closed || !client.id) return;
                if (client.running) { client.pending = true; return; }
                client.running = true;
                try {
                    const actor = await authenticate(req);
                    if (!actor || String(actor.id) !== String(client.user.id)) return fail();
                    const document = await get(actor, client.id);
                    if (client.closed) return;
                    const revision = `${document.versionId}:${document.role}:${document.collaboration}:${document.collaborationEpoch}`;
                    if (revision !== client.revision) { client.revision = revision; send({ type: 'snapshot', ...document }); }
                } catch (error) { fail(error); }
                finally { client.running = false; if (client.pending) { client.pending = false; void client.refresh(); } }
            };
            socket.on('close', close); socket.on('error', close); socket.on('pong', () => { client.alive = true; });
            let queued = false;
            socket.on('message', async (data, binary) => {
                if (client.closed) return;
                if (Date.now() - client.window >= 60000) { client.window = Date.now(); client.frames = 0; }
                if (binary || ++client.frames > 120 || queued) return fail();
                queued = true;
                try {
                    const message = JSON.parse(String(data));
                    if (!client.user) {
                        const ticket = tickets.get(message.ticket); tickets.delete(message.ticket);
                        if (!ticket || ticket.expires < Date.now()) return fail();
                        const actor = await authenticate(req);
                        if (!actor || String(actor.id) !== ticket.userId || client.closed || [...clients].filter(peer => String(peer.user?.id) === ticket.userId).length >= 8) return fail();
                        client.user = actor; client.id = ticket.id; clearTimeout(startup);
                        await client.refresh(); send({ type: 'ready' });
                    } else if (message.type === 'sync') await client.refresh();
                    else fail();
                } catch (_) { fail(); } finally { queued = false; }
            });
        });
        const notify = id => { for (const client of clients) if (client.id === id) void client.refresh(); };
        events.on('changed', notify);
        // 定期复核登录与共享权限，也补偿其他服务进程提交的版本，保持多实例可用。
        const heartbeat = setInterval(() => { for (const client of clients) { if (!client.alive) { client.socket.terminate(); continue; } client.alive = false; client.socket.ping(); void client.refresh?.(); } }, heartbeatMs).unref();
        let stopped = false;
        return () => { if (stopped) return; stopped = true; clearInterval(heartbeat); events.off('changed', notify); server.off('upgrade', upgrade); for (const client of clients) client.socket.terminate(); clients.clear(); tickets.clear(); wss.close(); };
    }
    return { issueTicket, attach };
}
const mindmapRealtime = createMindmapRealtime();
module.exports = { createMindmapRealtime, mindmapRealtime };
