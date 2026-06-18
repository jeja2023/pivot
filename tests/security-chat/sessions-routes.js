// 从 security-chat.test.js 拆出；仍由父级入口统一加载。
const {
    assert,
    buildContextMeta,
    countVisibleConversationMessages,
    createAnnouncementsRouter,
    createChatRouter,
    createSessionsRouter,
    db,
    estimateTokens,
    getBeijingTimestamp,
    getContext,
    http,
    runExpressHandlers,
    saveAssistantMessage,
    saveUserMessage,
    stmts,
    test,
    touchSession,
    updateLastAssistantStats
} = require('../security-helpers');

test('getContext 返回模型上下文前会压缩超过阈值的历史', async () => {
    const suffix = Date.now().toString(36);
    const summaryRequests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            summaryRequests.push({ url: req.url, body });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                choices: [
                    { message: { content: '保留早期决策 A，并继续使用近期上下文。' } }
                ]
            }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`ctx_compact_${suffix}`, 'hash', 'Context Compact Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const sessionId = `ctx-compact-${suffix}`;
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(sessionId, userId, 'Context Compact Test');

    const insertMessage = db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `);
    for (let i = 0; i < 8; i += 1) {
        const content = `第${i}条重要上下文：${'关键事实'.repeat(900)}`;
        insertMessage.run(sessionId, userId, i % 2 === 0 ? 'user' : 'assistant', content, estimateTokens(content));
    }

    try {
        const port = server.address().port;
        const history = await getContext(sessionId, userId, {
            id: null,
            url: `http://127.0.0.1:${port}`,
            model_name: 'fake-summary-model',
            api_key: ''
        });
        const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? AND user_id = ? ORDER BY id ASC').all(sessionId, userId);
        const meta = buildContextMeta(rows);
        const summaryIndex = history.findIndex(message => String(message.content || '').includes('长期记忆摘要'));
        const recentIndex = history.findIndex(message => String(message.content || '').includes('第2条重要上下文'));

        assert.equal(summaryRequests.length, 1);
        assert.match(summaryRequests[0].url, /\/chat\/completions$/);
        assert.equal(meta.archivedCount, 2);
        assert.equal(meta.summaryCount, 1);
        assert.ok(summaryIndex >= 0);
        assert.ok(recentIndex > summaryIndex);
        assert.match(history[summaryIndex].content, /保留早期决策 A/);
        assert.equal(history.some(message => String(message.content || '').includes('第0条重要上下文')), false);
        assert.equal(history.some(message => String(message.content || '').includes('第7条重要上下文')), true);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('聊天消息服务会保存消息并更新会话统计', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`chat_msg_${suffix}`, 'hash', 'Chat Message Test', 'QA', 'user', 'active');
    const sessionId = `chat-msg-${suffix}`;
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(sessionId, userInfo.lastInsertRowid, 'Chat Message Test');

    try {
        saveUserMessage({
            sessionId,
            userId: userInfo.lastInsertRowid,
            content: 'hello',
            modelId: null
        });
        saveAssistantMessage({
            sessionId,
            userId: userInfo.lastInsertRowid,
            content: 'world',
            tokenCount: 7,
            modelId: null
        });
        assert.equal(countVisibleConversationMessages(sessionId, userInfo.lastInsertRowid), 2);
        assert.equal(updateLastAssistantStats({
            sessionId,
            userId: userInfo.lastInsertRowid,
            costTime: 1.5,
            tps: 3.2
        }), true);
        touchSession(sessionId, '2099-01-01 00:00:00');

        const row = db.prepare(`
            SELECT token_count, cost_time, tokens_per_sec
            FROM messages
            WHERE session_id = ? AND role = 'assistant'
        `).get(sessionId);
        assert.equal(row.token_count, 7);
        assert.equal(row.cost_time, 1.5);
        assert.equal(row.tokens_per_sec, 3.2);
        assert.equal(db.prepare('SELECT updated_at FROM sessions WHERE id = ?').get(sessionId).updated_at, '2099-01-01 00:00:00');
    } finally {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('会话消息包含助手模型显示元数据', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`msg_model_${suffix}`, 'hash', 'Message Model Test', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const sessionId = `msg-model-${suffix}`;
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(userId, 'Readable Model Name', 'http://127.0.0.1:65530/v1/chat/completions', `api-model-${suffix}`);

    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(sessionId, userId, 'Message Model Test');
    db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, model_id, created_at)
        VALUES (?, ?, 'assistant', 'hello', ?, datetime('now', '+8 hours'))
    `).run(sessionId, userId, Number(modelInfo.lastInsertRowid));

    try {
        const [message] = stmts.getMessages.all(sessionId, userId);
        assert.equal(message.model_name, 'Readable Model Name');
        assert.equal(message.model_api_name, `api-model-${suffix}`);
    } finally {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM models WHERE id = ?').run(Number(modelInfo.lastInsertRowid));
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('上游模型失败时聊天路由会持久化助手错误消息', async () => {
    const express = require('express');
    const suffix = Date.now().toString(36);
    const upstream = http.createServer((req, res) => {
        req.resume();
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`chat_error_${suffix}`, 'hash', 'Chat Error Test', 'QA', 'admin', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const sessionId = `chat-error-${suffix}`;
    const upstreamPort = upstream.address().port;
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(userId, 'Failing Chat Model', `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, `failing-chat-${suffix}`);
    const modelId = Number(modelInfo.lastInsertRowid);

    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(sessionId, userId, 'Chat Error Test');

    const app = express();
    app.use(express.json());
    app.use(createChatRouter({
        authMiddleware: (req, _res, next) => {
            req.user = { id: userId, username: `chat_error_${suffix}`, role: 'admin', unit: 'QA' };
            req.log = { info() {}, warn() {}, error() {} };
            next();
        },
        chatLimiter: (_req, _res, next) => next(),
        logAction() {}
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    const requestBody = JSON.stringify({
        sessionId,
        content: 'hello',
        modelId
    });

    try {
        const sseText = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: server.address().port,
                path: '/chat',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            }, res => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { text += chunk; });
                res.on('end', () => resolve(text));
            });
            req.on('error', reject);
            req.write(requestBody);
            req.end();
        });

        const rows = db.prepare(`
            SELECT id, role, content
            FROM messages
            WHERE session_id = ? AND user_id = ?
            ORDER BY id ASC
        `).all(sessionId, userId);
        const assistant = rows.find(row => row.role === 'assistant');

        assert.equal(rows.filter(row => row.role === 'user').length, 1);
        assert.ok(assistant);
        assert.match(assistant.content, /生成失败/);
        assert.match(assistant.content, /模型响应异常/);
        assert.match(assistant.content, /upstream exploded/);
        assert.match(sseText, /assistant_error/);
        assert.match(sseText, new RegExp(String(assistant.id)));
    } finally {
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => upstream.close(resolve));
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('聊天路由会把非流式上游 JSON 重放为聊天 SSE 内容', async () => {
    const express = require('express');
    const suffix = Date.now().toString(36);
    const upstream = http.createServer((req, res) => {
        req.resume();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
            choices: [{ message: { content: 'fallback streamed answer' } }],
            usage: { completion_tokens: 4 }
        }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`chat_json_${suffix}`, 'hash', 'Chat JSON Test', 'QA', 'admin', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const sessionId = `chat-json-${suffix}`;
    const upstreamPort = upstream.address().port;
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(userId, 'JSON Chat Model', `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, `json-chat-${suffix}`);
    const modelId = Number(modelInfo.lastInsertRowid);

    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(sessionId, userId, 'Chat JSON Test');

    const app = express();
    app.use(express.json());
    app.use(createChatRouter({
        authMiddleware: (req, _res, next) => {
            req.user = { id: userId, username: `chat_json_${suffix}`, role: 'admin', unit: 'QA' };
            req.log = { info() {}, warn() {}, error() {} };
            next();
        },
        chatLimiter: (_req, _res, next) => next(),
        logAction() {}
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    const requestBody = JSON.stringify({
        sessionId,
        content: 'hello',
        modelId
    });

    try {
        const sseText = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: server.address().port,
                path: '/chat',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            }, res => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { text += chunk; });
                res.on('end', () => resolve(text));
            });
            req.on('error', reject);
            req.write(requestBody);
            req.end();
        });

        const assistant = db.prepare(`
            SELECT role, content, token_count, cost_time, tokens_per_sec
            FROM messages
            WHERE session_id = ? AND user_id = ? AND role = 'assistant'
            ORDER BY id DESC
        `).get(sessionId, userId);
        const savedEvent = sseText
            .split(/\r?\n/)
            .filter(line => line.startsWith('data: '))
            .map(line => line.replace(/^data:\s*/, ''))
            .filter(line => line.startsWith('{'))
            .map(line => JSON.parse(line))
            .find(event => event.type === 'message_saved' && event.role === 'assistant');

        assert.ok(assistant);
        assert.equal(assistant.content, 'fallback streamed answer');
        assert.equal(assistant.token_count, 4);
        assert.ok(assistant.cost_time > 0);
        assert.ok(assistant.tokens_per_sec > 0);
        assert.ok(savedEvent);
        assert.equal(savedEvent.tokenCount, 4);
        assert.equal(savedEvent.costTime, assistant.cost_time);
        assert.equal(savedEvent.tps, assistant.tokens_per_sec);
        assert.match(sseText, /fallback streamed answer/);
        assert.match(sseText, /message_saved/);
        assert.match(sseText, /\[DONE\]/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => upstream.close(resolve));
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('会话列表支持为优先游标加载跳过总数统计', async () => {
    const suffix = Date.now();
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`session_fast_${suffix}`, 'hash', 'Session Fast', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const sessionA = `session-fast-a-${suffix}`;
    const sessionB = `session-fast-b-${suffix}`;
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours', '-1 minute'), datetime('now', '+8 hours', '-1 minute'))
    `).run(sessionA, userId, 'Fast A');
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(sessionB, userId, 'Fast B');

    const router = createSessionsRouter({
        authMiddleware: (req, _res, next) => {
            req.user = { id: userId, username: `session_fast_${suffix}`, role: 'user', status: 'active' };
            next();
        },
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/sessions' && layer.route.methods.get);
    const handlers = route.route.stack.map(item => item.handle);
    const req = { query: { limit: '1', includeTotal: 'false' }, headers: {} };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

    try {
        await runExpressHandlers(handlers, req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(Object.hasOwn(res.body, 'total'), false);
        assert.equal(res.body.data.length, 1);
        assert.equal(res.body.hasMore, true);
        assert.equal(Boolean(res.body.nextCursor), true);
    } finally {
        db.prepare('DELETE FROM sessions WHERE id IN (?, ?)').run(sessionA, sessionB);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('公告路由定位有效通知并持久化用户确认状态', async () => {
    const suffix = Date.now().toString(36);
    const adminInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, 'Ops', 'admin', 'active', ?)
    `).run(`announce_admin_${suffix}`, '公告管理员', getBeijingTimestamp());
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, 'Ops', 'user', 'active', ?)
    `).run(`announce_user_${suffix}`, '公告用户', getBeijingTimestamp());
    const otherInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, 'Finance', 'user', 'active', ?)
    `).run(`announce_other_${suffix}`, '非目标用户', getBeijingTimestamp());

    const adminUser = { id: adminInfo.lastInsertRowid, username: `announce_admin_${suffix}`, role: 'admin', unit: 'Ops' };
    const superAdmin = { id: 1, username: 'admin', role: 'admin', unit: '' };
    const targetUser = { id: userInfo.lastInsertRowid, username: `announce_user_${suffix}`, role: 'user', unit: 'Ops' };
    const otherUser = { id: otherInfo.lastInsertRowid, username: `announce_other_${suffix}`, role: 'user', unit: 'Finance' };
    const logs = [];
    const router = createAnnouncementsRouter({
        authMiddleware: (req, _res, next) => {
            req.user = req.testUser;
            next();
        },
        adminMiddleware: (req, res, next) => {
            if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
            next();
        },
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 15, 1), 100),
        logAction: (_req, action, details) => logs.push({ action, details })
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/admin/announcements' && layer.route?.methods?.post);
    const publicRoute = router.stack.find(layer => layer.route?.path === '/announcements/public' && layer.route?.methods?.get);
    const listRoute = router.stack.find(layer => layer.route?.path === '/announcements/active' && layer.route?.methods?.get);
    const ackRoute = router.stack.find(layer => layer.route?.path === '/announcements/:id/ack' && layer.route?.methods?.post);
    const dismissRoute = router.stack.find(layer => layer.route?.path === '/announcements/:id/dismiss' && layer.route?.methods?.post);
    const deleteRoute = router.stack.find(layer => layer.route?.path === '/admin/announcements/:id' && layer.route?.methods?.delete);

    const createRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(createRoute.route.stack.map(s => s.handle), {
        body: {
            title: '公告投放测试',
            content: '仅 Ops 单位可见',
            type: 'security',
            priority: 'critical',
            targetType: 'unit',
            targetValue: 'Ops',
            requireAck: true,
            status: 'published'
        },
        testUser: adminUser
    }, createRes);
    assert.equal(createRes.statusCode, 200);
    assert.ok(createRes.body.id);

    const targetRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(listRoute.route.stack.map(s => s.handle), { query: {}, testUser: targetUser }, targetRes);
    assert.equal(targetRes.body.data.length, 1);
    assert.equal(targetRes.body.data[0].title, '公告投放测试');
    assert.equal(targetRes.body.requireAckCount, 1);

    const otherRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(listRoute.route.stack.map(s => s.handle), { query: {}, testUser: otherUser }, otherRes);
    assert.equal(otherRes.body.data.length, 0);

    const dismissOnlyCreateRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(createRoute.route.stack.map(s => s.handle), {
        body: {
            title: '可隐藏公告',
            content: '用户可不再提示',
            type: 'normal',
            priority: 'normal',
            targetType: 'unit',
            targetValue: 'Ops',
            status: 'published'
        },
        testUser: adminUser
    }, dismissOnlyCreateRes);
    assert.equal(dismissOnlyCreateRes.statusCode, 200);

    const dismissRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(dismissRoute.route.stack.map(s => s.handle), {
        params: { id: String(dismissOnlyCreateRes.body.id) },
        testUser: targetUser
    }, dismissRes);
    assert.equal(dismissRes.statusCode, 200);
    const dismissedState = db.prepare('SELECT read_at, dismissed_at FROM announcement_reads WHERE announcement_id = ? AND user_id = ?')
        .get(dismissOnlyCreateRes.body.id, targetUser.id);
    assert.ok(dismissedState.read_at);
    assert.ok(dismissedState.dismissed_at);

    const afterDismissRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(listRoute.route.stack.map(s => s.handle), { query: {}, testUser: targetUser }, afterDismissRes);
    assert.equal(afterDismissRes.body.data.some(item => item.id === dismissOnlyCreateRes.body.id), false);
    assert.equal(afterDismissRes.body.data.some(item => item.id === createRes.body.id), true);

    const deniedLoginRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(createRoute.route.stack.map(s => s.handle), {
        body: {
            title: '普通管理员登录页公告',
            content: '不应公开',
            targetType: 'all',
            showOnLogin: true,
            status: 'published'
        },
        testUser: adminUser
    }, deniedLoginRes);
    assert.equal(deniedLoginRes.statusCode, 403);

    const publicCreateRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(createRoute.route.stack.map(s => s.handle), {
        body: {
            title: '登录页公开公告',
            content: '未登录用户可见',
            targetType: 'all',
            showOnLogin: true,
            status: 'published'
        },
        testUser: superAdmin
    }, publicCreateRes);
    assert.equal(publicCreateRes.statusCode, 200);

    const publicRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(publicRoute.route.stack.map(s => s.handle), { query: {} }, publicRes);
    assert.ok(publicRes.body.data.some(item => item.id === publicCreateRes.body.id && item.showOnLogin === true));

    const stateRes = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(ackRoute.route.stack.map(s => s.handle), {
        params: { id: String(createRes.body.id) },
        testUser: targetUser
    }, stateRes);
    await runExpressHandlers(dismissRoute.route.stack.map(s => s.handle), {
        params: { id: String(createRes.body.id) },
        testUser: targetUser
    }, stateRes);
    const readState = db.prepare('SELECT read_at, acknowledged_at, dismissed_at FROM announcement_reads WHERE announcement_id = ? AND user_id = ?')
        .get(createRes.body.id, targetUser.id);
    assert.ok(readState.read_at);
    assert.ok(readState.acknowledged_at);
    assert.ok(readState.dismissed_at);

    await runExpressHandlers(deleteRoute.route.stack.map(s => s.handle), {
        params: { id: String(createRes.body.id) },
        testUser: adminUser
    }, stateRes);
    await runExpressHandlers(deleteRoute.route.stack.map(s => s.handle), {
        params: { id: String(dismissOnlyCreateRes.body.id) },
        testUser: adminUser
    }, stateRes);
    await runExpressHandlers(deleteRoute.route.stack.map(s => s.handle), {
        params: { id: String(publicCreateRes.body.id) },
        testUser: superAdmin
    }, stateRes);
    const deleted = db.prepare('SELECT deleted_at FROM announcements WHERE id = ?').get(createRes.body.id);
    assert.ok(deleted.deleted_at);
    assert.ok(logs.some(log => log.action === '创建公告'));
    assert.ok(logs.some(log => log.action === '删除公告'));
});
