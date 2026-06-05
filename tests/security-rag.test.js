// RAG 安全测试
const {
    ContextLengthExceededError,
    MEMORY_CONFIG_KEYS,
    RAG_CONFIG_KEYS,
    assert,
    buildEmbeddingModelItem,
    buildEmbeddingModelListUrls,
    buildEmbeddingPayload,
    buildEmbeddingResponse,
    buildFtsOrQuery,
    buildKeywordCandidates,
    buildRagContextMessage,
    buildRagSearchContent,
    chunkText,
    cleanupSoftDeletedStorage,
    cosineSimilarity,
    createKnowledgeDocumentFromUpload,
    createModelsRouter,
    createOpenAIRouter,
    createSettingsRouter,
    db,
    debugRetrieveContext,
    deleteKnowledgeDocument,
    deleteRelation,
    estimateEmbeddingTokens,
    estimateMessagesTokens,
    estimateTokens,
    extractEmbeddingModelIds,
    extractKnowledgeGraph,
    fitMessagesToContextBudget,
    fs,
    getAuditActionFilterValues,
    getBeijingTimestamp,
    getEmbeddingConfig,
    getEntityGraph,
    getGraphContextForQuery,
    getGraphSummary,
    getHttpMetricsSnapshot,
    getKnowledgeDocumentAuditList,
    getKnowledgeDocumentDetail,
    getKnowledgeDocumentSummaryForUser,
    getKnowledgeSourcePath,
    getMemoryConfig,
    getModelContextBudget,
    getMonitorKnowledgeChunkCount,
    getOrCreateEmbeddingUsageModel,
    getPublicEmbeddingConfig,
    getRagConfig,
    getRagFeedbackSummary,
    getRagMetricsSnapshot,
    http,
    indexDocumentChunks,
    indexKnowledgeGraphForChunks,
    injectRagContextBeforeLatestUser,
    listEntities,
    listRelations,
    localizeAuditDetails,
    localizeAuditLogRow,
    mergeEntities,
    normalizeAuditAction,
    normalizeEmbeddingInputs,
    normalizeEmbeddingMode,
    normalizeEmbeddingVector,
    normalizeMemoryThreshold,
    normalizeTokenUsage,
    normalizeUploadedOriginalName,
    path,
    processKnowledgeDocument,
    readKnowledgeDocumentFromPath,
    recordHttpRequest,
    recordModelTokenUsage,
    recordRagFeedback,
    recordRagRetrieval,
    recoverStaleKnowledgeDocumentIndexes,
    removeTestPath,
    renderPrometheusMetrics,
    requestEmbedding,
    resolveEmbeddingUrl,
    resolveRagQueryContent,
    retrieveContext,
    runExpressHandlers,
    scheduleFailedKnowledgeDocumentsForUser,
    test,
    toMemorySettingValue,
    toProjectRelativePath,
    toRagSettingValue,
    updateEntity,
    uploadRoot
} = require('./security-helpers');

