const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-security-suite-please-do-not-use';
const generatedTestDataDir = !process.env.DATA_DIR;
if (generatedTestDataDir) {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-security-test-'));
}

const {
    assertSafeOutboundUrl,
    resolveUploadUrlPath,
    isSensitiveOutboundHost,
    toProjectRelativePath,
    isPathInsideUploadRoot
} = require('../server/security');
const { buildFtsQuery } = require('../server/search');
const { createSseEventParser, createStreamAccumulator, extractStreamPayload } = require('../server/streaming');
const {
    csrfMiddleware,
    CSRF_COOKIE_NAME,
    getCookie
} = require('../server/auth');
const {
    buildFtsOrQuery,
    buildEmbeddingPayload,
    buildKeywordCandidates,
    buildRagSearchContent,
    chunkText,
    cosineSimilarity,
    debugRetrieveContext,
    normalizeEmbeddingVector,
    resolveEmbeddingUrl
} = require('../server/services/rag-index');
const {
    getModelDailyUsage,
    recordModelTokenUsage,
    contentContainsVisionInput,
    messagesContainVisionInput,
    modelSupportsVision
} = require('../server/services/models');
const {
    getLocalHostnames,
    isDockerInternalServiceHost,
    isLocalModelHost,
    normalizeHostAlias
} = require('../server/routes/admin-stats');
const {
    readZipEntries,
    MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES
} = require('../server/document-text');
const titleHelpers = require('../server/services/chat-title');
const { ConcurrencySemaphore } = require('../server/services/concurrency');
const {
    buildChatCompletionsUrl,
    buildModelHeaders,
    buildResponsesUrl,
    convertChatMessagesToResponsesInput,
    normalizeModelBaseUrl,
    shouldUseResponsesApi
} = require('../server/services/model-adapter');
const {
    countVisibleConversationMessages,
    saveAssistantMessage,
    saveUserMessage,
    touchSession,
    updateLastAssistantStats
} = require('../server/services/chat-messages');
const {
    getKnowledgeSourcePath,
    deleteKnowledgeDocument,
    getKnowledgeDocumentAuditList,
    getKnowledgeDocumentSummaryForUser,
    getKnowledgeDocumentDetail,
    getRagFeedbackSummary,
    processKnowledgeDocument,
    recordRagFeedback,
    recoverStaleKnowledgeDocumentIndexes,
    scheduleFailedKnowledgeDocumentsForUser
} = require('../server/services/rag-documents');
const {
    getEmbeddingConfig,
    getPublicEmbeddingConfig,
    getRagConfig,
    normalizeEmbeddingMode,
    RAG_CONFIG_KEYS,
    toRagSettingValue
} = require('../server/services/rag-config');
const {
    buildEmbeddingModelListUrls,
    extractEmbeddingModelIds
} = require('../server/routes/settings');
const {
    cleanupApiCallLogs,
    cleanupExpiredRefreshTokens,
    cleanupOldLogs,
    backupDatabase,
    cleanupOldBackups,
    getMaintenanceStatus,
    optimizeDatabase
} = require('../server/services/maintenance');
const { cleanupSoftDeletedStorage } = require('../server/services/storage-gc');
const { createAdminUsersRouter } = require('../server/routes/admin-users');
const { createModelsRouter } = require('../server/routes/models');
const {
    buildEmbeddingModelItem,
    buildEmbeddingResponse,
    createOpenAIRouter,
    normalizeEmbeddingInputs
} = require('../server/routes/openai');
const {
    getSystemHealthSnapshot,
    overallStatus
} = require('../server/services/system-health');
const { db } = require('../server/db');

const uploadRoot = path.resolve(__dirname, '..', 'uploads');

test.after(async () => {
    await new Promise(resolve => setImmediate(resolve));
    if (generatedTestDataDir && process.env.DATA_DIR) {
        db.close();
        fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    }
});

test('resolveUploadUrlPath accepts normal upload URLs', () => {
    const target = resolveUploadUrlPath('/uploads/1/session/file.png?token=abc');
    assert.equal(target, path.resolve(uploadRoot, '1', 'session', 'file.png'));
    assert.equal(toProjectRelativePath(target), 'uploads/1/session/file.png');
});

test('resolveUploadUrlPath rejects traversal and non-upload URLs', () => {
    assert.equal(resolveUploadUrlPath('/api/health'), null);
    assert.equal(resolveUploadUrlPath('/uploads/../data/chat.db'), null);
    assert.equal(resolveUploadUrlPath('/uploads/%2e%2e/data/chat.db'), null);
    assert.equal(resolveUploadUrlPath('/uploads/1/../../server/index.js'), null);
    assert.equal(isPathInsideUploadRoot(path.resolve(__dirname, '..', 'server', 'index.js')), false);
});

test('getCookie ignores malformed percent-encoded cookie pairs', () => {
    const req = {
        headers: {
            cookie: 'bad=%E0%A4%A; pivot_csrf_token=valid-token'
        }
    };
    assert.equal(getCookie(req, 'pivot_csrf_token'), 'valid-token');
    assert.equal(getCookie(req, 'bad'), undefined);
});

