// 从 security-rag.test.js 拆出；仍由父级入口统一加载。
const {
    RAG_CONFIG_KEYS,
    assert,
    createModelsRouter,
    createOpenAIRouter,
    db,
    estimateEmbeddingTokens,
    estimateTokens,
    getKnowledgeDocumentSummaryForUser,
    getOrCreateEmbeddingUsageModel,
    indexDocumentChunks,
    normalizeTokenUsage,
    recordModelTokenUsage,
    test
} = require('../security-helpers');
const { buildRagCacheScope } = require('../../server/services/rag-index');
const { getKnowledgeQualityReport } = require('../../server/services/rag-documents');

test('RAG 索引会拒绝空文档，而不是标记为就绪', async () => {
    await assert.rejects(
        indexDocumentChunks(999999, '   \n\n\t', { userId: 1 }),
        /未解析出可索引文本/
    );
});

test('RAG 索引在向量服务失败时保留关键词分片', async () => {
    const axios = require('axios');
    const originalPost = axios.post;
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_keyword_index_${suffix}`, 'hash', 'RAG Keyword Index', 'QA', 'admin', 'active');
    const userId = userInfo.lastInsertRowid;
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, `rag_keyword_index_${suffix}.txt`, 'processing', 0);
    const upsertUserSetting = db.prepare(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'))
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    axios.post = async () => {
        const error = new Error('Request failed with status code 401');
        error.response = { status: 401 };
        throw error;
    };

    try {
        upsertUserSetting.run(userId, RAG_CONFIG_KEYS.embeddingMode, 'http');
        upsertUserSetting.run(userId, RAG_CONFIG_KEYS.embeddingApiUrl, 'http://127.0.0.1:9/v1');
        upsertUserSetting.run(userId, RAG_CONFIG_KEYS.embeddingModel, 'broken-embedding');

        const chunkCount = await indexDocumentChunks(
            docInfo.lastInsertRowid,
            '关键词兜底索引内容。'.repeat(80),
            { userId, user: { id: userId, role: 'admin', unit: 'QA' } }
        );
        const stored = db.prepare(`
            SELECT COUNT(*) AS total, SUM(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END) AS keywordOnly
            FROM knowledge_chunks
            WHERE doc_id = ?
        `).get(docInfo.lastInsertRowid);
        assert.equal(chunkCount > 0, true);
        assert.equal(stored.total, chunkCount);
        assert.equal(stored.keywordOnly, chunkCount);
    } finally {
        axios.post = originalPost;
        db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('RAG 汇总会返回个人检索配置', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_personal_${suffix}`, 'hash', 'RAG Personal Test', 'QA', 'user', 'active');
    db.prepare(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, RAG_CONFIG_KEYS.topK, '7');

    try {
        const summary = getKnowledgeDocumentSummaryForUser(userInfo.lastInsertRowid);
        assert.equal(summary.config.topK, 7);
    } finally {
        db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('令牌统计会平衡总量并跟踪嵌入用量模型', () => {
    assert.deepEqual(normalizeTokenUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 20 }), {
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20
    });
    assert.deepEqual(normalizeTokenUsage({ inputTokens: 5, outputTokens: 7, totalTokens: 9 }), {
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12
    });
    assert.equal(estimateEmbeddingTokens(['hello world', '测试'], estimateTokens), estimateTokens('hello world') + estimateTokens('测试'));

    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`embed_usage_${suffix}`, 'hash', 'Embedding Usage', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    let modelId;

    try {
        modelId = getOrCreateEmbeddingUsageModel({
            userId,
            url: 'https://embedding-usage.example/v1',
            model: 'bge-test'
        });
        const sameModelId = getOrCreateEmbeddingUsageModel({
            userId,
            url: 'https://embedding-usage.example/v1',
            model: 'bge-test'
        });
        assert.equal(sameModelId, modelId);
        recordModelTokenUsage(userId, modelId, 30, 'rag_embedding', 10, 0);
        const event = db.prepare('SELECT token_count, input_tokens, output_tokens FROM model_usage_events WHERE user_id = ? AND model_id = ?').get(userId, modelId);
        assert.deepEqual(event, { token_count: 30, input_tokens: 10, output_tokens: 20 });
        const model = db.prepare('SELECT status, name FROM models WHERE id = ?').get(modelId);
        assert.equal(model.status, 'usage_only');
        assert.match(model.name, /bge-test/);
    } finally {
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(userId);
        if (modelId) db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('OpenAI 嵌入路由会先认证再限流', () => {
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

test('可用模型路由包含已配置的嵌入模型', async () => {
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

test('RAG cache scope changes when knowledge version changes', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_scope_${suffix}`, 'hash', 'RAG Scope Test', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (
            user_id, name, status, is_enabled, chunk_count, indexed_chunks, progress, created_at, updated_at, processed_at
        ) VALUES (?, ?, 'ready', 1, 2, 2, 100, ?, ?, ?)
    `).run(userId, `scope-${suffix}.md`, '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00');

    try {
        const first = buildRagCacheScope(userId, { topK: 3, candidateLimit: 80, scoreThreshold: 0.4 });
        db.prepare('UPDATE knowledge_docs SET updated_at = ? WHERE id = ?').run('2026-01-02 00:00:00', docInfo.lastInsertRowid);
        const second = buildRagCacheScope(userId, { topK: 3, candidateLimit: 80, scoreThreshold: 0.4 });
        assert.notEqual(first, second);
        assert.match(second, /d=1/);
        assert.match(second, /h=2/);
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('knowledge quality report exposes scored governance signals', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_quality_${suffix}`, 'hash', 'RAG Quality Test', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    db.prepare(`
        INSERT INTO knowledge_docs (
            user_id, name, status, is_enabled, chunk_count, indexed_chunks, progress, created_at, updated_at, processed_at
        ) VALUES (?, ?, 'ready', 1, 4, 4, 100, datetime('now', '+8 hours'), datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, `quality-${suffix}.md`);

    try {
        const report = getKnowledgeQualityReport(userId);
        assert.equal(report.overview.readyEnabled, 1);
        assert.equal(report.signals.readinessRate, 100);
        assert.equal(report.signals.avgChunksPerReadyDoc, 4);
        assert.ok(Number.isInteger(report.signals.score));
        assert.ok(Array.isArray(report.recommendations));
    } finally {
        db.prepare('DELETE FROM knowledge_docs WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});
