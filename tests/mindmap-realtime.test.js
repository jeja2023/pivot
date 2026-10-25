'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const documents = require('../server/services/mindmaps/documents');
const product = require('../server/services/mindmaps/product');
const { createMindmapRealtime } = require('../server/services/mindmaps/realtime');
async function account() { return queryOne("INSERT INTO users (username,password_hash,role,status,created_at) VALUES (?,?,'user','active',NOW()) RETURNING id,username,role", [`ws_${crypto.randomUUID()}`, 'test-hash']); }
function messages(socket) {
    const buffer = []; const waiters = [];
    socket.on('message', data => { const event = JSON.parse(String(data)); const index = waiters.findIndex(waiter => waiter.type === event.type); if (index < 0) buffer.push(event); else { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(event); } });
    return type => { const index = buffer.findIndex(event => event.type === type); if (index >= 0) return Promise.resolve(buffer.splice(index, 1)[0]); return new Promise((resolve, reject) => { const waiter = { type, resolve, timer: setTimeout(() => reject(new Error(`未收到协作消息：${type}`)), 5000) }; waiters.push(waiter); }); };
}
test('WebSocket 使用一次票据推送已提交版本，跨来源被拒，降权及撤权立即生效', { timeout: 25000 }, async () => {
    const owner = await account(); const reader = await account(); const outsider = await account(); const users = new Map([owner, reader].map(user => [String(user.id), user]));
    const created = await documents.save(owner, { tree: { id: 'root', text: '协作传输' }, requestKey: crypto.randomUUID() });
    const share = await product.setSharing(owner, created.id, { enabled: true, expectedRevision: 1, expectedVersionId: created.versionId, members: [{ userId: reader.id, role: 'editor' }] });
    const realtime = createMindmapRealtime({ authenticate: async req => users.get(req.headers['x-test-user']), heartbeatMs: 1000 });
    const server = http.createServer(); const cleanup = realtime.attach(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const host = `127.0.0.1:${server.address().port}`; const sockets = [];
    async function connect(user, ticket) { const socket = new WebSocket(`ws://${host}/api/apps/mindmaps-stream`, { origin: `http://${host}`, headers: { 'x-test-user': String(user.id) } }); sockets.push(socket); const next = messages(socket); await once(socket, 'open'); socket.send(JSON.stringify({ ticket })); return { socket, next }; }
    try {
        await assert.rejects(realtime.issueTicket(outsider, created.id), error => error.status === 404);
        const ticket = await realtime.issueTicket(reader, created.id); assert.ok(!ticket.path.includes(ticket.ticket));
        const { socket, next } = await connect(reader, ticket.ticket); assert.equal((await next('snapshot')).versionId, created.versionId); await next('ready');
        const replay = await connect(reader, ticket.ticket); assert.equal((await replay.next('error')).status, 401);
        const saved = await documents.save(owner, { artifactId: created.id, expectedVersionId: created.versionId, document: { id: 'root', text: '即时更新' }, requestKey: crypto.randomUUID() });
        assert.equal((await next('snapshot')).versionId, saved.versionId);
        const downgraded = await product.setSharing(owner, created.id, { enabled: true, expectedRevision: share.revision, expectedVersionId: saved.versionId, members: [{ userId: reader.id, role: 'viewer' }] });
        assert.equal((await next('snapshot')).role, 'viewer');
        await product.setSharing(owner, created.id, { enabled: true, expectedRevision: downgraded.revision, expectedVersionId: saved.versionId, members: [] });
        assert.equal((await next('error')).status, 404); if (socket.readyState !== WebSocket.CLOSED) await once(socket, 'close');
        const bad = new WebSocket(`ws://${host}/api/apps/mindmaps-stream`, { origin: 'https://other.invalid' }); sockets.push(bad); bad.on('error', () => {});
        assert.equal((await once(bad, 'unexpected-response'))[1].statusCode, 403); bad.terminate();
    } finally { for (const socket of sockets) socket.terminate(); cleanup(); await new Promise(resolve => server.close(resolve)); await execute('DELETE FROM agent_artifacts WHERE id=?', [created.id]); for (const user of [owner, reader, outsider]) await execute('DELETE FROM users WHERE id=?', [user.id]); }
});