test('outbound URL guard blocks sensitive SSRF targets', async () => {
    assert.equal(isSensitiveOutboundHost('127.0.0.1'), true);
    assert.equal(isSensitiveOutboundHost('169.254.169.254'), true);
    assert.equal(isSensitiveOutboundHost('metadata.google.internal'), true);
    assert.equal(isSensitiveOutboundHost('192.168.1.10'), false);

    await assert.rejects(
        assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data', { role: 'admin' }),
        /sensitive local|metadata target/
    );
    await assert.rejects(
        assertSafeOutboundUrl('http://localhost:11434/v1', { role: 'admin' }),
        /sensitive local|metadata target/
    );
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

test('session detail only appends valid attachment tokens', async () => {
    const { createSessionsRouter } = require('../server/routes/sessions');
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`session_attach_${suffix}`, 'hash', 'Session Attachment Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const sessionId = `session-attach-${suffix}`;
    const activePath = `uploads/${userId}/${sessionId}/active.png`;
    const deletedPath = `uploads/${userId}/${sessionId}/deleted.png`;
    const expiredPath = `uploads/${userId}/${sessionId}/expired.png`;
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(sessionId, userId, 'Session Attachment Test');
    db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, created_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(
        sessionId,
        userId,
        'user',
        `![a](/${activePath}) ![d](/${deletedPath}) ![e](/${expiredPath})`
    );
    db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '+1 day'), datetime('now', '+8 hours'))
    `).run(userId, sessionId, 'active.png', activePath, 'image/png', 1, 'active-token');
    db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, deleted_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '+1 day'), datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, sessionId, 'deleted.png', deletedPath, 'image/png', 1, 'deleted-token');
    db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '-1 day'), datetime('now', '+8 hours'))
    `).run(userId, sessionId, 'expired.png', expiredPath, 'image/png', 1, 'expired-token');

    const router = createSessionsRouter({
        authMiddleware: (req, res, next) => {
            req.user = { id: userId, username: `session_attach_${suffix}`, role: 'user', status: 'active' };
            next();
        },
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/sessions/:id' && layer.route.methods.get);
    const req = { params: { id: sessionId }, query: {}, headers: {} };
    let payload = null;
    const res = {
        status() { return this; },
        json(data) {
            payload = data;
            return this;
        }
    };
    const handlers = route.route.stack.map(item => item.handle);

    try {
        await handlers[0](req, res, err => { if (err) throw err; });
        await new Promise((resolve, reject) => {
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                originalJson(data);
                resolve();
                return res;
            };
            handlers[1](req, res, reject);
        });
        const content = payload.messages[0].content;
        assert.match(content, /active\.png\?token=active-token/);
        assert.doesNotMatch(content, /deleted\.png\?token=deleted-token/);
        assert.doesNotMatch(content, /expired\.png\?token=expired-token/);
    } finally {
        db.prepare('DELETE FROM attachments WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
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
    assert.equal(contentContainsVisionInput('plain text without image'), false);
    assert.equal(messagesContainVisionInput([
        { role: 'user', content: [{ type: 'text', text: 'look at image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ]), true);
});

test('csrfMiddleware requires matching cookie and header for cookie writes', () => {
    let statusCode = 0;
    let body = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(value) {
            body = value;
            return this;
        }
    };

    csrfMiddleware({ method: 'POST', path: '/chat', headers: {}, socket: {} }, res, () => {
        throw new Error('CSRF should not pass without token');
    });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'CSRF 校验失败');

    let passed = false;
    csrfMiddleware({
        method: 'POST',
        path: '/chat',
        headers: {
            cookie: `${CSRF_COOKIE_NAME}=abc`,
            'x-csrf-token': 'abc'
        },
        socket: {}
    }, res, () => {
        passed = true;
    });
    assert.equal(passed, true);
});

test('RAG helpers build safe FTS queries and deterministic chunks', () => {
    assert.equal(buildFtsOrQuery(['hello', 'a"b']), '"hello" OR "a""b"');
    assert.ok(buildKeywordCandidates('权限配置流程').includes('权限'));
    assert.ok(buildRagSearchContent('权限配置流程').includes('权限'));
    assert.ok(buildRagSearchContent('权限配置流程').includes('配置'));
    assert.deepEqual(chunkText('abcdef', 4, 2), ['abcd', 'cdef', 'ef']);
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('RAG config clamps unsafe retrieval parameters', () => {
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.scoreThreshold, 1.5), '1');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.scoreThreshold, -1), '0');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.topK, 99), '10');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.candidateLimit, 1), '20');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.chunkSize, 99), '200');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.chunkOverlap, -1), '0');

    const config = getRagConfig({
        scoreThreshold: '0.7',
        topK: '5',
        candidateLimit: '3',
        chunkSize: '240',
        chunkOverlap: '999'
    });
    assert.deepEqual(config, {
        scoreThreshold: 0.7,
        topK: 5,
        candidateLimit: 20,
        chunkSize: 240,
        chunkOverlap: 120
    });
});

test('RAG embedding modes normalize legacy values to HTTP mode', () => {
    assert.equal(normalizeEmbeddingMode('cloud'), 'http');
    assert.equal(normalizeEmbeddingMode('local'), 'http');
    assert.equal(normalizeEmbeddingMode('http'), 'http');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.embeddingMode, 'cloud'), 'http');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.embeddingMode, 'local'), 'http');
});

