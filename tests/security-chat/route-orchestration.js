// 聊天路由编排回归测试
// 覆盖优化路线图「Chat orchestration tests」列出的路由级场景：额度拦截、知识库命中、
// 长期记忆命中、流式中断和上下文裁剪，确保对话路由继续只做 SSE 传输层。
const fs = require('node:fs');
const path = require('node:path');
const {
    assert,
    db,
    longTermMemory,
    saveUserMessage,
    test
} = require('../security-helpers');
const {
    createChatFixture,
    postChat,
    readSessionMessages,
    startChatRouteServer,
    startFakeUpstream
} = require('./chat-route-harness');
const { execute, queryOne } = require('../../server/db/client');
const {
    buildChatAgentMetadata,
    listChatAgentRunsForSession,
    persistAgentRunChatResult,
    recoverChatAgentResults
} = require('../../server/services/chat-agent-bridge');
const { buildVisionHistory } = require('../../server/services/chat-vision');
const { resolveUploadUrlPath, toProjectRelativePath } = require('../../server/security');

// 上下文窗口取 4000 时输入预算为 4000 - 2048（保留输出）- 256（安全边界）= 1696 tokens。
const NARROW_CONTEXT_WINDOW_TOKENS = 4000;
// 中文按 2 tokens/字估算，200 字约 400 tokens，多条历史即可超出上述输入预算。
const LONG_HISTORY_TEXT = '这是一段用于占满模型上下文窗口的历史会话内容'.repeat(9);

