// Chat 安全测试
const {
    ConcurrencySemaphore,
    KeyedConcurrencyGuard,
    LruCache,
    MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
    TtlCache,
    WithTimeoutError,
    appendStreamedChartsToAssistantContent,
    applyChatLanguageInstruction,
    assert,
    backupDatabase,
    buildChatCompletionsUrl,
    buildComplianceAuditPackage,
    buildContextMeta,
    buildFtsQuery,
    buildModelHeaders,
    buildResponsesUrl,
    buildSingleEntryZip,
    buildZipArchive,
    calculateUsageCost,
    cleanupApiCallLogs,
    cleanupExpiredRefreshTokens,
    cleanupOldBackups,
    cleanupOldLogs,
    contentContainsVisionInput,
    convertChatMessagesToResponsesInput,
    countVisibleConversationMessages,
    createAnnouncementsRouter,
    createChartSseCapture,
    createChatRenderSandbox,
    createChatRouter,
    createFakeSseResponse,
    createOpenAIRouter,
    createSessionsRouter,
    createSseEventParser,
    createStreamAccumulator,
    db,
    estimateTokens,
    extractStreamPayload,
    fs,
    getBeijingTimestamp,
    getContext,
    getLocalHostnames,
    getMaintenanceStatus,
    getModelDailyUsage,
    getRealtimeStats,
    getSystemHealthSnapshot,
    http,
    isDockerInternalServiceHost,
    isLocalModelHost,
    maskSecretString,
    messagesContainVisionInput,
    modelRouter,
    modelSupportsVision,
    normalizeHostAlias,
    normalizeModelBaseUrl,
    normalizeRegenerateFlag,
    optimizeDatabase,
    overallStatus,
    path,
    publishUserEvent,
    readZipEntries,
    recordModelTokenUsage,
    redactSecrets,
    runExpressHandlers,
    saveAssistantMessage,
    saveUserMessage,
    shouldUseResponsesApi,
    splitStreamTextForDisplay,
    stmts,
    streamingTools,
    subscribeUserEvents,
    test,
    titleHelpers,
    touchSession,
    updateLastAssistantStats,
    vm,
    withTimeoutHelper
} = require('./security-helpers');

test('safe HTML fallback escapes input when DOMPurify is unavailable', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'client', 'chat', 'safe-html.js'), 'utf8');
    const sandbox = { window: {} };
    vm.runInNewContext(source, sandbox);
    assert.equal(
        sandbox.window.PivotSafeHtml.sanitizeHtml('<img src=x onerror=alert(1)>'),
        '&lt;img src=x onerror=alert(1)&gt;'
    );
});

test('chat renderer accepts loose ECharts-style chart specs', () => {
    const sandbox = createChatRenderSandbox();
    const looseChartSpec = {
        type: 'bar',
        title: 'table_account 表中 group_id 分布统计',
        xAxis: {
            type: 'category',
            name: 'group_id'
        },
        yAxis: {
            type: 'value',
            name: '数量'
        },
        series: [
            {
                name: '账户数量',
                type: 'bar',
                data: []
            }
        ],
        tooltip: {
            trigger: 'axis'
        },
        dataQuery: {
            database: 'hcdb',
            table: 'table_account'
        }
    };
    const normalized = sandbox.normalizePivotChartSpec(JSON.stringify(looseChartSpec));
    assert.ok(normalized);
    assert.equal(normalized.chartType, 'bar');
    assert.equal(normalized.title, 'table_account 表中 group_id 分布统计');
    assert.equal(normalized.xAxis.label, 'group_id');
    assert.equal(normalized.yAxis.label, '数量');
    assert.equal(normalized.series.length, 1);
    assert.equal(normalized.series[0].name, '账户数量');
    assert.equal(normalized.series[0].data.length, 0);
    assert.equal(normalized.source.format, 'loose_chart');
    assert.equal(normalized.source.dataQuery.database, 'hcdb');
    assert.equal(normalized.source.dataQuery.table, 'table_account');

    const html = sandbox.renderMarkdown(`\`\`\`chart\n${JSON.stringify(looseChartSpec, null, 2)}\n\`\`\``);
    assert.match(html, /pivot-echart-block/);
});

test('chat renderer defers pivot chart blocks while streaming', () => {
    const sandbox = createChatRenderSandbox();
    const chart = {
        type: 'pivot_chart',
        chartType: 'bar',
        title: 'group_id count',
        labels: ['0', '3'],
        series: [{ name: 'count', data: [2, 1] }]
    };
    const markdown = [
        'chart below',
        '```pivot-echart',
        JSON.stringify(chart, null, 2),
        '```'
    ].join('\n');

    const streamingHtml = sandbox.renderAiMessage(markdown, true);
    assert.doesNotMatch(streamingHtml, /pivot-echart-block/);
    assert.doesNotMatch(streamingHtml, /data-pivot-echart/);

    const finalHtml = sandbox.renderAiMessage(markdown, false);
    assert.match(finalHtml, /pivot-echart-block/);
});

