const {
    assert,
    db,
    estimateMessagesTokens,
    fitMessagesToContextBudget,
    getModelContextBudget,
    longTermMemory,
    runExpressHandlers,
    test
} = require('../security-helpers');
const http = require('http');
const { createMemoriesRouter } = require('../../server/routes/memories');

function createMemoryTestUser(prefix = 'memory') {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status)
        VALUES (?, 'hash', ?, 'QA', 'user', 'active')
    `).run(`${prefix}_${suffix}`, 'Memory Test');
    const userId = Number(userInfo.lastInsertRowid);
    const sessionId = `${prefix}_session_${suffix}`;
    db.prepare('INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime(\'now\', \'+8 hours\'), datetime(\'now\', \'+8 hours\'))')
        .run(sessionId, userId, '长期记忆测试');
    return { id: userId, username: `${prefix}_${suffix}`, role: 'user', unit: 'QA', sessionId };
}

test('长期记忆表支持四类记忆并保留来源', async () => {
    const user = createMemoryTestUser('memory_schema');
    const sourceMessageIds = [101, 102];
    for (const type of Object.values(longTermMemory.MEMORY_TYPES)) {
        const result = await longTermMemory.upsertMemory(user.id, {
            type,
            content: `长期记忆 ${type} 项目 Alpha 使用绿色主题`,
            salience: 0.7,
            confidence: 0.8,
            sourceSessionId: user.sessionId,
            sourceMessageIds
        }, { skipEmbedding: true });
        assert.equal(result.inserted, true);
    }

    const listed = await longTermMemory.listMemories(user.id);
    assert.equal(listed.total, 4);
    assert.deepEqual(new Set(listed.memories.map(memory => memory.type)), new Set(Object.values(longTermMemory.MEMORY_TYPES)));
    assert.deepEqual(listed.memories[0].sourceMessageIds, sourceMessageIds);
});

test('长期记忆抽取会分类候选并拒绝敏感信息', () => {
    const user = createMemoryTestUser('memory_extract');
    const candidates = longTermMemory.extractMemoryCandidatesFromMessages([
        { id: 1, session_id: user.sessionId, role: 'user', content: '我更喜欢回答简洁一点。项目 Alpha 的数据库使用 SQLite。api_key: sk-1234567890abcdef1234567890' },
        { id: 2, session_id: user.sessionId, role: 'assistant', content: '已经决定以后默认使用中文输出。今天完成了长期记忆治理接口。' }
    ], { sessionId: user.sessionId });

    assert.ok(candidates.some(item => item.type === longTermMemory.MEMORY_TYPES.preference));
    assert.ok(candidates.some(item => item.type === longTermMemory.MEMORY_TYPES.fact));
    assert.ok(candidates.some(item => item.type === longTermMemory.MEMORY_TYPES.decision));
    assert.ok(candidates.every(item => !/sk-/.test(item.content)));
});

test('长期记忆检索注入使用独立预算并可被上下文裁剪', async () => {
    const user = createMemoryTestUser('memory_retrieve');
    await longTermMemory.upsertMemory(user.id, {
        type: 'fact',
        content: '项目 Alpha 的发布口径要求所有最终回答使用中文，并优先引用来源。',
        salience: 0.9,
        confidence: 0.85,
        sourceSessionId: user.sessionId,
        sourceMessageIds: [1]
    }, { skipEmbedding: true });

    const memories = await longTermMemory.retrieveLongTermMemories(user.id, 'Alpha 发布口径是什么', { limit: 5 });
    assert.equal(memories.length >= 1, true);
    const memoryMessage = longTermMemory.buildLongTermMemoryContextMessage(memories, {
        inputBudget: getModelContextBudget({ max_input_tokens: 800, max_tokens: 80 }).inputBudget
    });
    assert.match(memoryMessage.content, /PIVOT_LONG_TERM_MEMORY_BEGIN/);
    assert.match(memoryMessage.content, /Alpha/);

    const oversizedMemory = {
        role: 'system',
        content: `PIVOT_LONG_TERM_MEMORY_BEGIN\n${'Alpha 长期记忆 '.repeat(1000)}\nPIVOT_LONG_TERM_MEMORY_END`
    };
    const result = fitMessagesToContextBudget([
        { role: 'system', content: '系统提示' },
        { role: 'system', content: oversizedMemory.content },
        { role: 'user', content: '当前问题' }
    ], { max_input_tokens: 360, max_tokens: 80 });
    assert.ok(estimateMessagesTokens(result.messages) <= getModelContextBudget({ max_input_tokens: 360, max_tokens: 80 }).inputBudget);
    assert.equal(result.metadata.trimmedMemoryContexts + result.metadata.droppedMemoryContexts > 0, true);
});

test('长期记忆治理接口支持查看、禁用、删除和关闭自动记忆', async () => {
    const user = createMemoryTestUser('memory_route');
    const inserted = await longTermMemory.upsertMemory(user.id, {
        type: 'preference',
        content: '用户偏好：回答时先给结论。',
        salience: 0.8,
        confidence: 0.8,
        sourceSessionId: user.sessionId,
        sourceMessageIds: [1]
    }, { skipEmbedding: true });
    const router = createMemoriesRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        logAction: () => {}
    });

    const listRoute = router.stack.find(layer => layer.route?.path === '/memories' && layer.route?.methods?.get);
    const listReq = { query: {}, user };
    const listRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(listRoute.route.stack.map(layer => layer.handle), listReq, listRes);
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.total, 1);

    const settingsRoute = router.stack.find(layer => layer.route?.path === '/memories/settings' && layer.route?.methods?.put);
    const settingsReq = { body: { enabled: false }, user };
    const settingsRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(settingsRoute.route.stack.map(layer => layer.handle), settingsReq, settingsRes);
    assert.equal(settingsRes.body.enabled, false);

    const extractionRes = await longTermMemory.scheduleMemoryExtraction({
        userId: user.id,
        sessionId: user.sessionId,
        messageIds: [1],
        user
    });
    assert.equal(extractionRes.reason, 'disabled');

    const statusRoute = router.stack.find(layer => layer.route?.path === '/memories/:id/status' && layer.route?.methods?.put);
    const statusReq = { params: { id: inserted.id }, body: { status: 'disabled' }, user };
    const statusRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(statusRoute.route.stack.map(layer => layer.handle), statusReq, statusRes);
    assert.equal(statusRes.statusCode, 200);
    assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(inserted.id).status, 'disabled');

    const deleteRoute = router.stack.find(layer => layer.route?.path === '/memories/:id' && layer.route?.methods?.delete);
    const deleteReq = { params: { id: inserted.id }, user };
    const deleteRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(deleteRoute.route.stack.map(layer => layer.handle), deleteReq, deleteRes);
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(inserted.id).status, 'deleted');
});

function insertSourceMessage(user, role, content) {
    const info = db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, created_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(user.sessionId, user.id, role, content);
    return Number(info.lastInsertRowid);
}

function startMemoryExtractorServer(payload) {
    const server = http.createServer((req, res) => {
        req.resume();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('长期记忆抽取优先使用结构化模型输出并保留启发式兜底', async () => {
    const user = createMemoryTestUser('memory_llm_extract');
    user.role = 'admin';
    const userMessageId = insertSourceMessage(user, 'user', '项目 Beta 的发布说明固定使用中文摘要。');
    const assistantMessageId = insertSourceMessage(user, 'assistant', '收到。');
    const server = await startMemoryExtractorServer({
        choices: [{
            message: {
                content: JSON.stringify({
                    memories: [{
                        type: 'fact',
                        content: '项目 Beta 的发布说明固定使用中文摘要。',
                        salience: 0.91,
                        confidence: 0.88
                    }]
                })
            }
        }]
    });
    try {
        const port = server.address().port;
        const result = await longTermMemory.runMemoryExtraction({
            userId: user.id,
            sessionId: user.sessionId,
            messageIds: [userMessageId, assistantMessageId],
            user,
            modelCfg: {
                id: 999001,
                user_id: user.id,
                name: 'Memory Extractor',
                url: `http://127.0.0.1:${port}/v1/chat/completions`,
                model_name: 'memory-extractor'
            }
        });
        assert.equal(result.extractor, 'model');
        assert.equal(result.inserted, 1);
        assert.ok(db.prepare('SELECT id FROM memories WHERE user_id = ? AND content LIKE ?').get(user.id, '%Beta%'));
    } finally {
        await new Promise(resolve => server.close(resolve));
    }

    const fallbackUser = createMemoryTestUser('memory_llm_fallback');
    fallbackUser.role = 'admin';
    const fallbackMessageId = insertSourceMessage(fallbackUser, 'user', '我更喜欢回答先给结论再给细节。');
    const invalidServer = await startMemoryExtractorServer({ choices: [{ message: { content: 'not json' } }] });
    try {
        const port = invalidServer.address().port;
        const result = await longTermMemory.runMemoryExtraction({
            userId: fallbackUser.id,
            sessionId: fallbackUser.sessionId,
            messageIds: [fallbackMessageId],
            user: fallbackUser,
            modelCfg: {
                id: 999002,
                user_id: fallbackUser.id,
                name: 'Invalid Extractor',
                url: `http://127.0.0.1:${port}/v1/chat/completions`,
                model_name: 'invalid-extractor'
            }
        });
        assert.equal(result.extractor, 'heuristic');
        assert.equal(result.inserted >= 1, true);
    } finally {
        await new Promise(resolve => invalidServer.close(resolve));
    }
});