test('RAG helpers build safe FTS queries and deterministic chunks', () => {
    assert.equal(buildFtsOrQuery(['hello', 'a"b']), '"hello" OR "a""b"');
    assert.ok(buildKeywordCandidates('权限配置流程').includes('权限'));
    assert.ok(buildRagSearchContent('权限配置流程').includes('权限'));
    assert.ok(buildRagSearchContent('权限配置流程').includes('配置'));
    assert.deepEqual(chunkText('abcdef', 4, 2), ['abcd', 'cdef', 'ef']);
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('knowledge graph extracts entities and typed relations from RAG chunks', () => {
    const graph = extractKnowledgeGraph('运维中心负责Pivot平台，Pivot平台依赖知识库系统，知识库系统包含RAG流程。');
    const names = graph.entities.map(entity => entity.name);
    assert.ok(names.includes('运维中心'));
    assert.ok(names.includes('Pivot平台'));
    assert.ok(names.includes('知识库系统'));
    assert.ok(graph.relations.some(row => row.sourceName === '运维中心' && row.relationType === 'responsible_for' && row.targetName === 'Pivot平台'));
    assert.ok(graph.relations.some(row => row.sourceName === 'Pivot平台' && row.relationType === 'depends_on' && row.targetName === '知识库系统'));
});

test('knowledge graph indexes, enriches retrieval context, and supports curation actions', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(`kg_${suffix}`, 'hash', 'KG Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const now = getBeijingTimestamp();
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, chunk_count, indexed_chunks, progress, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, `kg_${suffix}.md`, 'ready', 1, 1, 100, now, now);
    const docId = docInfo.lastInsertRowid;
    const text = '运维中心负责Pivot平台，Pivot平台依赖知识库系统。';
    const chunkInfo = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `).run(docId, text, buildRagSearchContent(text), JSON.stringify([1, 0]));

    try {
        const indexed = indexKnowledgeGraphForChunks({
            userId,
            docId,
            chunks: [{ chunkId: chunkInfo.lastInsertRowid, content: text }]
        });
        assert.ok(indexed.entities >= 3);
        assert.ok(indexed.relations >= 2);

        const summary = getGraphSummary(userId);
        assert.ok(summary.entities >= 3);
        assert.ok(summary.relations >= 2);

        const entities = listEntities({ userId, query: 'Pivot平台' });
        const pivot = entities.data.find(entity => entity.name === 'Pivot平台');
        assert.ok(pivot);

        const graph = getEntityGraph({ userId, entityId: pivot.id });
        assert.ok(graph.relations.some(row => row.relation_type === 'responsible_for' || row.relation_type === 'depends_on'));

        const context = getGraphContextForQuery(userId, 'Pivot平台由谁负责');
        assert.match(context.context, /运维中心/);
        assert.match(context.context, /参考知识图谱/);

        const updated = updateEntity({
            userId,
            entityId: pivot.id,
            patch: { name: 'Pivot平台', type: 'system', description: '核心业务平台' }
        });
        assert.equal(updated.type, 'system');
        assert.equal(updated.description, '核心业务平台');

        const relations = listRelations({ userId, entityId: pivot.id });
        assert.ok(relations.data.length > 0);
        assert.equal(deleteRelation({ userId, relationId: relations.data[0].id }), true);

        const pivotAlias = listEntities({ userId, query: 'Pivot' }).data.find(entity => entity.name === 'Pivot');
        if (pivotAlias) {
            const merged = mergeEntities({ userId, sourceEntityId: pivotAlias.id, targetEntityId: pivot.id });
            assert.ok(merged.center.id === pivot.id);
        }
    } finally {
        db.prepare('DELETE FROM knowledge_relations WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM knowledge_entity_mentions WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM knowledge_entities WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docId);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('RAG metrics report retrieval hit rate separately from cache hit rate', () => {
    const before = getRagMetricsSnapshot();
    recordRagRetrieval({ status: 'hit', matches: 2, durationMs: 10 });
    recordRagRetrieval({ status: 'cache_hit', matches: 1, cacheHit: true, durationMs: 1 });
    recordRagRetrieval({ status: 'cache_hit', matches: 0, cacheHit: true, durationMs: 1 });
    recordRagRetrieval({ status: 'no_match', matches: 0, durationMs: 5 });
    const after = getRagMetricsSnapshot();
    const retrievals = after.retrievals - before.retrievals;
    const hits = after.hits - before.hits;
    const cacheHits = after.cacheHits - before.cacheHits;

    assert.equal(retrievals, 4);
    assert.equal(hits, 2);
    assert.equal(cacheHits, 2);
    assert.equal(hits / retrievals, 0.5);
    assert.equal(cacheHits / retrievals, 0.5);
});

test('HTTP metrics expose accurate route averages and Prometheus histogram buckets', () => {
    const route = `/metrics-test-${Date.now()}`;
    recordHttpRequest('GET', route, '200', 0.01);
    recordHttpRequest('GET', route, '200', 0.2);

    const snapshot = getHttpMetricsSnapshot();
    const routeRow = snapshot.routes.find(item => item.method === 'GET' && item.route === route && item.status === '200');
    assert.ok(routeRow);
    assert.equal(routeRow.requests, 2);
    assert.equal(Math.round(routeRow.avgLatencyMs), 105);

    const metrics = renderPrometheusMetrics();
    const bucketValue = (le) => {
        const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedLe = String(le).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = metrics.match(new RegExp(`pivot_http_request_duration_seconds_bucket\\{method="GET",route="${escapedRoute}",status="200",le="${escapedLe}"\\} (\\d+)`));
        assert.ok(match, `missing histogram bucket ${le}`);
        return Number(match[1]);
    };

    assert.equal(bucketValue(0.1), 1);
    assert.equal(bucketValue(0.25), 2);
    assert.equal(bucketValue('+Inf'), 2);
});

test('monitor knowledge chunk count only includes currently usable indexed chunks', () => {
    const before = getMonitorKnowledgeChunkCount();
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`monitor_rag_${suffix}`, 'hash', 'Monitor RAG Test', 'QA', 'user', 'active');
    const insertDoc = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, indexed_chunks, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `);
    const insertChunk = db.prepare('INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding) VALUES (?, ?, ?, ?)');
    const readyDoc = insertDoc.run(userInfo.lastInsertRowid, `ready-${suffix}.txt`, 'ready', 1, 1, 1, null).lastInsertRowid;
    const disabledDoc = insertDoc.run(userInfo.lastInsertRowid, `disabled-${suffix}.txt`, 'ready', 0, 1, 1, null).lastInsertRowid;
    const processingDoc = insertDoc.run(userInfo.lastInsertRowid, `processing-${suffix}.txt`, 'processing', 1, 1, 1, null).lastInsertRowid;
    const deletedDoc = insertDoc.run(userInfo.lastInsertRowid, `deleted-${suffix}.txt`, 'ready', 1, 1, 1, '2099-01-01 00:00:00').lastInsertRowid;
    const docIds = [readyDoc, disabledDoc, processingDoc, deletedDoc];

    try {
        docIds.forEach((docId, index) => {
            insertChunk.run(docId, `chunk ${index}`, `chunk ${index}`, '[1,0]');
        });
        assert.equal(getMonitorKnowledgeChunkCount() - before, 1);
    } finally {
        docIds.forEach(docId => db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docId));
        docIds.forEach(docId => db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docId));
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
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

test('memory threshold config normalizes flexible token values', () => {
    assert.equal(normalizeMemoryThreshold('12K'), 12000);
    assert.equal(normalizeMemoryThreshold('1.5m'), 1500000);
    assert.equal(normalizeMemoryThreshold('10', 12000), 256);
    assert.equal(toMemorySettingValue(MEMORY_CONFIG_KEYS.threshold, '32K'), '32000');
    assert.equal(getMemoryConfig({ memory_threshold: { value: '64K' } }).thresholdTokens, 64000);
});

test('context budget does not impose a hardcoded default window for unconfigured models', () => {
    const budget = getModelContextBudget({});
    const longPrompt = 'unconfigured model prompt '.repeat(5000);

    assert.equal(budget.contextWindow, 0);
    assert.equal(budget.unbounded, true);
    assert.doesNotThrow(() => fitMessagesToContextBudget([
        { role: 'user', content: longPrompt }
    ], {}));
});

test('context budget trims old history and generated knowledge context before upstream requests', () => {
    const model = { max_input_tokens: 360, max_tokens: 80 };
    const longHistory = '旧历史 '.repeat(120);
    const longRag = '参考内部知识库 信息 '.repeat(120);
    const messages = [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: longHistory },
        { role: 'assistant', content: longHistory },
        { role: 'system', content: `【参考内部知识库信息如下】：\n[引用 1 | 来源: doc]: ${longRag}` },
        { role: 'user', content: '请基于资料给出简短结论' }
    ];

    const result = fitMessagesToContextBudget(messages, model);
    assert.ok(estimateMessagesTokens(result.messages) <= getModelContextBudget(model).inputBudget);
    assert.equal(result.metadata.adjusted, true);
    assert.ok(result.metadata.droppedMessages > 0 || result.metadata.trimmedRagContexts > 0);
    assert.equal(result.messages.at(-1).content, '请基于资料给出简短结论');
});