test('chat route embeds streamed chart specs into persisted assistant content', () => {
    const chart = {
        type: 'pivot_chart',
        chartType: 'bar',
        title: 'group_id count',
        labels: ['0', '3'],
        series: [{ name: 'count', data: [2, 1] }]
    };

    const content = appendStreamedChartsToAssistantContent('analysis text', [chart, chart]);
    assert.match(content, /analysis text/);
    assert.match(content, /```pivot-echart/);
    assert.match(content, /"type": "pivot_chart"/);
    assert.equal((content.match(/```pivot-echart/g) || []).length, 1);

    const alreadyHasChart = [
        'analysis text',
        '```pivot-echart',
        '{}',
        '```'
    ].join('\n');
    assert.equal(appendStreamedChartsToAssistantContent(alreadyHasChart, [chart]), alreadyHasChart);
});

test('chat chart SSE capture stores chart events without forwarding them', () => {
    const chart = {
        type: 'pivot_chart',
        chartType: 'bar',
        title: 'group_id count',
        labels: ['0', '3'],
        series: [{ name: 'count', data: [2, 1] }]
    };
    const forwarded = [];
    const { streamedChartSpecs, writeSse } = createChartSseCapture(payload => forwarded.push(payload));

    assert.equal(writeSse(JSON.stringify({ type: 'chart', data: chart })), false);
    assert.equal(writeSse(JSON.stringify({ type: 'chart', data: chart })), false);
    assert.deepEqual(forwarded, []);
    assert.equal(streamedChartSpecs.length, 1);
    assert.deepEqual(streamedChartSpecs[0], chart);

    const notice = JSON.stringify({ type: 'mcp', status: 'done' });
    assert.equal(writeSse(notice), true);
    assert.deepEqual(forwarded, [notice]);
});

test('buildFtsQuery escapes user input into phrase terms', () => {
    assert.equal(buildFtsQuery('hello world'), '"hello" AND "world"');
    assert.equal(buildFtsQuery('a"b NEAR c'), '"a""b" AND "NEAR" AND "c"');
    assert.equal(buildFtsQuery('   '), '');
});

test('createSseEventParser parses chunked SSE payloads', () => {
    const payloads = [];
    const parser = createSseEventParser({
        onData: payload => payloads.push(payload)
    });
    parser.write(Buffer.from('data: {"choices":[{"delta":{"content":"he'));
    parser.write(Buffer.from('llo"}}]}\n\ndata: [DONE]\n\n'));
    parser.end();
    assert.equal(payloads.length, 1);
    const extracted = extractStreamPayload(JSON.parse(payloads[0]));
    assert.deepEqual(extracted, { delta: 'hello', isThought: false, usage: null });
});

test('stream payload extraction accepts full message payloads and splits large deltas', () => {
    const extracted = extractStreamPayload({
        choices: [{ message: { content: 'complete answer' } }],
        usage: { completion_tokens: 3 }
    });
    assert.deepEqual(extracted, {
        delta: 'complete answer',
        isThought: false,
        usage: { completion_tokens: 3 }
    });

    const chunks = splitStreamTextForDisplay('a'.repeat(420), { targetLength: 80, maxLength: 120 });
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(''), 'a'.repeat(420));
});

test('realtime SSE events are scoped to the subscribed user', () => {
    const first = createFakeSseResponse();
    const second = createFakeSseResponse();
    const unsubscribeFirst = subscribeUserEvents({ id: 101 }, first, { heartbeatMs: 0 });
    const unsubscribeSecond = subscribeUserEvents({ id: 202 }, second, { heartbeatMs: 0 });

    const delivered = publishUserEvent(101, 'agent.run', { run: { id: 'run-test', status: 'queued' } });

    assert.equal(delivered, 1);
    assert.match(first.headers['content-type'], /text\/event-stream/);
    assert.match(first.chunks.join(''), /event: agent\.run/);
    assert.match(first.chunks.join(''), /run-test/);
    assert.doesNotMatch(second.chunks.join(''), /run-test/);
    assert.equal(getRealtimeStats().clients >= 2, true);

    unsubscribeFirst();
    unsubscribeSecond();
});

