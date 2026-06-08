// 从 security-rag.test.js 拆出；仍由父级入口统一加载。
const {
    ContextLengthExceededError,
    MEMORY_CONFIG_KEYS,
    RAG_CONFIG_KEYS,
    assert,
    buildFtsOrQuery,
    buildKeywordCandidates,
    buildRagContextMessage,
    buildRagSearchContent,
    chunkText,
    cosineSimilarity,
    db,
    deleteRelation,
    estimateMessagesTokens,
    extractKnowledgeGraph,
    fitMessagesToContextBudget,
    getAuditActionFilterValues,
    getBeijingTimestamp,
    getEntityGraph,
    getGraphContextForQuery,
    getGraphSummary,
    getHttpMetricsSnapshot,
    getMemoryConfig,
    getModelContextBudget,
    getMonitorKnowledgeChunkCount,
    getRagConfig,
    getRagMetricsSnapshot,
    indexKnowledgeGraphForChunks,
    injectRagContextBeforeLatestUser,
    listEntities,
    listRelations,
    localizeAuditDetails,
    localizeAuditLogRow,
    mergeEntities,
    normalizeAuditAction,
    normalizeEmbeddingMode,
    normalizeMemoryThreshold,
    recordHttpRequest,
    recordRagRetrieval,
    renderPrometheusMetrics,
    resolveRagQueryContent,
    summarizeRagContextSources,
    test,
    toMemorySettingValue,
    toRagSettingValue,
    updateEntity
} = require('../security-helpers');

test('RAG 辅助函数生成安全 FTS 查询和确定性分块', () => {
    assert.equal(buildFtsOrQuery(['hello', 'a"b']), '"hello" OR "a""b"');
    assert.ok(buildKeywordCandidates('权限配置流程').includes('权限'));
    assert.ok(buildRagSearchContent('权限配置流程').includes('权限'));
    assert.ok(buildRagSearchContent('权限配置流程').includes('配置'));
    assert.deepEqual(chunkText('abcdef', 4, 2), ['abcd', 'cdef', 'ef']);
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('知识图谱会从 RAG 分块提取实体和类型化关系', () => {
    const graph = extractKnowledgeGraph('运维中心负责Pivot平台，Pivot平台依赖知识库系统，知识库系统包含RAG流程。');
    const names = graph.entities.map(entity => entity.name);
    assert.ok(names.includes('运维中心'));
    assert.ok(names.includes('Pivot平台'));
    assert.ok(names.includes('知识库系统'));
    assert.ok(graph.relations.some(row => row.sourceName === '运维中心' && row.relationType === 'responsible_for' && row.targetName === 'Pivot平台'));
    assert.ok(graph.relations.some(row => row.sourceName === 'Pivot平台' && row.relationType === 'depends_on' && row.targetName === '知识库系统'));
});

test('知识图谱会索引并丰富检索上下文，同时支持整理操作', () => {
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

test('RAG 指标会分别报告检索命中率和缓存命中率', () => {
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

test('HTTP 指标暴露准确路由均值和 Prometheus 直方图桶', () => {
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

test('监控知识分块数只包含当前可用的已索引分块', () => {
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

test('RAG 配置会限制不安全检索参数', () => {
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

test('记忆阈值配置会规范化灵活令牌值', () => {
    assert.equal(normalizeMemoryThreshold('12K'), 12000);
    assert.equal(normalizeMemoryThreshold('1.5m'), 1500000);
    assert.equal(normalizeMemoryThreshold('10', 12000), 256);
    assert.equal(toMemorySettingValue(MEMORY_CONFIG_KEYS.threshold, '32K'), '32000');
    assert.equal(getMemoryConfig({ memory_threshold: { value: '64K' } }).thresholdTokens, 64000);
});

test('上下文预算不会对未配置模型强加硬编码默认窗口', () => {
    const budget = getModelContextBudget({});
    const longPrompt = 'unconfigured model prompt '.repeat(5000);

    assert.equal(budget.contextWindow, 0);
    assert.equal(budget.unbounded, true);
    assert.doesNotThrow(() => fitMessagesToContextBudget([
        { role: 'user', content: longPrompt }
    ], {}));
});

test('上下文预算会在上游请求前裁剪旧历史和生成的知识上下文', () => {
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

test('上下文预算将注入的用户角色 RAG 上下文视为生成的知识上下文', () => {
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

test('上下文预算遵守已配置的大模型输入窗口', () => {
    const model = { max_input_tokens: 256000, max_tokens: 8192 };
    const budget = getModelContextBudget(model);
    const longAttachmentPrompt = `请阅读附件后总结：\n\n${'document text '.repeat(4000)}`;

    assert.equal(budget.inputBudget, 256000);
    assert.ok(budget.contextWindow >= 256000 + budget.reservedOutputTokens);
    assert.doesNotThrow(() => fitMessagesToContextBudget([
        { role: 'user', content: longAttachmentPrompt }
    ], model));
});

test('聊天 RAG 上下文会带严格指令注入到最新用户提示前', () => {
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

test('聊天 RAG 状态会提取可见引用来源', () => {
    const summary = summarizeRagContextSources([
        '[引用 1 | 来源: policy.md]: 内部答案',
        '[引用 2 | 来源: policy.md]: 补充答案',
        '[引用 3 | 来源: ops-guide.pdf]: 操作步骤',
        '参考知识图谱：平台 依赖 知识库'
    ].join('\n'));

    assert.equal(summary.citationCount, 3);
    assert.equal(summary.sourceCount, 2);
    assert.deepEqual(summary.sources, ['policy.md', 'ops-guide.pdf']);
});

test('请求内容为空时，聊天重新生成会复用最新用户提示做 RAG 检索', () => {
    const history = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: [{ type: 'text', text: 'latest knowledge query' }] }
    ];

    assert.equal(resolveRagQueryContent('', history), 'latest knowledge query');
    assert.equal(resolveRagQueryContent('fresh query', history), 'fresh query');
});

test('聊天重新生成的 RAG 查询会跳过已注入的 RAG 上下文消息', () => {
    const history = [
        { role: 'user', content: 'original question' },
        { role: 'assistant', content: 'original answer' },
        { role: 'user', content: buildRagContextMessage('cached retrieval context') }
    ];

    assert.equal(resolveRagQueryContent('', history), 'original question');
});

test('上下文预算会拒绝单条超过模型窗口的当前提示', () => {
    assert.throws(
        () => fitMessagesToContextBudget([
            { role: 'system', content: '系统提示' },
            { role: 'user', content: '超长输入'.repeat(400) }
        ], { max_input_tokens: 180, max_tokens: 64 }),
        ContextLengthExceededError
    );
});

test('RAG 嵌入模式会把旧值规范化为 HTTP 模式', () => {
    assert.equal(normalizeEmbeddingMode('cloud'), 'http');
    assert.equal(normalizeEmbeddingMode('local'), 'http');
    assert.equal(normalizeEmbeddingMode('http'), 'http');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.embeddingMode, 'cloud'), 'http');
    assert.equal(toRagSettingValue(RAG_CONFIG_KEYS.embeddingMode, 'local'), 'http');
});

test('审计操作会本地化旧 RAG 和集成标签', () => {
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