test('聊天路由在模型今日额度用尽时拦截请求且不落库用户消息', async () => {
    const fixture = createChatFixture({
        prefix: 'chat_quota',
        modelColumns: { daily_token_limit: 50 }
    });
    // 预置一条今日已计费消息，使 getModelDailyUsage 汇总值超过额度上限。
    db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at)
        VALUES (?, ?, 'assistant', ?, 120, ?, datetime('now', '+8 hours'))
    `).run(fixture.sessionId, fixture.userId, '历史回答', fixture.modelId);

    const routeServer = await startChatRouteServer({ fixture });
    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '今天的额度还够用吗',
            modelId: fixture.modelId
        });

        assert.equal(result.errorEvent?.code, 'QUOTA_EXCEEDED');
        assert.match(result.errorEvent.error, /额度已用完/);
        assert.ok(routeServer.auditRecords.some(item => item.action === '模型额度拦截'));

        const messages = readSessionMessages(fixture);
        assert.equal(messages.filter(row => row.role === 'user').length, 0, '额度拦截发生在用户消息入库之前');
        assert.equal(messages.length, 1);
    } finally {
        await routeServer.close();
        fixture.cleanup();
    }
});

test('聊天路由拒绝不属于当前用户的会话', async () => {
    const fixture = createChatFixture({ prefix: 'chat_forbidden', createSession: false });
    const routeServer = await startChatRouteServer({ fixture });
    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '你好',
            modelId: fixture.modelId
        });

        assert.equal(result.errorEvent?.code, 'FORBIDDEN');
        assert.equal(readSessionMessages(fixture).length, 0);
    } finally {
        await routeServer.close();
        fixture.cleanup();
    }
});

test('聊天重新生成沿用显式 Agent 模式并复用原用户消息', async () => {
    const fixture = createChatFixture({ prefix: 'chat_regenerate_agent' });
    const userMessage = await saveUserMessage({
        sessionId: fixture.sessionId,
        userId: fixture.userId,
        content: '请继续分析这个任务',
        modelId: fixture.modelId
    });
    let capturedRun = null;
    const routeServer = await startChatRouteServer({
        fixture,
        autoAgent: true,
        agentRunFactory: async options => {
            capturedRun = options;
            return { id: 'regenerate-agent-run', status: 'queued' };
        }
    });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '',
            modelId: fixture.modelId,
            chatMode: 'agent',
            regenerate: true
        });

        const handoff = result.findByType('agent_handoff');
        assert.equal(handoff?.runId, 'regenerate-agent-run');
        assert.ok(capturedRun, '重新生成必须创建 Agent Run');
        assert.equal(capturedRun.goal, '请继续分析这个任务');
        assert.equal(capturedRun.metadata.chatBridge.userMessageId, Number(userMessage.lastInsertRowid));
        assert.equal(capturedRun.metadata.chatBridge.currentMessage.content, '请继续分析这个任务');
        assert.equal(capturedRun.metadata.chatHistory.length, 0, '当前用户消息不应在历史中重复注入');

        const messages = readSessionMessages(fixture);
        assert.equal(messages.filter(row => row.role === 'user').length, 1, '重新生成不应重复写入用户消息');
        assert.equal(messages.filter(row => row.role === 'assistant').length, 0, '结果应由 Agent 完成后再持久化');
    } finally {
        await routeServer.close();
        fixture.cleanup();
    }
});

test('普通回答模式不会因消息内容创建持久化 Agent', async () => {
    const upstream = await startFakeUpstream({ replyChunks: ['你好，普通聊天回答正常。'] });
    const fixture = createChatFixture({ prefix: 'chat_short_message', upstreamUrl: upstream.url });
    let agentCalled = false;
    const routeServer = await startChatRouteServer({
        fixture,
        autoAgent: true,
        agentRunFactory: async () => {
            agentCalled = true;
            throw new Error('短消息不应进入 Agent');
        }
    });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '你好',
            modelId: fixture.modelId
        });
        assert.equal(agentCalled, false);
        assert.match(result.streamedContent, /普通聊天回答正常/);
        const messages = readSessionMessages(fixture);
        assert.equal(messages.filter(row => row.role === 'user').length, 1);
        assert.equal(messages.filter(row => row.role === 'assistant').length, 1);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('管理员关闭聊天 Agent 执行许可时拒绝显式 Agent 模式', async () => {
    const upstream = await startFakeUpstream({ replyChunks: ['普通模型流回答正常。'] });
    const fixture = createChatFixture({ prefix: 'chat_auto_agent_disabled', upstreamUrl: upstream.url });
    let agentCalled = false;
    const routeServer = await startChatRouteServer({
        fixture,
        autoAgent: () => false,
        agentRunFactory: async () => {
            agentCalled = true;
            throw new Error('开关关闭时不应创建 Agent');
        }
    });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '请使用普通模型流回答这个问题',
            modelId: fixture.modelId,
            chatMode: 'agent'
        });
        assert.equal(agentCalled, false);
        assert.equal(result.errorEvent?.code, 'AGENT_EXECUTION_DISABLED');
        assert.equal(readSessionMessages(fixture).filter(row => row.role === 'assistant').length, 0);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('普通回答模式即使内容复杂也不会创建持久化 Agent', async () => {
    const upstream = await startFakeUpstream({ replyChunks: ['普通回答模式正常。'] });
    const fixture = createChatFixture({ prefix: 'chat_explicit_normal_mode', upstreamUrl: upstream.url });
    let agentCalled = false;
    const routeServer = await startChatRouteServer({
        fixture,
        agentExecutionEnabled: true,
        agentRunFactory: async () => {
            agentCalled = true;
            throw new Error('普通回答模式不应创建 Agent');
        }
    });
    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '请分析这份数据并生成一份完整的管理报告',
            modelId: fixture.modelId,
            chatMode: 'normal'
        });
        assert.equal(agentCalled, false);
        assert.match(result.streamedContent, /普通回答模式正常/);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('显式 Agent 模式允许普通聊天使用较长任务目标', async () => {
    const fixture = createChatFixture({ prefix: 'chat_long_agent_message' });
    let capturedRun = null;
    const longContent = '长消息内容'.repeat(401);
    const routeServer = await startChatRouteServer({
        fixture,
        autoAgent: true,
        agentRunFactory: async options => {
            capturedRun = options;
            return { id: 'long-agent-run', status: 'queued' };
        }
    });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: longContent,
            modelId: fixture.modelId,
            chatMode: 'agent'
        });
        assert.equal(longContent.length > 2000, true);
        assert.equal(capturedRun?.chatAgent, true);
        assert.equal(capturedRun?.goal, longContent);
        assert.equal(result.findByType('agent_handoff')?.runId, 'long-agent-run');
        const messages = readSessionMessages(fixture);
        assert.equal(messages.filter(row => row.role === 'user').length, 1);
        assert.equal(messages.filter(row => row.role === 'assistant').length, 0);
    } finally {
        await routeServer.close();
        fixture.cleanup();
    }
});

test('普通聊天超出会话 Agent 桥接上限时回退模型流', async () => {
    const upstream = await startFakeUpstream({ replyChunks: ['超长消息普通聊天回答正常。'] });
    const fixture = createChatFixture({ prefix: 'chat_oversize_message', upstreamUrl: upstream.url });
    let agentCalled = false;
    const routeServer = await startChatRouteServer({
        fixture,
        autoAgent: true,
        agentRunFactory: async () => {
            agentCalled = true;
            throw new Error('超出聊天 Agent 上限的消息不应进入 Agent');
        }
    });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '超长消息内容'.repeat(2001),
            modelId: fixture.modelId
        });
        assert.equal(agentCalled, false);
        assert.match(result.streamedContent, /超长消息普通聊天回答正常/);
        const messages = readSessionMessages(fixture);
        assert.equal(messages.filter(row => row.role === 'user').length, 1);
        assert.equal(messages.filter(row => row.role === 'assistant').length, 1);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('普通聊天兼容旧版 Agent 目标校验并回退模型流', async () => {
    const upstream = await startFakeUpstream({ replyChunks: ['旧版校验回退回答正常。'] });
    const fixture = createChatFixture({ prefix: 'chat_legacy_goal_limit', upstreamUrl: upstream.url });
    const routeServer = await startChatRouteServer({
        fixture,
        autoAgent: true,
        agentRunFactory: async () => {
            const error = new Error('智能体目标不能超过 2000 个字符。');
            error.code = 'AGENT_GOAL_TOO_LONG';
            throw error;
        }
    });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '兼容旧版目标校验'.repeat(300),
            modelId: fixture.modelId,
            chatMode: 'agent'
        });
        assert.match(result.streamedContent, /旧版校验回退回答正常/);
        assert.equal(result.errorEvent, undefined);
        const messages = readSessionMessages(fixture);
        assert.equal(messages.filter(row => row.role === 'assistant').length, 1);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('重新生成的 Agent 接管失败也会持久化可见错误结果', async () => {
    const fixture = createChatFixture({ prefix: 'chat_regenerate_agent_error' });
    await saveUserMessage({
        sessionId: fixture.sessionId,
        userId: fixture.userId,
        content: '请重新执行失败场景',
        modelId: fixture.modelId
    });
    const routeServer = await startChatRouteServer({
        fixture,
        autoAgent: true,
        agentRunFactory: async () => {
            throw new Error('测试用 Agent 启动失败');
        }
    });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '',
            modelId: fixture.modelId,
            chatMode: 'agent',
            regenerate: true
        });
        assert.equal(result.errorEvent?.code, 'AGENT_HANDOFF_FAILED');
        const assistant = readSessionMessages(fixture).find(row => row.role === 'assistant');
        assert.ok(assistant);
        assert.match(assistant.content, /测试用 Agent 启动失败/);
    } finally {
        await routeServer.close();
        fixture.cleanup();
    }
});

test('聊天 Agent 终态回写幂等，并能恢复未回写的终态结果', async () => {
    const fixture = createChatFixture({ prefix: 'chat_agent_recovery' });
    const runIds = ['chat-bridge-idempotent', 'chat-bridge-recovery'];
    const createRun = async (id, answer, status = 'completed') => {
        await execute(`
            INSERT INTO agent_runs (
                id, user_id, session_id, goal, status, final_answer, metadata, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            id,
            fixture.userId,
            fixture.sessionId,
            '持久化聊天任务',
            status,
            answer,
            JSON.stringify(buildChatAgentMetadata({
                sessionId: fixture.sessionId,
                visibleContent: '持久化聊天任务',
                currentContent: '持久化聊天任务',
                userMessageId: null
            }))
        ]);
    };
    await createRun(runIds[0], '第一次最终答案');
    await createRun(runIds[1], '恢复后的最终答案');

    try {
        const [firstMessageId, concurrentMessageId] = await Promise.all([
            persistAgentRunChatResult(runIds[0]),
            persistAgentRunChatResult(runIds[0])
        ]);
        const secondMessageId = await persistAgentRunChatResult(runIds[0]);
        assert.ok(firstMessageId > 0);
        assert.equal(concurrentMessageId, firstMessageId, '并发终态通知必须收敛到同一条助手消息');
        assert.equal(secondMessageId, firstMessageId, '重复终态通知不得重复写助手消息');
        assert.equal((await queryOne('SELECT COUNT(*) AS count FROM messages WHERE agent_run_id = ?', [runIds[0]])).count, 1);

        const activeBefore = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runIds[1]]);
        const activeMetadata = typeof activeBefore.metadata === 'string'
            ? JSON.parse(activeBefore.metadata)
            : activeBefore.metadata;
        assert.equal(activeMetadata.chatBridge.messageId || null, null);
        const recovered = await recoverChatAgentResults({ limit: 20 });
        assert.ok(recovered.recovered >= 1, '恢复扫描应补齐未回写的聊天结果');
        const secondRow = await queryOne('SELECT id, content FROM messages WHERE agent_run_id = ?', [runIds[1]]);
        assert.ok(secondRow);
        assert.equal(secondRow.content, '恢复后的最终答案');

        const pending = await listChatAgentRunsForSession(fixture.sessionId, fixture.userId);
        assert.equal(pending.length, 0, '已回写的终态 Agent 不应再次显示为待恢复');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', runIds);
        fixture.cleanup();
    }
});