test('createStreamAccumulator wraps reasoning deltas and captures usage', () => {
    const emitted = [];
    const accumulator = createStreamAccumulator({
        includeThoughtTags: true,
        onContent: chunk => emitted.push(chunk)
    });
    accumulator.pushJson({ choices: [{ delta: { reasoning_content: 'reasoning' } }] });
    accumulator.pushJson({ choices: [{ delta: { content: 'answer' } }], usage: { completion_tokens: 2 } });
    accumulator.finish();

    assert.equal(accumulator.getContent(), '<thought>reasoning</thought>answer');
    assert.deepEqual(emitted, ['<thought>reasoning', '</thought>answer']);
    assert.deepEqual(accumulator.getUsage(), { completion_tokens: 2 });
});

test('createStreamAccumulator can collect forwarded stream text without thought tags', () => {
    const accumulator = createStreamAccumulator();
    accumulator.pushPayload(JSON.stringify({ choices: [{ delta: { reasoning_content: 'hidden' } }] }));
    accumulator.pushPayload(JSON.stringify({ choices: [{ delta: { content: ' shown' } }] }));
    accumulator.pushPayload('{bad json');
    accumulator.finish();
    assert.equal(accumulator.getContent(), 'hidden shown');
});

test('model adapter normalizes compatible endpoint URLs without changing local chat behavior', () => {
    assert.equal(
        normalizeModelBaseUrl('https://api.example.com', { appendV1ForLocal: false }),
        'https://api.example.com/v1'
    );
    assert.equal(
        normalizeModelBaseUrl('http://localhost:8000', { appendV1ForLocal: false }),
        'http://localhost:8000'
    );
    assert.equal(
        buildChatCompletionsUrl('https://api.example.com/v1/chat/completions'),
        'https://api.example.com/v1/chat/completions'
    );
    assert.equal(
        buildChatCompletionsUrl('http://127.0.0.1:8000', { appendV1ForLocal: true }),
        'http://127.0.0.1:8000/v1/chat/completions'
    );
    assert.equal(
        buildResponsesUrl('https://api.example.com'),
        'https://api.example.com/v1/responses'
    );
    assert.equal(shouldUseResponsesApi('gpt-5.1'), true);
    assert.equal(shouldUseResponsesApi('qwen2.5'), false);
});

test('model adapter converts chat messages to Responses API input', () => {
    const converted = convertChatMessagesToResponsesInput([
        { role: 'system', content: 'security policy' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'look at image' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
            ]
        }
    ]);
    assert.equal(converted[0].role, 'user');
    assert.match(converted[0].content, /security policy/);
    assert.deepEqual(converted[1].content[1], {
        type: 'input_image',
        image_url: 'data:image/png;base64,abc'
    });

    const headers = buildModelHeaders({ api_key: 'secret' }, { acceptJson: true });
    assert.equal(headers.Authorization, 'Bearer secret');
    assert.equal(headers['x-api-key'], 'secret');
    assert.equal(headers.Accept, 'application/json');
});