test('RAG embedding config prefers stored settings and masks API key', () => {
    const previousEnv = {
        mode: process.env.EMBEDDING_MODE,
        url: process.env.EMBEDDING_API_URL,
        key: process.env.EMBEDDING_API_KEY,
        model: process.env.EMBEDDING_MODEL
    };
    process.env.EMBEDDING_MODE = 'cloud';
    process.env.EMBEDDING_API_URL = 'http://env.example/v1/embeddings';
    process.env.EMBEDDING_API_KEY = 'env-key';
    process.env.EMBEDDING_MODEL = 'env-model';

    const keys = [
        RAG_CONFIG_KEYS.embeddingMode,
        RAG_CONFIG_KEYS.embeddingApiUrl,
        RAG_CONFIG_KEYS.embeddingApiKey,
        RAG_CONFIG_KEYS.embeddingModel
    ];
    const previousRows = keys.map(key => db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key));
    const upsert = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, datetime('now', '+8 hours'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    try {
        upsert.run(RAG_CONFIG_KEYS.embeddingMode, 'cloud');
        upsert.run(RAG_CONFIG_KEYS.embeddingApiUrl, 'http://settings.example/v1/embeddings');
        upsert.run(RAG_CONFIG_KEYS.embeddingApiKey, toRagSettingValue(RAG_CONFIG_KEYS.embeddingApiKey, 'settings-key'));
        upsert.run(RAG_CONFIG_KEYS.embeddingModel, 'settings-model');

        const config = getEmbeddingConfig();
        assert.equal(config.mode, 'http');
        assert.equal(config.http.url, 'http://settings.example/v1/embeddings');
        assert.equal(config.http.apiKey, 'settings-key');
        assert.equal(config.http.model, 'settings-model');

        const publicConfig = getPublicEmbeddingConfig();
        assert.equal(publicConfig.mode, 'http');
        assert.equal(publicConfig.hasApiKey, true);
        assert.equal(publicConfig.apiUrl, 'http://settings.example/v1/embeddings');
        assert.equal(publicConfig.model, 'settings-model');
        assert.equal(Object.prototype.hasOwnProperty.call(publicConfig, 'apiKey'), false);
    } finally {
        keys.forEach((key, index) => {
            const row = previousRows[index];
            if (row) {
                db.prepare(`
                    INSERT INTO app_settings (key, value, updated_at, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at,
                        updated_by = excluded.updated_by
                `).run(row.key, row.value, row.updated_at, row.updated_by);
            } else {
                db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
            }
        });
        process.env.EMBEDDING_MODE = previousEnv.mode;
        process.env.EMBEDDING_API_URL = previousEnv.url;
        process.env.EMBEDDING_API_KEY = previousEnv.key;
        process.env.EMBEDDING_MODEL = previousEnv.model;
    }
});