test('长期记忆治理接口支持编辑、来源追溯、合并建议和合并', async () => {
    const user = createMemoryTestUser('memory_governance2');
    const firstMessageId = insertSourceMessage(user, 'user', '项目 Gamma 使用 SQLite 保存长期记忆。');
    const secondMessageId = insertSourceMessage(user, 'assistant', '已记录项目 Gamma 使用 SQLite。');
    const first = await longTermMemory.upsertMemory(user.id, {
        type: 'fact',
        content: '项目 Gamma 使用 SQLite 保存长期记忆。',
        salience: 0.74,
        confidence: 0.7,
        sourceSessionId: user.sessionId,
        sourceMessageIds: [firstMessageId]
    }, { skipEmbedding: true });
    const second = await longTermMemory.upsertMemory(user.id, {
        type: 'fact',
        content: '项目 Gamma 使用 SQLite 存储长期记忆数据。',
        salience: 0.8,
        confidence: 0.72,
        sourceSessionId: user.sessionId,
        sourceMessageIds: [secondMessageId]
    }, { skipEmbedding: true });
    const router = createMemoriesRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        logAction: () => {}
    });

    const updateRoute = router.stack.find(layer => layer.route?.path === '/memories/:id' && layer.route?.methods?.put);
    const updateReq = {
        params: { id: first.id },
        body: {
            type: 'decision',
            content: '项目 Gamma 长期记忆继续使用 SQLite。',
            salience: 0.9,
            confidence: 0.82
        },
        user
    };
    const updateRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(updateRoute.route.stack.map(layer => layer.handle), updateReq, updateRes);
    assert.equal(updateRes.statusCode, 200);
    assert.equal(updateRes.body.memory.type, 'decision');
    assert.match(updateRes.body.memory.content, /Gamma/);

    const sensitiveReq = {
        params: { id: first.id },
        body: { content: 'api_key: sk-1234567890abcdef1234567890' },
        user
    };
    const sensitiveRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(updateRoute.route.stack.map(layer => layer.handle), sensitiveReq, sensitiveRes);
    assert.equal(sensitiveRes.statusCode, 400);

    const sourceRoute = router.stack.find(layer => layer.route?.path === '/memories/:id/source' && layer.route?.methods?.get);
    const sourceReq = { params: { id: first.id }, user };
    const sourceRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(sourceRoute.route.stack.map(layer => layer.handle), sourceReq, sourceRes);
    assert.equal(sourceRes.statusCode, 200);
    assert.equal(sourceRes.body.messages.some(message => message.id === firstMessageId), true);

    await longTermMemory.updateMemory(user.id, first.id, {
        type: 'fact',
        content: '项目 Gamma 使用 SQLite 保存长期记忆。'
    }, { skipEmbedding: true });
    const suggestionsRoute = router.stack.find(layer => layer.route?.path === '/memories/merge-suggestions' && layer.route?.methods?.get);
    const suggestionsReq = { query: {}, user };
    const suggestionsRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(suggestionsRoute.route.stack.map(layer => layer.handle), suggestionsReq, suggestionsRes);
    assert.equal(suggestionsRes.body.suggestions.length >= 1, true);

    const mergeRoute = router.stack.find(layer => layer.route?.path === '/memories/merge' && layer.route?.methods?.post);
    const mergeReq = { body: { targetId: first.id, sourceId: second.id }, user };
    const mergeRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(mergeRoute.route.stack.map(layer => layer.handle), mergeReq, mergeRes);
    assert.equal(mergeRes.statusCode, 200);
    assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(second.id).status, 'deleted');
    assert.match(db.prepare('SELECT content FROM memories WHERE id = ?').get(first.id).content, /Gamma/);
});