test('context budget treats injected user-role RAG context as generated knowledge context', () => {
    const model = { max_input_tokens: 700, max_tokens: 80 };
    const longHistory = 'old conversation '.repeat(300);
    const messages = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: longHistory },
        { role: 'assistant', content: longHistory },
        { role: 'user', content: buildRagContextMessage('retrieved policy fact '.repeat(2000)) },
        { role: 'user', content: 'current question' }
    ];

    const result = fitMessagesToContextBudget(messages, model);
    const ragMessage = result.messages.find(message => String(message.content || '').includes('PIVOT_RAG_CONTEXT_BEGIN'));

    assert.ok(estimateMessagesTokens(result.messages) <= getModelContextBudget(model).inputBudget);
    assert.equal(result.metadata.adjusted, true);
    assert.equal(result.metadata.trimmedRagContexts, 1);
    assert.ok(result.metadata.droppedMessages > 0);
    assert.equal(ragMessage?.role, 'user');
    assert.match(ragMessage.content, /PIVOT_RAG_CONTEXT_BEGIN/);
});

test('context budget honors configured large model input windows', () => {
    const model = { max_input_tokens: 256000, max_tokens: 8192 };
    const budget = getModelContextBudget(model);
    const longAttachmentPrompt = `请阅读附件后总结：\n\n${'document text '.repeat(4000)}`;

    assert.equal(budget.inputBudget, 256000);
    assert.ok(budget.contextWindow >= 256000 + budget.reservedOutputTokens);
    assert.doesNotThrow(() => fitMessagesToContextBudget([
        { role: 'user', content: longAttachmentPrompt }
    ], model));
});