test('RAG embedding config prefers user settings and falls back to system defaults', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_embed_${suffix}`, 'hash', 'RAG Embed Test', 'QA', 'user', 'active');

    const keys = [
        RAG_CONFIG_KEYS.embeddingMode,
        RAG_CONFIG_KEYS.embeddingApiUrl,
        RAG_CONFIG_KEYS.embeddingApiKey,
        RAG_CONFIG_KEYS.embeddingModel
    ];
    const previousRows = keys.map(key => db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key));
    const upsertSystem = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, datetime('now', '+8 hours'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const upsertUser = db.prepare(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'))
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    try {
        upsertSystem.run(RAG_CONFIG_KEYS.embeddingMode, 'http');
        upsertSystem.run(RAG_CONFIG_KEYS.embeddingApiUrl, 'https://system.example/v1');
        upsertSystem.run(RAG_CONFIG_KEYS.embeddingApiKey, toRagSettingValue(RAG_CONFIG_KEYS.embeddingApiKey, 'system-key'));
        upsertSystem.run(RAG_CONFIG_KEYS.embeddingModel, 'system-model');

        upsertUser.run(userInfo.lastInsertRowid, RAG_CONFIG_KEYS.embeddingMode, 'http');
        upsertUser.run(userInfo.lastInsertRowid, RAG_CONFIG_KEYS.embeddingApiUrl, 'https://user.example/v1');
        upsertUser.run(userInfo.lastInsertRowid, RAG_CONFIG_KEYS.embeddingApiKey, toRagSettingValue(RAG_CONFIG_KEYS.embeddingApiKey, 'user-key'));
        upsertUser.run(userInfo.lastInsertRowid, RAG_CONFIG_KEYS.embeddingModel, 'user-model');

        const personal = getEmbeddingConfig(userInfo.lastInsertRowid);
        assert.equal(personal.http.url, 'https://user.example/v1');
        assert.equal(personal.http.apiKey, 'user-key');
        assert.equal(personal.http.model, 'user-model');
        assert.equal(personal.source.url, 'user');

        const publicPersonal = getPublicEmbeddingConfig(userInfo.lastInsertRowid);
        assert.equal(publicPersonal.isPersonal, true);
        assert.equal(publicPersonal.hasApiKey, true);
        assert.equal(Object.prototype.hasOwnProperty.call(publicPersonal, 'apiKey'), false);

        db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userInfo.lastInsertRowid);
        const fallback = getEmbeddingConfig(userInfo.lastInsertRowid);
        assert.equal(fallback.http.url, 'https://system.example/v1');
        assert.equal(fallback.http.apiKey, 'system-key');
        assert.equal(fallback.http.model, 'system-model');
        assert.equal(fallback.source.url, 'settings');
    } finally {
        db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
        keys.forEach((key, index) => {
            const row = previousRows[index];
            if (row) {
                db.prepare(`
                    INSERT INTO app_settings (key, value, updated_at, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at,
                        updated_by = excluded.updated_by
                `).run(row.key, row.value, row.updated_at, row.updated_by);
            } else {
                db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
            }
        });
    }
});

test('RAG embedding helpers support HTTP services', () => {
    assert.equal(resolveEmbeddingUrl('http://127.0.0.1:11434/api/embed'), 'http://127.0.0.1:11434/api/embed');
    assert.equal(resolveEmbeddingUrl('https://example.com/v1'), 'https://example.com/v1/embeddings');
    assert.equal(resolveEmbeddingUrl('https://example.com'), 'https://example.com/v1/embeddings');

    assert.deepEqual(
        buildEmbeddingPayload('hello', 'bge-m3', 'http', 'http://127.0.0.1:11434/api/embed'),
        { model: 'bge-m3', input: 'hello' }
    );
    assert.deepEqual(
        buildEmbeddingPayload('hello', 'nomic-embed-text', 'http', 'http://127.0.0.1:11434/api/embeddings'),
        { model: 'nomic-embed-text', prompt: 'hello' }
    );
    assert.deepEqual(
        buildEmbeddingPayload('hello', 'text-embedding-3-small', 'http', 'http://127.0.0.1:8000/v1/embeddings'),
        { input: 'hello', model: 'text-embedding-3-small' }
    );

    assert.deepEqual(normalizeEmbeddingVector({ data: [{ embedding: [1, 2, 3] }] }), [1, 2, 3]);
    assert.deepEqual(normalizeEmbeddingVector({ embedding: ['1', 2] }), [1, 2]);
    assert.deepEqual(normalizeEmbeddingVector({ embeddings: [[0.1, 0.2]] }), [0.1, 0.2]);
    assert.throws(() => normalizeEmbeddingVector({ ok: true }), /有效向量/);
});

test('OpenAI embedding helpers normalize requests and responses', () => {
    assert.deepEqual(normalizeEmbeddingInputs('hello'), ['hello']);
    assert.deepEqual(normalizeEmbeddingInputs(['hello', 'world']), ['hello', 'world']);
    assert.deepEqual(normalizeEmbeddingInputs([[1, 2, 3]]), ['1 2 3']);
    assert.throws(() => normalizeEmbeddingInputs(''), /empty string/);
    assert.throws(() => normalizeEmbeddingInputs([{}]), /input must/);

    const response = buildEmbeddingResponse({
        vectors: [[0.1, 0.2], [0.3, 0.4]],
        model: 'bge-m3',
        promptTokens: 6
    });
    assert.equal(response.object, 'list');
    assert.equal(response.model, 'bge-m3');
    assert.equal(response.data[1].object, 'embedding');
    assert.deepEqual(response.data[1].embedding, [0.3, 0.4]);
    assert.deepEqual(response.usage, { prompt_tokens: 6, total_tokens: 6 });

    const modelItem = buildEmbeddingModelItem({
        http: { url: 'https://embedding.example/v1', model: 'bge-m3' },
        source: { url: 'settings', model: 'settings' }
    });
    assert.equal(modelItem.id, 'bge-m3');
    assert.deepEqual(modelItem.capabilities, ['embeddings']);
});

test('RAG embedding model discovery supports OpenAI and Ollama-style endpoints', () => {
    assert.deepEqual(
        buildEmbeddingModelListUrls('https://example.com/v1'),
        ['https://example.com/v1/models']
    );
    assert.deepEqual(
        buildEmbeddingModelListUrls('http://127.0.0.1:11434/api/embed'),
        ['http://127.0.0.1:11434/api/tags']
    );
    assert.deepEqual(
        buildEmbeddingModelListUrls('http://127.0.0.1:11434'),
        [
            'http://127.0.0.1:11434/v1/models',
            'http://127.0.0.1:11434/models',
            'http://127.0.0.1:11434/api/tags'
        ]
    );

    assert.deepEqual(
        extractEmbeddingModelIds({ data: [{ id: 'text-embedding-3-small' }, { id: 'bge-m3' }] }),
        ['text-embedding-3-small', 'bge-m3']
    );
    assert.deepEqual(
        extractEmbeddingModelIds({ models: [{ name: 'nomic-embed-text' }, 'bge-large'] }),
        ['nomic-embed-text', 'bge-large']
    );
});

test('RAG FTS indexes generated Chinese ngram tokens', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_fts_${suffix}`, 'hash', 'RAG FTS Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, created_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_fts_${suffix}.txt`, 'ready');
    const content = '权限配置流程说明';
    const chunkInfo = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `).run(docInfo.lastInsertRowid, content, buildRagSearchContent(content), JSON.stringify([1, 0]));

    try {
        const row = db.prepare(`
            SELECT c.id
            FROM knowledge_chunks_fts
            JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.rowid
            WHERE knowledge_chunks_fts MATCH ? AND c.id = ?
        `).get(buildFtsOrQuery(['权限']), chunkInfo.lastInsertRowid);
        assert.equal(row.id, chunkInfo.lastInsertRowid);
    } finally {
        db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('knowledge_docs supports indexing status metadata', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_status_${suffix}`, 'hash', 'RAG Status Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_status_${suffix}.txt`, 'processing', 0, '');

    try {
        db.prepare(`
            UPDATE knowledge_docs
            SET status = ?, chunk_count = ?, error_message = ?, processed_at = ?, updated_at = ?
            WHERE id = ?
        `).run('ready', 3, '', '2099-01-01 00:00:00', '2099-01-01 00:00:00', docInfo.lastInsertRowid);
        const ready = db.prepare('SELECT status, chunk_count, error_message, processed_at, updated_at FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.deepEqual(ready, {
            status: 'ready',
            chunk_count: 3,
            error_message: '',
            processed_at: '2099-01-01 00:00:00',
            updated_at: '2099-01-01 00:00:00'
        });

        db.prepare('UPDATE knowledge_docs SET status = ?, error_message = ? WHERE id = ?')
            .run('error', 'embedding failed', docInfo.lastInsertRowid);
        const failed = db.prepare('SELECT status, error_message FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.deepEqual(failed, { status: 'error', error_message: 'embedding failed' });
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('knowledge_docs supports enablement progress and feedback metadata', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_meta_${suffix}`, 'hash', 'RAG Meta Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, indexed_chunks, progress, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_meta_${suffix}.txt`, 'ready', 0, 2, 2, 100);
    const chunkInfo = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `).run(docInfo.lastInsertRowid, 'RAG feedback chunk', 'RAG feedback chunk', JSON.stringify([1, 0]));

    try {
        const detail = getKnowledgeDocumentDetail({
            docId: docInfo.lastInsertRowid,
            userId: userInfo.lastInsertRowid
        });
        assert.equal(detail.doc.is_enabled, 0);
        assert.equal(detail.doc.progress, 100);
        assert.equal(detail.totalChunks, 1);
        assert.equal(detail.chunks[0].id, chunkInfo.lastInsertRowid);

        const feedback = recordRagFeedback({
            userId: userInfo.lastInsertRowid,
            query: 'RAG feedback',
            chunkId: chunkInfo.lastInsertRowid,
            docName: `rag_meta_${suffix}.txt`,
            score: 0.88,
            helpful: false,
            note: 'not enough detail'
        });
        assert.ok(feedback.id > 0);
        const summary = getRagFeedbackSummary(userInfo.lastInsertRowid);
        assert.equal(summary.unhelpful, 1);
        assert.equal(summary.byDoc[0].unhelpful, 1);
    } finally {
        db.prepare('DELETE FROM rag_feedback WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG document source path is constrained to knowledge_docs uploads', () => {
    const expected = path.resolve(uploadRoot, 'knowledge_docs', '1', '2.txt');
    assert.equal(getKnowledgeSourcePath('uploads/knowledge_docs/1/2.txt'), expected);
    assert.equal(getKnowledgeSourcePath('uploads/docs/legacy.txt'), null);
    assert.equal(getKnowledgeSourcePath('uploads/knowledge_docs/../secret.txt'), null);
    assert.equal(getKnowledgeSourcePath('uploads/knowledge_docs/%2e%2e/secret.txt'), null);
});

test('RAG document deletion is soft and remains auditable', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_delete_${suffix}`, 'hash', 'RAG Delete Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, indexed_chunks, source_path, source_size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(
        userInfo.lastInsertRowid,
        `rag_delete_${suffix}.txt`,
        'ready',
        1,
        1,
        1,
        `uploads/knowledge_docs/${userInfo.lastInsertRowid}/${suffix}.txt`,
        128
    );
    const chunkInfo = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `).run(docInfo.lastInsertRowid, 'soft delete audit chunk', 'soft delete audit chunk', JSON.stringify([1, 0]));

    try {
        assert.equal(deleteKnowledgeDocument({ docId: docInfo.lastInsertRowid, userId: userInfo.lastInsertRowid }), true);
        const doc = db.prepare('SELECT deleted_at, deleted_by_user, is_enabled FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.ok(doc.deleted_at);
        assert.equal(doc.deleted_by_user, userInfo.lastInsertRowid);
        assert.equal(doc.is_enabled, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE doc_id = ?').get(docInfo.lastInsertRowid).count, 1);
        assert.equal(getKnowledgeDocumentSummaryForUser(userInfo.lastInsertRowid).total, 0);

        const audit = getKnowledgeDocumentAuditList({ limit: 20 });
        const row = audit.data.find(item => item.id === docInfo.lastInsertRowid);
        assert.ok(row);
        assert.equal(row.username, `rag_delete_${suffix}`);
        assert.equal(row.name, `rag_delete_${suffix}.txt`);
        assert.ok(row.source_path.includes('/knowledge_docs/'));
    } finally {
        db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run(chunkInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('soft-deleted storage cleanup purges expired files and RAG chunks', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`storage_gc_${suffix}`, 'hash', 'Storage GC Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const gcDir = path.join(uploadRoot, 'gc-test', String(userId));
    fs.mkdirSync(gcDir, { recursive: true });

    const attachmentPath = path.join(gcDir, 'old-attachment.txt');
    const knowledgePath = path.join(uploadRoot, 'knowledge_docs', String(userId), `old-doc-${suffix}.txt`);
    fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
    fs.writeFileSync(attachmentPath, 'old attachment');
    fs.writeFileSync(knowledgePath, 'old knowledge');

    const attachmentRel = toProjectRelativePath(attachmentPath);
    const knowledgeRel = toProjectRelativePath(knowledgePath);
    const attachmentInfo = db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, deleted_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '-40 days'), datetime('now', '+8 hours', '-45 days'))
    `).run(userId, null, 'old-attachment.txt', attachmentRel, 'text/plain', 14, 'old-token');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, indexed_chunks, source_path, source_size, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '-40 days'), datetime('now', '+8 hours', '-45 days'), datetime('now', '+8 hours', '-40 days'))
    `).run(userId, `old-doc-${suffix}.txt`, 'ready', 0, 1, 1, knowledgeRel, 13);
    const chunkInfo = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `).run(docInfo.lastInsertRowid, 'expired storage gc chunk', 'expired storage gc chunk', JSON.stringify([1, 0]));

    try {
        assert.equal(fs.existsSync(attachmentPath), true);
        assert.equal(fs.existsSync(knowledgePath), true);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks_fts WHERE rowid = ?').get(chunkInfo.lastInsertRowid).count, 1);

        const result = cleanupSoftDeletedStorage({ retentionDays: 30, limit: 10 });
        assert.equal(result.attachmentRows, 1);
        assert.equal(result.knowledgeDocRows, 1);
        assert.equal(fs.existsSync(attachmentPath), false);
        assert.equal(fs.existsSync(knowledgePath), false);

        const attachment = db.prepare('SELECT file_path, file_size, access_token, expires_at FROM attachments WHERE id = ?')
            .get(attachmentInfo.lastInsertRowid);
        assert.equal(attachment.file_path, '');
        assert.equal(attachment.file_size, 0);
        assert.equal(attachment.access_token, null);
        assert.equal(attachment.expires_at, null);

        const doc = db.prepare('SELECT status, source_path, source_size, chunk_count, indexed_chunks FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.equal(doc.status, 'purged');
        assert.equal(doc.source_path, '');
        assert.equal(doc.source_size, 0);
        assert.equal(doc.chunk_count, 0);
        assert.equal(doc.indexed_chunks, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE doc_id = ?').get(docInfo.lastInsertRowid).count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks_fts WHERE rowid = ?').get(chunkInfo.lastInsertRowid).count, 0);
    } finally {
        db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        fs.rmSync(path.join(uploadRoot, 'gc-test', String(userId)), { recursive: true, force: true });
        fs.rmSync(path.join(uploadRoot, 'knowledge_docs', String(userId)), { recursive: true, force: true });
    }
});