test('长期记忆产品级治理支持持久化任务、质量摘要、批量状态和导出', async () => {
    const user = createMemoryTestUser('memory_product');
    const messageId = insertSourceMessage(user, 'user', '我更喜欢回答使用要点列表。');
    const queued = await longTermMemory.scheduleMemoryExtraction({
        userId: user.id,
        sessionId: user.sessionId,
        messageIds: [messageId],
        user
    });
    assert.equal(queued.scheduled, true);
    assert.ok(queued.jobId);
    assert.equal(db.prepare('SELECT status FROM memory_extraction_jobs WHERE id = ?').get(queued.jobId).status, 'queued');

    const processed = await longTermMemory.processMemoryExtractionJobs({ limit: 5 });
    assert.equal(processed.claimed >= 1, true);
    assert.equal(db.prepare('SELECT status FROM memory_extraction_jobs WHERE id = ?').get(queued.jobId).status, 'succeeded');

    const inserted = await longTermMemory.upsertMemory(user.id, {
        type: 'preference',
        content: '用户偏好：回答使用要点列表。',
        salience: 0.82,
        confidence: 0.8,
        sourceSessionId: user.sessionId,
        sourceMessageIds: [messageId]
    }, { skipEmbedding: true });
    const router = createMemoriesRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        logAction: () => {}
    });

    const qualityRoute = router.stack.find(layer => layer.route?.path === '/memories/quality' && layer.route?.methods?.get);
    const qualityReq = { query: {}, user };
    const qualityRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(qualityRoute.route.stack.map(layer => layer.handle), qualityReq, qualityRes);
    assert.equal(qualityRes.statusCode, 200);
    assert.ok(qualityRes.body.summary.quality.jobSummary);

    const jobsRoute = router.stack.find(layer => layer.route?.path === '/memories/jobs' && layer.route?.methods?.get);
    const jobsReq = { query: {}, user };
    const jobsRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(jobsRoute.route.stack.map(layer => layer.handle), jobsReq, jobsRes);
    assert.equal(jobsRes.statusCode, 200);
    assert.equal(jobsRes.body.jobs.some(job => job.id === queued.jobId), true);

    const bulkRoute = router.stack.find(layer => layer.route?.path === '/memories/status/bulk' && layer.route?.methods?.put);
    const bulkReq = { body: { ids: [inserted.id], status: 'disabled' }, user };
    const bulkRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(bulkRoute.route.stack.map(layer => layer.handle), bulkReq, bulkRes);
    assert.equal(bulkRes.statusCode, 200);
    assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(inserted.id).status, 'disabled');

    const exportRoute = router.stack.find(layer => layer.route?.path === '/memories/export' && layer.route?.methods?.get);
    const exportReq = { query: { status: 'all' }, user };
    const exportRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(exportRoute.route.stack.map(layer => layer.handle), exportReq, exportRes);
    assert.equal(exportRes.statusCode, 200);
    assert.equal(exportRes.body.export.memories.some(memory => memory.id === inserted.id), true);
});

