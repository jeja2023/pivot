const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'pivot-http-permissions-test-jwt-secret-012345678901234567890123';

const { sql } = require('../server/db/statements');
const { authMiddleware, login, register } = require('../server/auth');
const { ragRouter } = require('../server/rag');
const { createMcpRouter } = require('../server/routes/mcp');
const { getBeijingTimestamp } = require('../server/time');

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/rag', ragRouter);
    app.use('/api', createMcpRouter({
        authMiddleware,
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    }));
    app.use((error, _req, res, _next) => {
        const status = Number(error?.status || error?.statusCode) || 500;
        res.status(status).json({ error: error?.message || 'test route error' });
    });
    return app;
}

function listen(app) {
    const server = http.createServer(app);
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function request(server, { method = 'GET', path, token, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? '' : JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port: server.address().port,
            path,
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(payload ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                } : {})
            }
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (_error) {}
                resolve({ status: res.statusCode, body: json, text });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function createTestUser(label, unit) {
    const suffix = `${process.pid.toString(36)}${Date.now().toString(36).slice(-7)}${Math.random().toString(36).slice(2, 5)}`;
    const username = `http_${String(label).slice(0, 10)}_${suffix}`;
    const password = 'Password123';
    const user = await register(username, password, `${label} HTTP user`, unit, 'user');
    const session = await login(username, password);
    return { ...user, accessToken: session.accessToken };
}

function cleanupUsers(userIds) {
    const placeholders = userIds.map(() => '?').join(',');
    sql(`DELETE FROM audit_logs WHERE user_id IN (${placeholders})`).run(...userIds);
    sql(`DELETE FROM refresh_tokens WHERE user_id IN (${placeholders})`).run(...userIds);
    sql(`DELETE FROM workflow_credentials WHERE user_id IN (${placeholders})`).run(...userIds);
    sql(`DELETE FROM users WHERE id IN (${placeholders})`).run(...userIds);
}

test('shared RAG recipients can list resources but cannot mutate documents or collections', async () => {
    const owner = await createTestUser('rag_owner', 'QA');
    const receiver = await createTestUser('rag_receiver', 'QA');
    const now = getBeijingTimestamp();
    const collectionInfo = sql(`
        INSERT INTO knowledge_collections (
            user_id, name, description, scope, allowed_units, allowed_user_ids, created_at, updated_at
        ) VALUES (?, ?, '', 'shared', ?, '', ?, ?)
    `).run(owner.id, `Shared HTTP collection ${Date.now()}`, owner.unit, now, now);
    const collectionId = Number(collectionInfo.lastInsertRowid);
    const docInfo = sql(`
        INSERT INTO knowledge_docs (
            user_id, collection_id, name, status, is_enabled, chunk_count, indexed_chunks,
            progress, created_at, updated_at
        ) VALUES (?, ?, ?, 'ready', 1, 1, 1, 100, ?, ?)
    `).run(owner.id, collectionId, `shared-http-doc-${Date.now()}.txt`, now, now);
    const docId = Number(docInfo.lastInsertRowid);
    const appServer = await listen(createTestApp());

    try {
        const collections = await request(appServer, {
            path: '/api/rag/collections',
            token: receiver.accessToken
        });
        assert.equal(collections.status, 200);
        assert.equal(collections.body.data.some(item => item.id === collectionId && item.read_only === true), true);

        const docs = await request(appServer, {
            path: '/api/rag/docs',
            token: receiver.accessToken
        });
        assert.equal(docs.status, 200);
        assert.equal(docs.body.data.some(item => item.id === docId && item.read_only === true), true);

        const enable = await request(appServer, {
            method: 'PUT',
            path: `/api/rag/docs/${docId}/enabled`,
            token: receiver.accessToken,
            body: { enabled: false }
        });
        assert.equal(enable.status, 404);

        const move = await request(appServer, {
            method: 'PUT',
            path: `/api/rag/docs/${docId}/collection`,
            token: receiver.accessToken,
            body: { collectionId: null }
        });
        assert.equal(move.status, 404);

        const remove = await request(appServer, {
            method: 'DELETE',
            path: `/api/rag/docs/${docId}`,
            token: receiver.accessToken
        });
        assert.equal(remove.status, 404);

        const share = await request(appServer, {
            method: 'PATCH',
            path: `/api/rag/collections/${collectionId}/sharing`,
            token: receiver.accessToken,
            body: { scope: 'personal' }
        });
        assert.equal(share.status, 404);

        const persisted = sql(`
            SELECT d.deleted_at, d.is_enabled, d.collection_id, c.scope
            FROM knowledge_docs d
            JOIN knowledge_collections c ON c.id = d.collection_id
            WHERE d.id = ?
        `).get(docId);
        assert.equal(persisted.deleted_at, null);
        assert.equal(persisted.is_enabled, 1);
        assert.equal(persisted.collection_id, collectionId);
        assert.equal(persisted.scope, 'shared');
    } finally {
        await new Promise(resolve => appServer.close(resolve));
        sql('DELETE FROM knowledge_docs WHERE id = ?').run(docId);
        sql('DELETE FROM knowledge_collections WHERE id = ?').run(collectionId);
        cleanupUsers([owner.id, receiver.id]);
    }
});

test('shared MCP recipients can list servers and readonly tools but cannot edit or call writes', async () => {
    const owner = await createTestUser('mcp_owner', 'QA');
    const receiver = await createTestUser('mcp_receiver', 'QA');
    const now = getBeijingTimestamp();
    const serverInfo = sql(`
        INSERT INTO mcp_servers (
            user_id, name, base_url, api_key, description, scope, allowed_units,
            allowed_user_ids, status, created_at, updated_at
        ) VALUES (?, ?, 'pivot-db://http-permissions', '', 'shared test server', 'shared', ?, '', 'active', ?, ?)
    `).run(owner.id, `Shared HTTP MCP ${Date.now()}`, owner.unit, now, now);
    const serverId = Number(serverInfo.lastInsertRowid);
    sql(`
        INSERT INTO mcp_tool_cache (server_id, name, description, input_schema, cached_at)
        VALUES (?, 'db.list_tables', 'readonly listing', '{"type":"object"}', ?)
    `).run(serverId, now);
    sql(`
        INSERT INTO mcp_tool_cache (server_id, name, description, input_schema, cached_at)
        VALUES (?, 'db.drop_table', 'write operation', '{"type":"object"}', ?)
    `).run(serverId, now);
    const appServer = await listen(createTestApp());

    try {
        const servers = await request(appServer, {
            path: '/api/mcp/servers',
            token: receiver.accessToken
        });
        assert.equal(servers.status, 200);
        assert.equal(servers.body.data.some(item => item.id === serverId && item.read_only === true && item.can_edit === false), true);

        const serverTools = await request(appServer, {
            path: `/api/mcp/servers/${serverId}/tools`,
            token: receiver.accessToken
        });
        assert.equal(serverTools.status, 200);
        assert.equal(serverTools.body.tools.some(item => item.name === 'db.list_tables'), true);
        assert.equal(serverTools.body.tools.some(item => item.name === 'db.drop_table'), false);

        const tools = await request(appServer, {
            path: '/api/mcp/tools',
            token: receiver.accessToken
        });
        assert.equal(tools.status, 200);
        assert.equal(tools.body.tools.some(item => item.fullName === `mcp.${serverId}.db.list_tables`), true);

        const edit = await request(appServer, {
            method: 'PUT',
            path: `/api/mcp/servers/${serverId}`,
            token: receiver.accessToken,
            body: { name: 'receiver takeover' }
        });
        assert.equal(edit.status, 403);

        const call = await request(appServer, {
            method: 'POST',
            path: '/api/mcp/tools/call',
            token: receiver.accessToken,
            body: {
                name: `mcp.${serverId}.db.drop_table`,
                input: { table: 'protected' }
            }
        });
        assert.equal(call.status, 403);
    } finally {
        await new Promise(resolve => appServer.close(resolve));
        sql('DELETE FROM mcp_tool_cache WHERE server_id = ?').run(serverId);
        sql('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
        cleanupUsers([owner.id, receiver.id]);
    }
});