test('soft-deleted storage cleanup purges expired messages and message FTS rows', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`message_gc_${suffix}`, 'hash', 'Message GC Test', 'QA', 'user', 'active');
    const sessionId = `message-gc-${suffix}`;
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours', '-40 days'), datetime('now', '+8 hours', '-45 days'), datetime('now', '+8 hours', '-40 days'))
    `).run(sessionId, userInfo.lastInsertRowid, 'Message GC');
    const messageInfo = db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, deleted_at, created_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours', '-40 days'), datetime('now', '+8 hours', '-45 days'))
    `).run(sessionId, userInfo.lastInsertRowid, 'user', `expired message gc ${suffix}`);

    try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE rowid = ?').get(messageInfo.lastInsertRowid).count, 1);
        const result = cleanupSoftDeletedStorage({ retentionDays: 30, limit: 10 });
        assert.equal(result.messageRows, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get(messageInfo.lastInsertRowid).count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE rowid = ?').get(messageInfo.lastInsertRowid).count, 0);
    } finally {
        db.prepare('DELETE FROM messages WHERE id = ?').run(messageInfo.lastInsertRowid);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('soft-deleted storage cleanup keeps files within retention window', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`storage_gc_keep_${suffix}`, 'hash', 'Storage GC Keep Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const gcDir = path.join(uploadRoot, 'gc-test', String(userId));
    fs.mkdirSync(gcDir, { recursive: true });
    const attachmentPath = path.join(gcDir, 'recent-attachment.txt');
    fs.writeFileSync(attachmentPath, 'recent attachment');
    const attachmentInfo = db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, deleted_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '-2 days'), datetime('now', '+8 hours', '-3 days'))
    `).run(userId, null, 'recent-attachment.txt', toProjectRelativePath(attachmentPath), 'text/plain', 17);

    try {
        const result = cleanupSoftDeletedStorage({ retentionDays: 30, limit: 10 });
        assert.equal(result.attachmentRows, 0);
        assert.equal(fs.existsSync(attachmentPath), true);
        const attachment = db.prepare('SELECT file_path FROM attachments WHERE id = ?').get(attachmentInfo.lastInsertRowid);
        assert.ok(attachment.file_path);
    } finally {
        db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        fs.rmSync(path.join(uploadRoot, 'gc-test', String(userId)), { recursive: true, force: true });
    }
});

test('RAG reindex marks legacy documents without source files as errors', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_reindex_${suffix}`, 'hash', 'RAG Reindex Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_reindex_${suffix}.txt`, 'ready', 1, '');

    try {
        await assert.rejects(
            processKnowledgeDocument({ docId: docInfo.lastInsertRowid, userId: userInfo.lastInsertRowid }),
            /原始文件不存在|source/i
        );
        const row = db.prepare('SELECT status, error_message FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.equal(row.status, 'error');
        assert.match(row.error_message, /原始文件不存在|source/i);
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG recovery marks interrupted processing docs without sources as errors', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_recover_${suffix}`, 'hash', 'RAG Recovery Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_recover_${suffix}.txt`, 'processing', 0, '');

    try {
        const result = recoverStaleKnowledgeDocumentIndexes({ limit: 10 });
        assert.ok(result.total >= 1);
        assert.ok(result.failed >= 1);
        const row = db.prepare('SELECT status, error_message FROM knowledge_docs WHERE id = ?')
            .get(docInfo.lastInsertRowid);
        assert.equal(row.status, 'error');
        assert.match(row.error_message, /原始文件缺失|重新上传/);
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG summary counts docs and schedules retryable failed documents', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_summary_${suffix}`, 'hash', 'RAG Summary Test', 'QA', 'user', 'active');
    const readyDoc = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, source_size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_summary_ready_${suffix}.txt`, 'ready', 4, 1234);
    const failedDoc = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, source_path, source_size, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(
        userInfo.lastInsertRowid,
        `rag_summary_failed_${suffix}.txt`,
        'error',
        0,
        `uploads/knowledge_docs/${userInfo.lastInsertRowid}/missing-${suffix}.txt`,
        42,
        'embedding failed'
    );

    try {
        const summary = getKnowledgeDocumentSummaryForUser(userInfo.lastInsertRowid);
        assert.equal(summary.total, 2);
        assert.equal(summary.ready, 1);
        assert.equal(summary.error, 1);
        assert.equal(summary.chunks, 4);
        assert.equal(summary.sourceSize, 1276);
        assert.equal(summary.retryableErrors, 1);
        assert.equal(summary.lastError.id, failedDoc.lastInsertRowid);

        const retry = scheduleFailedKnowledgeDocumentsForUser({ userId: userInfo.lastInsertRowid, limit: 10 });
        assert.deepEqual(retry, { total: 1, scheduled: 1, alreadyProcessing: 0 });
        const queuedAgain = scheduleFailedKnowledgeDocumentsForUser({ userId: userInfo.lastInsertRowid, limit: 10 });
        assert.deepEqual(queuedAgain, { total: 1, scheduled: 0, alreadyProcessing: 1 });
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE id IN (?, ?)').run(readyDoc.lastInsertRowid, failedDoc.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG debug retrieval returns scored chunks without external embeddings', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_debug_${suffix}`, 'hash', 'RAG Debug Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_debug_${suffix}.txt`, 'ready', 2);
    const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `);
    const matchedContent = '权限配置流程需要管理员审批，并记录审计日志';
    const otherContent = '季度销售报表包含收入、成本和利润分析';
    const matched = insertChunk.run(
        docInfo.lastInsertRowid,
        matchedContent,
        buildRagSearchContent(matchedContent),
        JSON.stringify([1, 0])
    );
    const other = insertChunk.run(
        docInfo.lastInsertRowid,
        otherContent,
        buildRagSearchContent(otherContent),
        JSON.stringify([0, 1])
    );

    try {
        const result = await debugRetrieveContext(
            userInfo.lastInsertRowid,
            '权限配置审批',
            { queryVector: [1, 0], topK: 2, candidateLimit: 5, scoreThreshold: 0.95 }
        );
        assert.equal(result.query, '权限配置审批');
        assert.ok(result.keywords.length > 0);
        assert.equal(result.matches[0].chunkId, matched.lastInsertRowid);
        assert.equal(result.matches[0].score, 1);
        assert.equal(result.matches[0].matched, true);
        assert.match(result.injectedContext, /权限配置流程/);

        const strictResult = await debugRetrieveContext(
            userInfo.lastInsertRowid,
            '权限配置审批',
            { queryVector: [1, 0], topK: 2, candidateLimit: 5, scoreThreshold: 1 }
        );
        assert.equal(strictResult.matches[0].matched, false);
    } finally {
        db.prepare('DELETE FROM knowledge_chunks WHERE id IN (?, ?)').run(matched.lastInsertRowid, other.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
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
    process.env.PIVOT_LOCAL_MODEL_HOSTS = '203.0.113.10,llama-server:8080';
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
    } finally {
        if (previousAliases === undefined) {
            delete process.env.PIVOT_LOCAL_MODEL_HOSTS;
        } else {
            process.env.PIVOT_LOCAL_MODEL_HOSTS = previousAliases;
        }
    }
});

test('docker internal service names are local only when container trust is enabled', () => {
    const previousTrust = process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS;
    try {
        process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS = 'true';
        assert.equal(isDockerInternalServiceHost('llama-server'), true);
        assert.equal(isDockerInternalServiceHost('llama-server:8080'), true);
        assert.equal(isDockerInternalServiceHost('api.internal'), false);
        assert.equal(isDockerInternalServiceHost('10.0.0.8'), false);
        assert.equal(isLocalModelHost('llama-server', new Set()), true);

        process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS = 'false';
        assert.equal(isDockerInternalServiceHost('llama-server'), false);
        assert.equal(isLocalModelHost('llama-server', new Set()), false);
    } finally {
        if (previousTrust === undefined) {
            delete process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS;
        } else {
            process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS = previousTrust;
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

test('admin password reset revokes target refresh tokens', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`admin_reset_${suffix}`, 'old-hash', 'Admin Reset Test', 'QA', 'user', 'active');
    db.prepare(`
        INSERT INTO refresh_tokens (user_id, token, expires_at, created_at)
        VALUES (?, ?, datetime('now', '+8 hours', '+7 days'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `admin-reset-refresh-${suffix}`);

    const router = createAdminUsersRouter({
        authMiddleware: (req, res, next) => {
            req.user = { id: 1, username: 'admin', role: 'admin' };
            next();
        },
        adminMiddleware: (req, res, next) => next(),
        upload: { single: () => (req, res, next) => next() },
        logAction: () => {}
    });
    const passwordRoute = router.stack.find(layer => layer.route?.path === '/admin/users/:id/password');
    assert.ok(passwordRoute);
    const req = {
        params: { id: String(userInfo.lastInsertRowid) },
        body: { password: 'NewPassword123' }
    };
    let statusCode = 200;
    let payload = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(data) {
            payload = data;
            return this;
        }
    };
    const handlers = passwordRoute.route.stack.map(item => item.handle);

    try {
        await handlers[0](req, res, err => { if (err) throw err; });
        await handlers[1](req, res, err => { if (err) throw err; });
        await new Promise((resolve, reject) => {
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                originalJson(data);
                resolve();
                return res;
            };
            handlers[2](req, res, reject);
        });
        assert.equal(statusCode, 200);
        assert.equal(payload.success, true);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM refresh_tokens WHERE user_id = ?').get(userInfo.lastInsertRowid).count, 0);
        assert.notEqual(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userInfo.lastInsertRowid).password_hash, 'old-hash');
    } finally {
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('model probe routes authenticate before rate limiting', () => {
    const router = createModelsRouter({
        authMiddleware: (req, res, next) => next(),
        probeLimiter: (req, res, next) => next(),
        logAction: () => {},
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100)
    });
    for (const pathName of ['/models/fetch-remote', '/models/test']) {
        const route = router.stack.find(layer => layer.route?.path === pathName);
        assert.ok(route, `${pathName} route should exist`);
        const handlers = route.route.stack.map(item => item.handle);
        assert.equal(handlers[0].name, 'authMiddleware');
        assert.equal(handlers[1].name, 'probeLimiter');
    }
});