test('聊天 Agent 会把当前会话内的图片附件转换为受控视觉输入', async () => {
    const fixture = createChatFixture({ prefix: 'chat_agent_vision' });
    const uploadUrl = '/uploads/chat-agent-vision.png';
    const targetPath = resolveUploadUrlPath(uploadUrl);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    assert.ok(targetPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, png);
    await execute(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, created_at)
        VALUES (?, ?, 'chat-agent-vision.png', ?, 'image/png', ?, CURRENT_TIMESTAMP)
    `, [fixture.userId, fixture.sessionId, toProjectRelativePath(targetPath), png.length]);

    try {
        const history = await buildVisionHistory([
            { role: 'user', content: `请分析 ![截图](${uploadUrl})` }
        ], 'http://pivot-agent.local', fixture.userId, fixture.sessionId);
        assert.equal(history[0].content[0].type, 'text');
        assert.match(history[0].content[0].text, /截图/);
        assert.equal(history[0].content[1].type, 'image_url');
        assert.match(history[0].content[1].image_url.url, /^data:image\/png;base64,/);
    } finally {
        await execute('DELETE FROM attachments WHERE user_id = ? AND session_id = ?', [fixture.userId, fixture.sessionId]);
        try { fs.unlinkSync(targetPath); } catch (_) {}
        fixture.cleanup();
    }
});

test('聊天路由在模型不可用时返回模型缺失错误', async () => {
    const fixture = createChatFixture({ prefix: 'chat_model_missing' });
    const routeServer = await startChatRouteServer({ fixture });
    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '你好',
            modelId: fixture.modelId + 9_000_000
        });

        assert.equal(result.errorEvent?.code, 'MODEL_NOT_FOUND');
        assert.equal(readSessionMessages(fixture).length, 0);
    } finally {
        await routeServer.close();
        fixture.cleanup();
    }
});

test('聊天路由在知识库命中时下发引用来源摘要', async () => {
    const upstream = await startFakeUpstream({ replyChunks: ['已依据知识库回答'] });
    const fixture = createChatFixture({ prefix: 'chat_rag_hit', upstreamUrl: upstream.url });
    const ragContext = [
        '[引用 1 | 来源: 差旅报销制度.pdf] 出差住宿标准按城市分级执行。',
        '[引用 2 | 来源: 差旅报销制度.pdf] 报销单据需在返岗后十个工作日内提交。',
        '[引用 3 | 来源: 财务流程手册.docx] 超标住宿需部门负责人审批。'
    ].join('\n');
    const routeServer = await startChatRouteServer({
        fixture,
        retrieveContext: async () => ragContext,
        isRagEnabled: () => true
    });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '出差住宿怎么报销',
            modelId: fixture.modelId
        });

        const ragEvent = result.findByType('rag');
        assert.ok(ragEvent, '应下发知识库检索事件');
        assert.equal(ragEvent.status, 'hit');
        assert.equal(ragEvent.citationCount, 3);
        assert.equal(ragEvent.sourceCount, 2);
        assert.deepEqual(ragEvent.sources, ['差旅报销制度.pdf', '财务流程手册.docx']);
        assert.equal(ragEvent.scoped, false);
        assert.match(ragEvent.message, /2 份可引用文档/);

        const assistant = readSessionMessages(fixture).find(row => row.role === 'assistant');
        assert.ok(assistant, '命中知识库后仍应正常生成并落库助手消息');
        assert.match(assistant.content, /已依据知识库回答/);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('聊天路由在知识库未命中时提示按普通对话继续', async () => {
    const upstream = await startFakeUpstream({ replyChunks: ['按普通对话回答'] });
    const fixture = createChatFixture({ prefix: 'chat_rag_empty', upstreamUrl: upstream.url });
    const routeServer = await startChatRouteServer({
        fixture,
        retrieveContext: async () => null,
        isRagEnabled: () => true
    });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '公司团建预算是多少',
            modelId: fixture.modelId
        });

        const ragEvent = result.findByType('rag');
        assert.ok(ragEvent);
        assert.equal(ragEvent.status, 'empty');
        assert.match(ragEvent.message, /未检索到足够相关内容/);

        const assistant = readSessionMessages(fixture).find(row => row.role === 'assistant');
        assert.ok(assistant, '未命中知识库时应按普通对话完成生成');
        assert.match(assistant.content, /按普通对话回答/);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('聊天路由在长期记忆命中时下发记忆检索事件', async () => {
    const upstream = await startFakeUpstream({ replyChunks: ['已结合长期记忆回答'] });
    const fixture = createChatFixture({ prefix: 'chat_memory_hit', upstreamUrl: upstream.url });
    // 跳过向量生成，命中路径回退为关键词打分，避免测试依赖外部 Embedding 服务。
    const saved = await longTermMemory.upsertMemory(fixture.userId, {
        type: longTermMemory.MEMORY_TYPES.fact,
        content: '蓝鲸项目的发布节奏是每两周一次，由质量组确认后发布',
        salience: 0.9,
        confidence: 0.9
    }, { skipEmbedding: true });
    assert.equal(saved.inserted, true, '记忆需成功写入才能验证命中路径');

    const routeServer = await startChatRouteServer({ fixture });
    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '蓝鲸项目的发布节奏是怎么安排的',
            modelId: fixture.modelId
        });

        const memoryEvent = result.findByType('memory');
        assert.ok(memoryEvent, '应下发长期记忆检索事件');
        assert.equal(memoryEvent.status, 'hit');
        assert.ok(memoryEvent.memoryCount >= 1);
        assert.match(memoryEvent.message, /相关长期记忆/);

        const assistant = readSessionMessages(fixture).find(row => row.role === 'assistant');
        assert.ok(assistant, '命中长期记忆后仍应正常完成生成');
        assert.match(assistant.content, /已结合长期记忆回答/);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('聊天路由在历史超出模型窗口时自动裁剪并提示', async () => {
    const upstream = await startFakeUpstream({ replyChunks: ['裁剪后仍可回答'] });
    const fixture = createChatFixture({
        prefix: 'chat_trim',
        upstreamUrl: upstream.url,
        modelColumns: { context_window_tokens: NARROW_CONTEXT_WINDOW_TOKENS }
    });
    const insertHistory = db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `);
    for (let round = 0; round < 4; round += 1) {
        insertHistory.run(fixture.sessionId, fixture.userId, 'user', `${LONG_HISTORY_TEXT}${round}`, 400, fixture.modelId);
        insertHistory.run(fixture.sessionId, fixture.userId, 'assistant', `${LONG_HISTORY_TEXT}${round}`, 400, fixture.modelId);
    }

    const routeServer = await startChatRouteServer({ fixture });
    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '请总结上面的讨论',
            modelId: fixture.modelId
        });

        const budgetEvent = result.findByType('context_budget');
        assert.ok(budgetEvent, '超出窗口时应下发上下文裁剪事件');
        assert.equal(budgetEvent.status, 'trimmed');
        assert.equal(budgetEvent.contextBudget.adjusted, true);
        assert.ok(budgetEvent.contextBudget.droppedMessages > 0, '应丢弃较早历史消息');
        assert.ok(
            budgetEvent.contextBudget.inputTokensAfter <= budgetEvent.contextBudget.budget.inputBudget,
            '裁剪后输入 token 必须落回预算内'
        );
        const assistant = readSessionMessages(fixture).find(row => row.role === 'assistant' && row.content.includes('裁剪后仍可回答'));
        assert.ok(assistant, '裁剪后请求仍应完成生成');
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});