test('chat RAG context is injected before the latest user prompt with strict instructions', () => {
    const history = [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '上一轮问题' },
        { role: 'assistant', content: '上一轮回答' },
        { role: 'user', content: '当前问题' }
    ];
    const ragContext = '【参考内部知识库信息如下】：\n[引用 1 | 来源: policy.md]: 内部答案';
    const injected = injectRagContextBeforeLatestUser(history, ragContext);

    assert.equal(injected.length, 5);
    assert.equal(injected.at(-1).content, '当前问题');
    assert.equal(injected.at(-2).role, 'user');
    assert.match(injected.at(-2).content, /PIVOT_RAG_CONTEXT_BEGIN/);
    assert.match(injected.at(-2).content, /必须优先依据以上知识库检索结果回答/);
    assert.match(buildRagContextMessage(ragContext), /引用 1/);
});

test('chat regenerate reuses latest user prompt for RAG retrieval when request content is empty', () => {
    const history = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: [{ type: 'text', text: 'latest knowledge query' }] }
    ];

    assert.equal(resolveRagQueryContent('', history), 'latest knowledge query');
    assert.equal(resolveRagQueryContent('fresh query', history), 'fresh query');
});

test('chat regenerate RAG query skips injected RAG context messages', () => {
    const history = [
        { role: 'user', content: 'original question' },
        { role: 'assistant', content: 'original answer' },
        { role: 'user', content: buildRagContextMessage('cached retrieval context') }
    ];

    assert.equal(resolveRagQueryContent('', history), 'original question');
});