test('getContext compacts over-threshold history before returning model context', async () => {
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

test('chat message service saves messages and updates session stats', () => {
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

test('session messages include assistant model display metadata', () => {
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

test('chat route persists assistant error messages when upstream model fails', async () => {
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

test('chat route replays non-streaming upstream JSON as chat SSE content', async () => {
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
            SELECT role, content, token_count
            FROM messages
            WHERE session_id = ? AND user_id = ? AND role = 'assistant'
            ORDER BY id DESC
        `).get(sessionId, userId);

        assert.ok(assistant);
        assert.equal(assistant.content, 'fallback streamed answer');
        assert.equal(assistant.token_count, 4);
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

test('session list can skip total count for cursor-first sidebar loading', async () => {
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

test('announcement routes target active notices and persist user acknowledgement state', async () => {
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

test('ConcurrencySemaphore reports queue position for waiting requests', async () => {
    const semaphore = new ConcurrencySemaphore({
        maxConcurrent: 1,
        maxQueueSize: 2,
        queueTimeoutMs: 5000
    });
    await semaphore.acquire();

    let notice = null;
    const waiting = semaphore.acquire({
        onQueued: info => {
            notice = info;
        }
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notice.position, 1);
    assert.equal(notice.queueAhead, 0);
    assert.equal(notice.queueLength, 1);
    assert.equal(notice.maxQueue, 2);

    semaphore.release();
    await waiting;
    semaphore.release();
});

test('model vision capability helpers detect visual inputs and flags', () => {
    assert.equal(modelSupportsVision({ supports_vision: 1 }), true);
    assert.equal(modelSupportsVision({ supports_vision: 0 }), false);
    assert.equal(contentContainsVisionInput('![screenshot](/uploads/1/session/a.png)'), true);
    assert.equal(contentContainsVisionInput('![screenshot](/uploads/1/session/a%20(1).jpg?token=abc)'), true);
    assert.equal(contentContainsVisionInput('![screenshot](/uploads/1/session/a (1).jpg?token=abc)'), true);
    assert.equal(contentContainsVisionInput('plain text without image'), false);
    assert.equal(messagesContainVisionInput([
        { role: 'user', content: [{ type: 'text', text: 'look at image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ]), true);
});

test('chat language instruction asks visible reasoning to stay in Chinese', () => {
    const withoutSystem = applyChatLanguageInstruction([{ role: 'user', content: '介绍一下' }]);
    assert.equal(withoutSystem[0].role, 'system');
    assert.match(withoutSystem[0].content, /【重要语言规则】/);
    assert.match(withoutSystem[0].content, /必须全程使用中文/);
    assert.match(withoutSystem[0].content, /reasoning_content/);

    const withSystem = applyChatLanguageInstruction([
        { role: 'system', content: '你是助手。' },
        { role: 'user', content: '介绍一下' }
    ]);
    assert.equal(withSystem.length, 2);
    assert.match(withSystem[0].content, /你是助手/);
    assert.match(withSystem[0].content, /禁止使用英文提纲或英文推理/);
});

test('chat regenerate flag only accepts explicit true values', () => {
    assert.equal(normalizeRegenerateFlag(true), true);
    assert.equal(normalizeRegenerateFlag('true'), true);
    assert.equal(normalizeRegenerateFlag(false), false);
    assert.equal(normalizeRegenerateFlag(undefined), false);
    assert.equal(normalizeRegenerateFlag({ type: 'click' }), false);
    assert.equal(normalizeRegenerateFlag('false'), false);
});

test('model usage events count toward daily model quota usage', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`quota_test_${suffix}`, 'hash', 'Quota Test', 'QA', 'user', 'active');
    const modelInfo = db.prepare(`
        INSERT INTO models (name, url, model_name, created_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'))
    `).run(`Quota Model ${suffix}`, 'http://127.0.0.1:1/v1', 'test-model');

    try {
        recordModelTokenUsage(userInfo.lastInsertRowid, modelInfo.lastInsertRowid, 123, 'openai_api_key');
        assert.equal(getModelDailyUsage(userInfo.lastInsertRowid, modelInfo.lastInsertRowid), 123);
    } finally {
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('local model host detection includes request and configured host aliases', () => {
    assert.equal(normalizeHostAlias('http://50.64.150.40:8080/v1'), '50.64.150.40');
    assert.equal(normalizeHostAlias('ai.example.com:3000'), 'ai.example.com');

    const previousAliases = process.env.PIVOT_LOCAL_MODEL_HOSTS;
    const previousAdvertiseAliases = process.env.PIVOT_ADVERTISE_HOSTS;
    const previousCorsOrigin = process.env.CORS_ORIGIN;
    const previousLegacyAliases = process.env.MODEL_LOCAL_HOSTS;
    process.env.PIVOT_LOCAL_MODEL_HOSTS = '203.0.113.10,llama-server:8080';
    process.env.PIVOT_ADVERTISE_HOSTS = '192.168.31.10,pivot.local:4088';
    process.env.CORS_ORIGIN = 'http://pivot.example.com:4088';
    process.env.MODEL_LOCAL_HOSTS = '198.51.100.44';
    try {
        const names = getLocalHostnames({
            publicUrl: 'https://50.64.150.40/app',
            requestHosts: ['ai.example.com:3000', 'models.internal:8080, proxy.example']
        });
        assert.equal(names.has('50.64.150.40'), true);
        assert.equal(names.has('ai.example.com'), true);
        assert.equal(names.has('models.internal'), true);
        assert.equal(names.has('203.0.113.10'), true);
        assert.equal(names.has('llama-server'), true);
        assert.equal(names.has('192.168.31.10'), true);
        assert.equal(names.has('pivot.local'), true);
        assert.equal(names.has('pivot.example.com'), true);
        assert.equal(isLocalModelHost('http://192.168.31.10:8000/v1', names), true);
        assert.equal(isLocalModelHost('http://pivot.example.com:8000/v1', names), true);
        assert.equal(names.has('198.51.100.44'), false);
    } finally {
        if (previousAliases === undefined) {
            delete process.env.PIVOT_LOCAL_MODEL_HOSTS;
        } else {
            process.env.PIVOT_LOCAL_MODEL_HOSTS = previousAliases;
        }
        if (previousAdvertiseAliases === undefined) {
            delete process.env.PIVOT_ADVERTISE_HOSTS;
        } else {
            process.env.PIVOT_ADVERTISE_HOSTS = previousAdvertiseAliases;
        }
        if (previousCorsOrigin === undefined) {
            delete process.env.CORS_ORIGIN;
        } else {
            process.env.CORS_ORIGIN = previousCorsOrigin;
        }
        if (previousLegacyAliases === undefined) {
            delete process.env.MODEL_LOCAL_HOSTS;
        } else {
            process.env.MODEL_LOCAL_HOSTS = previousLegacyAliases;
        }
    }
});

test('docker internal service names are local for trusted or detected container runtimes', () => {
    const previousTrust = process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS;
    const previousKubernetesHost = process.env.KUBERNETES_SERVICE_HOST;
    const previousContainerFlag = process.env.PIVOT_RUNNING_IN_CONTAINER;
    try {
        process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS = 'true';
        delete process.env.PIVOT_RUNNING_IN_CONTAINER;
        delete process.env.KUBERNETES_SERVICE_HOST;
        assert.equal(isDockerInternalServiceHost('llama-server'), true);
        assert.equal(isDockerInternalServiceHost('llama-server:8080'), true);
        assert.equal(isDockerInternalServiceHost('api.internal'), false);
        assert.equal(isDockerInternalServiceHost('10.0.0.8'), false);
        assert.equal(isLocalModelHost('llama-server', new Set()), true);

        process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS = 'false';
        process.env.PIVOT_RUNNING_IN_CONTAINER = 'true';
        assert.equal(isDockerInternalServiceHost('llama-server'), false);
        assert.equal(isLocalModelHost('llama-server', new Set()), false);

        delete process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS;
        process.env.PIVOT_RUNNING_IN_CONTAINER = 'true';
        assert.equal(isDockerInternalServiceHost('llama-server'), true);
        assert.equal(isLocalModelHost('llama-server', new Set()), true);

        process.env.PIVOT_RUNNING_IN_CONTAINER = 'false';
        assert.equal(isDockerInternalServiceHost('llama-server'), false);

        delete process.env.PIVOT_RUNNING_IN_CONTAINER;
        process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
        assert.equal(isDockerInternalServiceHost('llama-server'), false);
    } finally {
        if (previousTrust === undefined) {
            delete process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS;
        } else {
            process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS = previousTrust;
        }
        if (previousKubernetesHost === undefined) {
            delete process.env.KUBERNETES_SERVICE_HOST;
        } else {
            process.env.KUBERNETES_SERVICE_HOST = previousKubernetesHost;
        }
        if (previousContainerFlag === undefined) {
            delete process.env.PIVOT_RUNNING_IN_CONTAINER;
        } else {
            process.env.PIVOT_RUNNING_IN_CONTAINER = previousContainerFlag;
        }
    }
});

test('system health snapshot reports core checks and aggregate status', () => {
    assert.equal(overallStatus([{ status: 'ok' }, { status: 'degraded' }]), 'degraded');
    assert.equal(overallStatus([{ status: 'ok' }, { status: 'error' }]), 'error');

    const health = getSystemHealthSnapshot();
    assert.ok(['ok', 'degraded', 'error'].includes(health.status));
    assert.ok(health.checks.some(item => item.name === 'database'));
    assert.ok(health.checks.some(item => item.name === 'dataDir'));
    assert.ok(health.checks.some(item => item.name === 'uploadsDir'));
    const disk = health.checks.find(item => item.name === 'disk');
    assert.ok(disk);
    assert.ok(['ok', 'degraded', 'error', 'unknown'].includes(disk.status));
    assert.ok(typeof disk.path === 'string' && disk.path.length > 0);
    if (disk.status !== 'unknown') {
        assert.ok(Number(disk.total) >= 0);
        assert.ok(Number(disk.free) >= 0);
        assert.ok(Number(disk.usedRatio) >= 0);
    }
});

test('maintenance tasks record cleanup and optimize status', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`maint_${suffix}`, 'hash', 'Maintenance Test', 'QA', 'user', 'active');
    const keyInfo = db.prepare(`
        INSERT INTO api_keys (user_id, name, key_hash, key_preview, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `maint-key-${suffix}`, `hash-${suffix}`, `preview-${suffix}`);

    db.prepare(`
        INSERT INTO audit_logs (user_id, action, details, timestamp)
        VALUES (?, ?, ?, datetime('now', '+8 hours', '-400 days'))
    `).run(userInfo.lastInsertRowid, `MAINT_AUDIT_${suffix}`, 'old audit');
    db.prepare(`
        INSERT INTO api_call_logs (user_id, api_key_id, model_name, status, created_at)
        VALUES (?, ?, ?, 'success', datetime('now', '+8 hours', '-60 days'))
    `).run(userInfo.lastInsertRowid, keyInfo.lastInsertRowid, `maint-model-${suffix}`);
    db.prepare(`
        INSERT INTO refresh_tokens (user_id, token, expires_at, created_at)
        VALUES (?, ?, datetime('now', '+8 hours', '-1 day'), datetime('now', '+8 hours', '-2 days'))
    `).run(userInfo.lastInsertRowid, `expired-refresh-${suffix}`);

    try {
        assert.ok(await cleanupOldLogs(180) >= 1);
        assert.ok(await cleanupApiCallLogs(30) >= 1);
        assert.ok(await cleanupExpiredRefreshTokens() >= 1);
        assert.equal(await optimizeDatabase(), true);
        const status = getMaintenanceStatus();
        assert.ok(status.auditCleanup.lastSuccessAt);
        assert.ok(status.apiCallLogCleanup.lastSuccessAt);
        assert.ok(status.refreshTokenCleanup.lastSuccessAt);
        assert.ok(status.optimize.lastSuccessAt);
        assert.equal(status.optimize.vacuumPages, 200);
    } finally {
        db.prepare('DELETE FROM audit_logs WHERE action = ?').run(`MAINT_AUDIT_${suffix}`);
        db.prepare('DELETE FROM api_call_logs WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('database backup task creates hot backup and prunes old versions', async () => {
    const backupDir = path.join(process.env.DATA_DIR, `backup-test-${Date.now().toString(36)}`);
    fs.mkdirSync(backupDir, { recursive: true });
    try {
        for (let i = 0; i < 3; i += 1) {
            const oldPath = path.join(backupDir, `chat_backup_old_${i}.db`);
            fs.writeFileSync(oldPath, `old-${i}`);
            const oldTime = Date.now() - (10 + i) * 24 * 60 * 60 * 1000;
            fs.utimesSync(oldPath, oldTime / 1000, oldTime / 1000);
        }

        const result = await backupDatabase({ backupDir, retentionDays: 7, maxVersions: 2 });
        assert.ok(result?.backupPath);
        assert.ok(fs.existsSync(result.backupPath));
        assert.ok(result.sizeBytes > 0);
        assert.equal(result.cleanup.deletedFiles, 3);

        const firstBackup = result.backupPath;
        const firstTime = Date.now() - 1000;
        fs.utimesSync(firstBackup, firstTime / 1000, firstTime / 1000);
        const second = await backupDatabase({ backupDir, retentionDays: 7, maxVersions: 1 });
        assert.ok(second?.backupPath);
        assert.equal(fs.existsSync(second.backupPath), true);
        assert.equal(fs.existsSync(firstBackup), false);

        const cleanup = cleanupOldBackups({ backupDir, retentionDays: 7, maxVersions: 1 });
        assert.ok(cleanup.remainingFiles <= 1);

        const status = getMaintenanceStatus();
        assert.ok(status.backup.lastSuccessAt);
        assert.equal(status.backup.backupDir, backupDir);
        assert.equal(status.backup.retentionDays, 7);
        assert.equal(status.backup.maxVersions, 1);
    } finally {
        fs.rmSync(backupDir, { recursive: true, force: true });
    }
});

test('OpenAI model discovery excludes built-in tools pseudo model', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`openai_models_${suffix}`, 'hash', 'OpenAI Models User', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `openai_models_${suffix}`, role: 'user', unit: 'QA' };
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Chat Model', 'https://model.example/v1/chat/completions', `chat-model-${suffix}`);
    const router = createOpenAIRouter({
        authMiddleware: (req, res, next) => {
            req.user = user;
            next();
        },
        embeddingLimiter: (req, res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/models');
    assert.ok(route);

    try {
        const req = {};
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                this.body = body;
                return this;
            }
        };
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body?.data?.some(item => item.id === `chat-model-${suffix}`));
        assert.equal(res.body.data.some(item => item.id === 'pivot-tools'), false);
    } finally {
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('model cost helpers and compliance package generate auditable exports', () => {
    assert.equal(calculateUsageCost({
        inputTokens: 1000000,
        outputTokens: 500000,
        inputPricePerMillion: 2,
        outputPricePerMillion: 6
    }), 5);

    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`compliance_${suffix}`, 'hash', 'Compliance User', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, input_price_per_million, output_price_per_million, price_currency, created_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, datetime('now', '+8 hours'))
    `).run(userId, 'Cost Model', 'https://model.example/v1', 'cost-model', 1.5, 4.5, 'CNY');
    const modelId = Number(modelInfo.lastInsertRowid);
    const sessionId = `compliance-session-${suffix}`;
    db.prepare('INSERT INTO sessions (id, user_id, title, tags, created_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\', \'+8 hours\'), datetime(\'now\', \'+8 hours\'))')
        .run(sessionId, userId, 'Compliance Session', 'audit');
    db.prepare('INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\', \'+8 hours\'))')
        .run(sessionId, userId, 'user', 'hello', 10, modelId);
    db.prepare('INSERT INTO model_usage_events (user_id, model_id, source, token_count, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\', \'+8 hours\'))')
        .run(userId, modelId, 'api', 30, 10, 20);
    db.prepare('INSERT INTO audit_logs (user_id, action, details, timestamp) VALUES (?, ?, ?, datetime(\'now\', \'+8 hours\'))')
        .run(userId, `COMPLIANCE_${suffix}`, 'export package test');

    try {
        const archive = buildComplianceAuditPackage({
            db,
            escapeCsvCell: value => `"${String(value ?? '').replace(/"/g, '""')}"`,
            generatedAt: '2026-05-16 00:00:00',
            filters: {}
        });
        assert.ok(Buffer.isBuffer(archive));
        assert.equal(archive.readUInt32LE(0), 0x04034b50);
        assert.ok(archive.includes(Buffer.from('manifest.json')));
        assert.ok(archive.includes(Buffer.from('model_costs.csv')));

        const smallZip = buildZipArchive([{ name: 'hello.txt', content: 'world' }]);
        assert.equal(smallZip.readUInt32LE(0), 0x04034b50);
    } finally {
        db.prepare('DELETE FROM audit_logs WHERE action = ?').run(`COMPLIANCE_${suffix}`);
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('readZipEntries rejects entries with excessive declared expansion', () => {
    const zip = buildSingleEntryZip({
        name: 'word/document.xml',
        data: Buffer.from('<w:t>small</w:t>'),
        declaredUncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1
    });
    assert.throws(() => readZipEntries(zip), /too large|too much data/);
});

test('chat title helpers sanitize generated titles and protect custom titles', () => {
    assert.equal(
        titleHelpers.sanitizeGeneratedTitle('User permission setup flow', 'Permission setup'),
        'User permission setup fl'
    );
    assert.equal(
        titleHelpers.sanitizeGeneratedTitle('untitled', 'Document content analysis'),
        'Document content analysis'
    );
    assert.equal(
        titleHelpers.buildFallbackTitle('Please analyze this quarterly sales spreadsheet and summarize risks.'),
        'Please analyze this quar'
    );
    assert.equal(
        titleHelpers.shouldReplaceAutoTitle('User greets ass...', 'User greets assistant'),
        true
    );
    assert.equal(
        titleHelpers.shouldReplaceAutoTitle('Manually named chat', 'User greets assistant'),
        false
    );
});

test('LruCache evicts least-recently-used entries past the capacity', () => {
    const cache = new LruCache({ max: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a');
    cache.set('d', 4);
    assert.equal(cache.has('b'), false);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('d'), 4);
});

test('LruCache honours TTL and reports miss after expiration', async () => {
    const cache = new LruCache({ max: 8, ttlMs: 30 });
    cache.set('k', 'v');
    assert.equal(cache.get('k'), 'v');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(cache.get('k'), undefined);
});

test('TtlCache lazily prunes expired entries', async () => {
    const cache = new TtlCache(20);
    cache.set('a', 1);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(cache.get('a'), undefined);
    cache.set('b', 2);
    cache.prune();
    assert.equal(cache.size, 1);
});

test('withTimeout rejects with TimeoutError when the task hangs', async () => {
    await assert.rejects(
        withTimeoutHelper(() => new Promise(() => {}), 1000, '测试任务'),
        (err) => err instanceof WithTimeoutError && /测试任务/.test(err.message)
    );
});

test('withTimeout resolves before the timer elapses', async () => {
    const result = await withTimeoutHelper(() => Promise.resolve(42), 1000, '快任务');
    assert.equal(result, 42);
});

test('KeyedConcurrencyGuard skips duplicate keys but releases on completion', async () => {
    const guard = new KeyedConcurrencyGuard({ maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const task = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return 'done';
    };
    const [a, b, c] = await Promise.all([
        guard.run('s1', task),
        guard.run('s1', task),
        guard.run('s2', task)
    ]);
    assert.equal(a.skipped, false);
    assert.equal(a.value, 'done');
    assert.equal(b.skipped, true);
    assert.equal(b.reason, 'duplicate');
    assert.equal(c.skipped, false);
    assert.equal(peak <= 2, true);
});

test('redactSecrets masks api keys and tokens in nested structures', () => {
    const input = {
        api_key: 'sk-abc123xyz789secrettoken',
        nested: {
            authorization: 'Bearer eyJraWQiOiJ0ZXN0IiwibmFtZSI6Im1pY2tleSJ9.payload.signature',
            note: 'public field'
        },
        items: [
            { secret_token: 'topsecret-payload-1234567890abcdef' },
            { description: 'no secret here' }
        ]
    };
    const redacted = redactSecrets(input);
    assert.equal(redacted.api_key, '[REDACTED]');
    assert.equal(redacted.nested.authorization, '[REDACTED]');
    assert.equal(redacted.nested.note, 'public field');
    assert.equal(redacted.items[0].secret_token, '[REDACTED]');
    assert.equal(redacted.items[1].description, 'no secret here');
});

test('maskSecretString redacts sk-* and Bearer tokens inline', () => {
    const text = 'curl -H "Authorization: Bearer eyJabcdefghij.kkkkkkkkkk.mmmmmmmmmm" https://api.example.com using sk-abcdefghijklmnop1234';
    const masked = maskSecretString(text);
    assert.equal(masked.includes('sk-abcdefghijklmnop1234'), false);
    assert.equal(masked.includes('eyJabcdefghij.kkkkkkkkkk.mmmmmmmmmm'), false);
    assert.equal(masked.includes('[REDACTED]'), true);
});

test('redactSecrets does not mutate the original object reference', () => {
    const original = { api_key: 'secret', note: 'hi' };
    const redacted = redactSecrets(original);
    assert.notEqual(redacted, original);
    assert.equal(original.api_key, 'secret');
    assert.equal(redacted.api_key, '[REDACTED]');
});

test('estimateMessageTokens 中英文混合按 2:0.5 估算', () => {
    assert.equal(modelRouter.estimateMessageTokens([{ role: 'user', content: '中文测试' }]), Math.ceil(4 * 2));
    const englishTokens = modelRouter.estimateMessageTokens([{ role: 'user', content: 'hello world' }]);
    assert.ok(englishTokens >= 5 && englishTokens <= 8);
    assert.equal(modelRouter.estimateMessageTokens([]), 0);
    assert.equal(modelRouter.estimateMessageTokens([{ role: 'user', content: '' }]), 0);
});

test('hasUsableInputWindow 在窗口未配置时视为足够', () => {
    assert.equal(modelRouter.hasUsableInputWindow({ max_input_tokens: 0 }, 9999), true);
    assert.equal(modelRouter.hasUsableInputWindow({ max_input_tokens: 100 }, 50), true);
    assert.equal(modelRouter.hasUsableInputWindow({ max_input_tokens: 100 }, 150), false);
});

test('modelTotalPrice 累加输入输出单价并对缺失字段安全', () => {
    assert.equal(modelRouter.modelTotalPrice({ input_price_per_million: 3, output_price_per_million: 12 }), 15);
    assert.equal(modelRouter.modelTotalPrice({}), 0);
    assert.equal(modelRouter.modelTotalPrice({ input_price_per_million: 'invalid' }), 0);
});

test('累加器同时记录 content 文本与多个工具调用', () => {
    const acc = streamingTools.createToolCallAccumulator();
    acc.ingest({ choices: [{ delta: { content: '我先去查一下知识库。' } }] });
    acc.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'rag.search', arguments: '{"q":"A"}' } }] } }] });
    acc.ingest({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'rag.summary', arguments: '{"docId":1}' } }] } }] });
    acc.ingest({ choices: [{ finish_reason: 'tool_calls' }] });
    const result = acc.finalize();
    assert.equal(result.content, '我先去查一下知识库。');
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, 'rag.search');
    assert.equal(result.toolCalls[1].name, 'rag.summary');
    assert.deepEqual(result.toolCalls[1].arguments, { docId: 1 });
});

test('累加器对 arguments JSON 解析失败保留原始字符串与 parseError', () => {
    const acc = streamingTools.createToolCallAccumulator();
    acc.ingest({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'broken', arguments: '{invalid' } }] } }] });
    acc.ingest({ choices: [{ finish_reason: 'tool_calls' }] });
    const result = acc.finalize();
    assert.equal(result.toolCalls[0].arguments, null);
    assert.equal(result.toolCalls[0].argumentsRaw, '{invalid');
    assert.ok(result.toolCalls[0].parseError.length > 0);
});

test('累加器在超过 TOOL_CALL_LIMIT 时记录错误并丢弃新增项', () => {
    const acc = streamingTools.createToolCallAccumulator();
    for (let i = 0; i < streamingTools.TOOL_CALL_LIMIT + 4; i += 1) {
        acc.ingest({ choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name: `t${i}`, arguments: '{}' } }] } }] });
    }
    const result = acc.finalize();
    assert.equal(result.toolCalls.length, streamingTools.TOOL_CALL_LIMIT);
    assert.ok(result.errors.length > 0);
});
