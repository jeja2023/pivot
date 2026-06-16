// 从 security-rag.test.js 拆出；仍由父级入口统一加载。
const {
    MEMORY_CONFIG_KEYS,
    RAG_CONFIG_KEYS,
    assert,
    buildEmbeddingModelItem,
    buildEmbeddingModelListUrls,
    buildEmbeddingPayload,
    buildEmbeddingResponse,
    buildFtsOrQuery,
    buildRagSearchContent,
    createSettingsRouter,
    db,
    extractEmbeddingModelIds,
    getEmbeddingConfig,
    getApiAccessSetting,
    getPublicEmbeddingConfig,
    indexDocumentChunks,
    normalizeEmbeddingInputs,
    normalizeEmbeddingVector,
    requestEmbedding,
    resolveEmbeddingUrl,
    runExpressHandlers,
    test,
    setApiAccessSetting,
    toRagSettingValue
} = require('../security-helpers');

test('RAG 嵌入配置优先使用已存设置并遮蔽 API key', () => {
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

test('RAG 嵌入配置优先使用用户设置并回退到系统默认值', () => {
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

test('非 root 管理员会把嵌入配置保存为个人设置', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`ops_admin_${suffix}`, 'hash', 'Ops Admin', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `ops_admin_${suffix}`, role: 'admin', unit: 'QA' };

    const keys = [
        RAG_CONFIG_KEYS.embeddingMode,
        RAG_CONFIG_KEYS.embeddingApiUrl,
        RAG_CONFIG_KEYS.embeddingApiKey,
        RAG_CONFIG_KEYS.embeddingModel
    ];
    const previousRows = keys.map(key => db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key));
    const router = createSettingsRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const embeddingRoute = router.stack.find(layer => layer.route?.path === '/settings/embedding' && layer.route?.methods?.put);
    const adminSettingsRoute = router.stack.find(layer => layer.route?.path === '/admin/settings' && layer.route?.methods?.put);
    const req = {
        body: {
            rag_embedding_mode: 'http',
            rag_embedding_api_url: 'https://personal-admin.example/v1',
            rag_embedding_model: 'personal-admin-model'
        },
        user: adminUser
    };
    const jsonBodies = [];
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { jsonBodies.push(body); return this; }
    };

    try {
        await runExpressHandlers(embeddingRoute.route.stack.map(layer => layer.handle), req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(getEmbeddingConfig(adminUser.id).http.url, 'https://personal-admin.example/v1');
        assert.equal(getEmbeddingConfig(adminUser.id).http.model, 'personal-admin-model');
        assert.equal(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(RAG_CONFIG_KEYS.embeddingApiUrl)?.value === 'https://personal-admin.example/v1', false);

        const deniedReq = { body: { rag_embedding_api_url: 'https://global-denied.example/v1' }, user: adminUser };
        const deniedRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(adminSettingsRoute.route.stack.map(layer => layer.handle), deniedReq, deniedRes);
        assert.equal(deniedRes.statusCode, 403);
    } finally {
        db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(adminUser.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
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

test('管理员无需 root 系统设置权限也可更新记忆阈值', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`memory_admin_${suffix}`, 'hash', 'Memory Admin', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `memory_admin_${suffix}`, role: 'admin', unit: 'QA' };
    const key = MEMORY_CONFIG_KEYS.threshold;
    const previousRow = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key);
    const router = createSettingsRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const memoryRoute = router.stack.find(layer => layer.route?.path === '/admin/settings/memory' && layer.route?.methods?.put);
    const req = { body: { memory_threshold: '32K' }, user: adminUser };
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    try {
        await runExpressHandlers(memoryRoute.route.stack.map(layer => layer.handle), req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.memoryConfig.thresholdTokens, 32000);
        assert.equal(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key).value, '32000');
    } finally {
        if (previousRow) {
            db.prepare(`
                INSERT INTO app_settings (key, value, updated_at, updated_by)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by
            `).run(previousRow.key, previousRow.value, previousRow.updated_at, previousRow.updated_by);
        } else {
            db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
    }
});

test('RAG 嵌入辅助函数支持 HTTP 服务', () => {
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

test('RAG 嵌入请求会暴露友好的超时错误', async () => {
    const axios = require('axios');
    const originalPost = axios.post;
    let seenTimeout = 0;
    axios.post = async (_url, _payload, options = {}) => {
        seenTimeout = options.timeout;
        const error = new Error(`timeout of ${options.timeout}ms exceeded`);
        error.code = 'ECONNABORTED';
        throw error;
    };

    try {
        let caught = null;
        try {
            await requestEmbedding('hello', {
                url: 'https://embedding.example/v1',
                model: 'embedding-test',
                apiKey: ''
            }, { timeoutMs: 45000 });
        } catch (e) {
            caught = e;
        }
        assert.equal(seenTimeout, 45000);
        assert.equal(caught?.code, 'EMBEDDING_TIMEOUT');
        assert.match(caught?.message || '', /检索配置/);
    } finally {
        axios.post = originalPost;
    }
});

test('RAG 文档索引使用更长嵌入超时和批量调用', async () => {
    const axios = require('axios');
    const originalPost = axios.post;
    const suffix = Date.now().toString(36);
    const keys = [
        RAG_CONFIG_KEYS.embeddingMode,
        RAG_CONFIG_KEYS.embeddingApiUrl,
        RAG_CONFIG_KEYS.embeddingModel
    ];
    const previousRows = keys.map(key => db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key));
    const upsert = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, datetime('now', '+8 hours'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_index_timeout_${suffix}`, 'hash', 'RAG Index Timeout', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_index_timeout_${suffix}.txt`, 'processing', 0);
    const seen = [];

    axios.post = async (_url, payload, options = {}) => {
        seen.push({ payload, timeout: options.timeout });
        const rawInput = payload.input ?? payload.prompt;
        const inputs = Array.isArray(rawInput) ? rawInput : [rawInput];
        return {
            data: {
                data: inputs.map((_, index) => ({
                    index,
                    embedding: [1, index + 1]
                }))
            }
        };
    };

    try {
        upsert.run(RAG_CONFIG_KEYS.embeddingMode, 'http');
        upsert.run(RAG_CONFIG_KEYS.embeddingApiUrl, 'https://embedding.example/v1');
        upsert.run(RAG_CONFIG_KEYS.embeddingModel, 'batch-embedding');

        const chunkCount = await indexDocumentChunks(
            docInfo.lastInsertRowid,
            'alpha beta gamma '.repeat(80),
            { embeddingTimeoutMs: 65432 }
        );

        assert.equal(chunkCount > 1, true);
        assert.equal(seen.every(call => call.timeout === 65432), true);
        assert.equal(seen.some(call => Array.isArray(call.payload.input)), true);
    } finally {
        axios.post = originalPost;
        db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
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

test('OpenAI 嵌入辅助函数会规范化请求和响应', () => {
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

test('RAG 嵌入模型发现支持 OpenAI 和 Ollama 风格端点', () => {
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

test('RAG FTS 会索引生成的中文 ngram 词元', () => {
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

test('api access setting can be read and updated by admin settings', async () => {
    const suffix = Date.now().toString(36);
    const adminUser = db.prepare('SELECT id, username, role, unit FROM users WHERE username = ?').get('admin');
    const previousRow = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get('api_access_enabled');
    const previousValue = getApiAccessSetting();
    const router = createSettingsRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const settingsRoute = router.stack.find(layer => layer.route?.path === '/settings' && layer.route?.methods?.get);
    const adminSettingsRoute = router.stack.find(layer => layer.route?.path === '/admin/settings' && layer.route?.methods?.put);

    try {
        setApiAccessSetting(false, adminUser.id);

        const readRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(settingsRoute.route.stack.map(layer => layer.handle), { headers: {}, user: adminUser }, readRes);
        assert.equal(readRes.body.apiAccessEnabled, false);

        const writeRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(adminSettingsRoute.route.stack.map(layer => layer.handle), {
            body: { api_access_enabled: true },
            user: adminUser
        }, writeRes);
        assert.equal(writeRes.statusCode, 200);
        assert.equal(writeRes.body.apiAccessEnabled, true);
        assert.equal(getApiAccessSetting(), true);
    } finally {
        if (previousRow) {
            db.prepare(`
                INSERT INTO app_settings (key, value, updated_at, updated_by)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by
            `).run(previousRow.key, previousRow.value, previousRow.updated_at, previousRow.updated_by);
        } else {
            db.prepare('DELETE FROM app_settings WHERE key = ?').run('api_access_enabled');
        }
        assert.equal(getApiAccessSetting(), previousValue);
    }
});
