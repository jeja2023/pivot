// 聊天路由级测试装置
// 把「建用户/会话/模型 + 假上游 + 挂载 createChatRouter + 发起 SSE 请求 + 解析事件」收敛为一处，
// 供路由编排类用例复用，避免每个用例重复大段样板。
const {
    createChatRouter,
    db,
    http
} = require('../security-helpers');

// 上游默认按 OpenAI 兼容 SSE 返回，逐块下发内容后以 [DONE] 收尾。
function writeSseChunks(res, { chunks = [], usage = null } = {}) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    chunks.forEach(text => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    });
    if (usage) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
}

/**
 * 启动可编程假上游模型服务。
 * handler 为空时按流式 SSE 返回 replyChunks；传入 handler 可自定义状态码、非流式 JSON 或中途断流。
 */
async function startFakeUpstream({ handler, replyChunks = ['测试回答'], usage = null } = {}) {
    const server = http.createServer((req, res) => {
        req.resume();
        if (typeof handler === 'function') {
            handler(req, res);
            return;
        }
        writeSseChunks(res, { chunks: replyChunks, usage });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        get url() {
            return `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
        },
        close() {
            return new Promise(resolve => server.close(resolve));
        }
    };
}

// 建一套隔离的用户、会话和模型；modelColumns 用于按用例覆写额度、上下文窗口等字段。
// 角色默认取 admin：出站安全校验只允许管理员把模型指向本机地址（server/security.js 的
// assertSafeOutboundUrl），普通用户会在连接假上游前被 SSRF 守卫拦截。
function createChatFixture({
    prefix,
    upstreamUrl,
    role = 'admin',
    modelColumns = {},
    createSession = true
} = {}) {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const username = `${prefix}_${suffix}`;
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, 'QA', ?, 'active', datetime('now', '+8 hours'))
    `).run(username, '聊天路由测试', role);
    const userId = Number(userInfo.lastInsertRowid);

    const columnNames = ['user_id', 'name', 'url', 'model_name', 'status', 'created_at'];
    const columnValues = [userId, `${prefix} 模型`, upstreamUrl || 'http://127.0.0.1:1/v1/chat/completions', `${prefix}-${suffix}`];
    const placeholders = ['?', '?', '?', '?', "'active'", "datetime('now', '+8 hours')"];
    Object.entries(modelColumns).forEach(([column, value]) => {
        columnNames.push(column);
        placeholders.push('?');
        columnValues.push(value);
    });
    const modelInfo = db.prepare(`
        INSERT INTO models (${columnNames.join(', ')})
        VALUES (${placeholders.join(', ')})
    `).run(...columnValues);
    const modelId = Number(modelInfo.lastInsertRowid);

    const sessionId = `${prefix}-${suffix}`;
    if (createSession) {
        db.prepare(`
            INSERT INTO sessions (id, user_id, title, created_at, updated_at)
            VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
        `).run(sessionId, userId, '聊天路由测试');
    }

    return {
        userId,
        username,
        role,
        sessionId,
        modelId,
        user: { id: userId, username, role, unit: 'QA' },
        cleanup() {
            db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId);
            db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
            db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
            db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        }
    };
}

// 按 fixture 挂载真实聊天路由；retrieveContext/isRagEnabled 允许用例注入桩，模拟知识库命中与未命中。
async function startChatRouteServer({
    fixture,
    retrieveContext,
    isRagEnabled,
    publicUrl = '',
    autoAgent = false,
    agentExecutionEnabled,
    agentRunFactory
} = {}) {
    const express = require('express');
    const auditRecords = [];
    const app = express();
    app.use(express.json());
    app.use(createChatRouter({
        authMiddleware: (req, _res, next) => {
            req.user = { ...fixture.user };
            req.log = { info() {}, warn() {}, error() {} };
            next();
        },
        chatLimiter: (_req, _res, next) => next(),
        logAction: (_req, action, detail) => auditRecords.push({ action, detail }),
        retrieveContext,
        isRagEnabled,
        publicUrl,
        autoAgent,
        agentExecutionEnabled,
        agentRunFactory
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        auditRecords,
        get port() {
            return server.address().port;
        },
        close() {
            return new Promise(resolve => server.close(resolve));
        }
    };
}

// 解析 SSE 原文为事件数组，`[DONE]` 之类的非 JSON 载荷单独返回，便于断言收尾标记。
function parseSseEvents(sseText) {
    const payloads = String(sseText || '')
        .split(/\r?\n/)
        .filter(line => line.startsWith('data: '))
        .map(line => line.replace(/^data:\s*/, ''));
    const events = [];
    const rawPayloads = [];
    payloads.forEach(payload => {
        rawPayloads.push(payload);
        if (!payload.startsWith('{')) return;
        try {
            events.push(JSON.parse(payload));
        } catch (e) {
            // 非 JSON 载荷保留在 rawPayloads 中，由用例自行断言。
        }
    });
    return { events, rawPayloads };
}

// 发起一次 /chat 请求并等待 SSE 全部返回。
async function postChat(port, body) {
    const requestBody = JSON.stringify(body);
    const sseText = await new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
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
    const { events, rawPayloads } = parseSseEvents(sseText);
    return {
        sseText,
        events,
        rawPayloads,
        findEvent(predicate) {
            return events.find(predicate);
        },
        findByType(type) {
            return events.find(event => event.type === type);
        },
        get errorEvent() {
            return events.find(event => typeof event.error === 'string');
        },
        get streamedContent() {
            return events.filter(event => typeof event.content === 'string' && !event.type)
                .map(event => event.content)
                .join('');
        }
    };
}

// 读取会话内消息，供断言用户消息与助手消息的落库结果。
function readSessionMessages(fixture) {
    return db.prepare(`
        SELECT id, role, content, token_count
        FROM messages
        WHERE session_id = ? AND user_id = ?
        ORDER BY id ASC
    `).all(fixture.sessionId, fixture.userId);
}

module.exports = {
    createChatFixture,
    parseSseEvents,
    postChat,
    readSessionMessages,
    startChatRouteServer,
    startFakeUpstream
};