test('长期记忆维护接口支持归档过期记忆和清理历史抽取任务', async () => {
    const user = createMemoryTestUser('memory_maintenance');
    const expired = await longTermMemory.upsertMemory(user.id, {
        type: 'episode',
        content: '历史片段：这条记忆已经过期，需要归档。',
        salience: 0.4,
        confidence: 0.7,
        sourceSessionId: user.sessionId,
        sourceMessageIds: [],
        expiresAt: '2000-01-01 00:00:00'
    }, { skipEmbedding: true });

    const jobInfo = db.prepare(`
        INSERT INTO memory_extraction_jobs (
            user_id, session_id, message_ids, status, attempts, max_attempts,
            created_at, updated_at, completed_at, next_run_at
        )
        VALUES (?, ?, '[]', 'succeeded', 1, 3,
            datetime('now', '+8 hours', '-60 days'),
            datetime('now', '+8 hours', '-60 days'),
            datetime('now', '+8 hours', '-60 days'),
            datetime('now', '+8 hours', '-60 days'))
    `).run(user.id, user.sessionId);

    const router = createMemoriesRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        logAction: () => {}
    });

    const archiveRoute = router.stack.find(layer => layer.route?.path === '/memories/maintenance/archive-expired' && layer.route?.methods?.post);
    const archiveReq = { body: {}, user };
    const archiveRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(archiveRoute.route.stack.map(layer => layer.handle), archiveReq, archiveRes);
    assert.equal(archiveRes.statusCode, 200);
    assert.equal(archiveRes.body.archived, 1);
    assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get(expired.id).status, 'disabled');

    const cleanupRoute = router.stack.find(layer => layer.route?.path === '/memories/jobs/cleanup' && layer.route?.methods?.post);
    const cleanupReq = { body: { retentionDays: 30 }, user };
    const cleanupRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await runExpressHandlers(cleanupRoute.route.stack.map(layer => layer.handle), cleanupReq, cleanupRes);
    assert.equal(cleanupRes.statusCode, 200);
    assert.equal(cleanupRes.body.deleted, 1);
    assert.equal(db.prepare('SELECT id FROM memory_extraction_jobs WHERE id = ?').get(jobInfo.lastInsertRowid), undefined);
});