test('聊天路由在当前输入超出窗口时于预检阶段拦截', async () => {
    const fixture = createChatFixture({
        prefix: 'chat_too_long',
        modelColumns: { context_window_tokens: NARROW_CONTEXT_WINDOW_TOKENS }
    });
    const routeServer = await startChatRouteServer({ fixture });
    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '这是一条远超模型上下文窗口的超长提问内容'.repeat(45),
            modelId: fixture.modelId
        });

        assert.equal(result.errorEvent?.code, 'CONTEXT_LENGTH_EXCEEDED');
        assert.match(result.errorEvent.error, /超过当前模型/);
        assert.equal(readSessionMessages(fixture).length, 0, '预检拦截不应写入任何消息');
    } finally {
        await routeServer.close();
        fixture.cleanup();
    }
});

test('聊天路由在上游流式中断时持久化助手错误消息', async () => {
    // 上游先下发部分 SSE 再断开底层连接，触发流传输错误分支。
    const upstream = await startFakeUpstream({
        handler: (_req, res) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '回答开头' } }] })}\n\n`);
            setTimeout(() => res.socket?.destroy(), 30);
        }
    });
    const fixture = createChatFixture({ prefix: 'chat_stream_break', upstreamUrl: upstream.url });
    const routeServer = await startChatRouteServer({ fixture });

    try {
        const result = await postChat(routeServer.port, {
            sessionId: fixture.sessionId,
            content: '讲一段较长的说明',
            modelId: fixture.modelId
        });

        const errorEvent = result.findByType('assistant_error');
        assert.ok(errorEvent, '流中断应下发可持久化的助手错误事件');
        assert.match(errorEvent.error, /流传输中断/);

        const messages = readSessionMessages(fixture);
        assert.equal(messages.filter(row => row.role === 'user').length, 1, '用户消息应保留');
        const assistant = messages.find(row => row.role === 'assistant');
        assert.ok(assistant);
        assert.match(assistant.content, /生成失败/);
        assert.match(assistant.content, /流传输中断/);
    } finally {
        await routeServer.close();
        await upstream.close();
        fixture.cleanup();
    }
});