test('OpenAI embedding route authenticates before rate limiting', () => {
    const router = createOpenAIRouter({
        authMiddleware: (req, res, next) => next(),
        embeddingLimiter: (req, res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/embeddings');
    assert.ok(route);
    const handlers = route.route.stack.map(item => item.handle);
    assert.equal(handlers[0].name, 'authMiddleware');
    assert.equal(handlers[1].name, 'embeddingLimiter');
});

test('available models route includes configured embedding model', async () => {
    const router = createModelsRouter({
        authMiddleware: (req, res, next) => {
            req.user = { id: 1, username: 'admin', role: 'admin' };
            next();
        },
        probeLimiter: (req, res, next) => next(),
        logAction: () => {},
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100)
    });
    const route = router.stack.find(layer => layer.route?.path === '/models/available');
    assert.ok(route);

    const keys = [
        RAG_CONFIG_KEYS.embeddingMode,
        RAG_CONFIG_KEYS.embeddingApiUrl,
        RAG_CONFIG_KEYS.embeddingModel
    ];
    const previousRows = keys.map(key => db.prepare('SELECT * FROM app_settings WHERE key = ?').get(key));
    const upsert = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, datetime('now', '+8 hours'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    upsert.run(RAG_CONFIG_KEYS.embeddingMode, 'http');
    upsert.run(RAG_CONFIG_KEYS.embeddingApiUrl, 'https://embedding.example/v1');
    upsert.run(RAG_CONFIG_KEYS.embeddingModel, 'bge-m3');

    try {
        const handlers = route.route.stack.map(item => item.handle);
        const req = {};
        let payload = null;
        const res = {
            json(data) {
                payload = data;
                return this;
            }
        };
        await handlers[0](req, res, err => { if (err) throw err; });
        await new Promise((resolve, reject) => {
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                originalJson(data);
                resolve();
                return res;
            };
            handlers[1](req, res, reject);
        });
        assert.ok(Array.isArray(payload));
        const embedding = payload.find(model => model.type === 'embedding' && model.model_name === 'bge-m3');
        assert.ok(embedding);
        assert.equal(embedding.endpoint, '/v1/embeddings');
        assert.deepEqual(embedding.capabilities, ['embeddings']);
    } finally {
        keys.forEach((key, index) => {
            const row = previousRows[index];
            if (row) {
                db.prepare(`
                    INSERT INTO app_settings (key, value, updated_at, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at,
                        updated_by = excluded.updated_by
                `).run(row.key, row.value, row.updated_at, row.updated_by);
            } else {
                db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
            }
        });
    }
});

function buildSingleEntryZip({ name, data, declaredUncompressedSize = data.length }) {
    const compressed = zlib.deflateRawSync(data);
    const nameBuffer = Buffer.from(name);
    const local = Buffer.alloc(30 + nameBuffer.length + compressed.length);
    let offset = 0;
    local.writeUInt32LE(0x04034b50, offset); offset += 4;
    local.writeUInt16LE(20, offset); offset += 2;
    local.writeUInt16LE(0, offset); offset += 2;
    local.writeUInt16LE(8, offset); offset += 2;
    local.writeUInt16LE(0, offset); offset += 2;
    local.writeUInt16LE(0, offset); offset += 2;
    local.writeUInt32LE(0, offset); offset += 4;
    local.writeUInt32LE(compressed.length, offset); offset += 4;
    local.writeUInt32LE(declaredUncompressedSize, offset); offset += 4;
    local.writeUInt16LE(nameBuffer.length, offset); offset += 2;
    local.writeUInt16LE(0, offset); offset += 2;
    nameBuffer.copy(local, offset); offset += nameBuffer.length;
    compressed.copy(local, offset);

    const central = Buffer.alloc(46 + nameBuffer.length);
    offset = 0;
    central.writeUInt32LE(0x02014b50, offset); offset += 4;
    central.writeUInt16LE(20, offset); offset += 2;
    central.writeUInt16LE(20, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(8, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt32LE(0, offset); offset += 4;
    central.writeUInt32LE(compressed.length, offset); offset += 4;
    central.writeUInt32LE(declaredUncompressedSize, offset); offset += 4;
    central.writeUInt16LE(nameBuffer.length, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt32LE(0, offset); offset += 4;
    central.writeUInt32LE(0, offset); offset += 4;
    nameBuffer.copy(central, offset);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(local.length, 16);

    return Buffer.concat([local, central, eocd]);
}

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