test('context budget rejects a single current prompt that exceeds the model window', () => {
    assert.throws(
        () => fitMessagesToContextBudget([
            { role: 'system', content: '系统提示' },
            { role: 'user', content: '超长输入'.repeat(400) }
        ], { max_input_tokens: 180, max_tokens: 64 }),
        ContextLengthExceededError
    );
});

test('RAG embedding modes normalize legacy values to HTTP mode', () => {
    assert.equal(normalizeEmbeddingMode('cloud'), 'http');
    assert.equal(normalizeEmbeddingMode('local'), 'http');
    assert.equal(normalizeEmbeddingMode('http'), 'http');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.embeddingMode, 'cloud'), 'http');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.embeddingMode, 'local'), 'http');
});

test('audit actions localize legacy RAG and integration labels', () => {
    assert.equal(normalizeAuditAction('RAG_DOCUMENT_UPLOAD'), '知识库文档上传');
    assert.equal(normalizeAuditAction('RAG_EMBEDDING_TEST'), '向量模型连接测试');
    assert.equal(normalizeAuditAction('SYSTEM_ERROR'), '系统错误');
    assert.equal(normalizeAuditAction('OpenAI Tools 调用'), 'OpenAI 工具调用');
    assert.deepEqual(localizeAuditLogRow({ id: 1, action: 'RAG_FEEDBACK', details: '{"id":3,"helpful":true,"chunkId":9}' }), {
        id: 1,
        action: '知识库召回反馈',
        details: '反馈ID: 3，分块ID: 9，是否有帮助: 是'
    });
    assert.equal(localizeAuditDetails('RAG_DOCUMENT_UPLOAD', '{"docId":287,"name":"开发命令.txt"}'), '文档ID: 287，文件名: 开发命令.txt');
    assert.equal(localizeAuditDetails('知识库文档启停', '{"docId":1,"enabled":false}'), '文档ID: 1，状态: 停用');
    assert.ok(getAuditActionFilterValues('知识库文档上传').includes('RAG_DOCUMENT_UPLOAD'));
    assert.ok(getAuditActionFilterValues('RAG_DOCUMENT_UPLOAD').includes('知识库文档上传'));
    assert.equal(normalizeAuditAction('创建自动化任务'), '创建自动化任务');
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

test('non-root admin saves embedding config as personal settings', async () => {
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

test('admin can update memory threshold without root system settings access', async () => {
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

test('RAG embedding requests surface friendly timeout errors', async () => {
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

test('RAG document indexing uses extended embedding timeout and batched calls', async () => {
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

test('RAG document upload stores repaired Chinese filename', () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_name_${suffix}`, 'hash', 'RAG Name Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const tempDir = path.join(uploadRoot, 'rag-name-test');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${suffix}.txt`);
    fs.writeFileSync(tempPath, '中文文件名测试');
    const originalName = Buffer.from('测试文档.txt', 'utf8').toString('latin1');
    let docId = null;

    try {
        const result = createKnowledgeDocumentFromUpload({
            userId,
            file: {
                path: tempPath,
                originalname: normalizeUploadedOriginalName(originalName)
            }
        });
        docId = result.docId;
        const row = db.prepare('SELECT name FROM knowledge_docs WHERE id = ?').get(docId);
        assert.equal(row.name, '测试文档.txt');
    } finally {
        if (docId) {
            const doc = db.prepare('SELECT source_path FROM knowledge_docs WHERE id = ?').get(docId);
            const sourcePath = doc?.source_path ? getKnowledgeSourcePath(doc.source_path) : null;
            removeTestPath(sourcePath);
            db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docId);
            db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docId);
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        removeTestPath(tempDir, { recursive: true });
    }
});

test('RAG document reader supports office data and web text formats', async () => {
    const XLSX = require('xlsx');
    const suffix = Date.now().toString(36);
    const tempDir = path.join(uploadRoot, 'rag-format-test');
    fs.mkdirSync(tempDir, { recursive: true });
    const csvPath = path.join(tempDir, `${suffix}.csv`);
    const jsonPath = path.join(tempDir, `${suffix}.json`);
    const htmlPath = path.join(tempDir, `${suffix}.html`);
    const xlsxPath = path.join(tempDir, `${suffix}.xlsx`);
    fs.writeFileSync(csvPath, 'name,score\nalice,98\nbob,88');
    fs.writeFileSync(jsonPath, JSON.stringify({ title: '知识库 JSON 测试', items: ['alpha', 'beta'] }, null, 2));
    fs.writeFileSync(htmlPath, '<main><h1>知识库 HTML 测试</h1><p>正文内容</p></main>');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
        ['部门', '人数'],
        ['研发', 12],
        ['运营', 5]
    ]), 'Sheet1');
    XLSX.writeFile(workbook, xlsxPath);

    try {
        assert.match(await readKnowledgeDocumentFromPath(csvPath, 'data.csv'), /alice/);
        assert.match(await readKnowledgeDocumentFromPath(jsonPath, 'data.json'), /知识库 JSON 测试/);
        assert.match(await readKnowledgeDocumentFromPath(htmlPath, 'page.html'), /知识库 HTML 测试/);
        assert.match(await readKnowledgeDocumentFromPath(xlsxPath, 'book.xlsx'), /研发/);
    } finally {
        removeTestPath(tempDir, { recursive: true });
    }
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
        removeTestPath(path.join(uploadRoot, 'gc-test', String(userId)), { recursive: true });
        removeTestPath(path.join(uploadRoot, 'knowledge_docs', String(userId)), { recursive: true });
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
        removeTestPath(path.join(uploadRoot, 'gc-test', String(userId)), { recursive: true });
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

test('RAG retrieval merges fallback candidates and skips embedding calls when there are no candidates', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`rag_merge_${suffix}`, 'hash', 'RAG Merge Test', 'QA', 'user', 'active');
    const docInfo = db.prepare(`
        INSERT INTO knowledge_docs (user_id, name, status, is_enabled, chunk_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `rag_merge_${suffix}.txt`, 'ready', 1, 2);
    const insertChunk = db.prepare(`
        INSERT INTO knowledge_chunks (doc_id, content, search_content, embedding)
        VALUES (?, ?, ?, ?)
    `);
    const ftsOnly = insertChunk.run(
        docInfo.lastInsertRowid,
        'alpha 权限配置流程',
        buildRagSearchContent('alpha 权限配置流程'),
        JSON.stringify([1, 0])
    );
    const recentFallback = insertChunk.run(
        docInfo.lastInsertRowid,
        '完全无关键词但语义相关',
        buildRagSearchContent('完全无关键词但语义相关'),
        JSON.stringify([0, 1])
    );

    try {
        const result = await debugRetrieveContext(
            userInfo.lastInsertRowid,
            '权限配置',
            { queryVector: [1, 0], topK: 2, candidateLimit: 5, scoreThreshold: 0 }
        );
        const ids = result.matches.map(item => item.chunkId);
        assert.equal(ids.includes(ftsOnly.lastInsertRowid), true);
        assert.equal(ids.includes(recentFallback.lastInsertRowid), true);

        const empty = await retrieveContext(userInfo.lastInsertRowid + 1000000, '没有任何候选时不要请求向量');
        assert.equal(empty, '');
    } finally {
        db.prepare('DELETE FROM knowledge_chunks WHERE id IN (?, ?)').run(ftsOnly.lastInsertRowid, recentFallback.lastInsertRowid);
        db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('RAG indexing rejects empty documents instead of marking them ready', async () => {
    await assert.rejects(
        indexDocumentChunks(999999, '   \n\n\t', { userId: 1 }),
        /未解析出可索引文本/
    );
});

test('RAG summary returns personal retrieval configuration', () => {
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

test('token accounting balances totals and tracks embedding usage models', () => {
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
