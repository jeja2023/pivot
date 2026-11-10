'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { continueConversationTask } = require('../server/services/chat-task-continuation');
const { resolveKnowledgeToolScope } = require('../server/services/knowledge-tool-results');
const { currentKnowledgeControlMessage } = require('../server/services/chat-task-knowledge-scope');
const user = { id: 9 };
function fixture(initial = {}) {
    let metadata = { chatBridge: { ragScope: { collectionIds: [11] }, ragEnabled: true, ragContext: '旧检索内容' },
        capabilityConstraints: { present: true, capabilities: ['knowledge.search', 'conversation.read_source'] }, ...initial };
    const messages = [];
    const run = { id: 'owned', status: 'running', tool_policy: 'builtin_only', tool_allowlist: [], network_policy: {}, context_config: {} };
    const deps = { listSessionTasks: async () => [{ ...run, metadata }], getCollectionForUser: async id => [11, 22].includes(id) ? { id } : null,
        updateMetadata: async (_id, transform) => { metadata = transform(metadata); return metadata; }, sendAgentControlMessage: async message => messages.push(message) };
    const input = { user, sessionId: 'session', userMessageId: 100, instruction: '仅依据新专题继续总结', routeOverrides: { collections: [22] },
        decision: { continuationOf: 'owned', objective: '依据新专题继续总结', requiredCapabilities: ['knowledge.search'], routing: { tools: 'task', knowledge: 'required' } } };
    return { run, deps, input, messages, metadata: () => metadata };
}

test('续接替换专题并清理旧检索内容，实际范围解析使用新选择', async () => {
    for (const priorScope of [{ collectionIds: [11] }, {}]) {
        const f = fixture({ chatBridge: { ragScope: priorScope, ragEnabled: true, ragContext: '旧来源' } });
        const result = await continueConversationTask(f.input, f.deps);
        assert.equal(result.continued, true);
        assert.equal(f.metadata().chatBridge.ragContext, '');
        assert.deepEqual(f.metadata().chatBridge.ragScope.collectionIds, [22]);
        assert.deepEqual(f.messages[0].payload.knowledgeScope.collectionIds, [22]);
        assert.deepEqual((await resolveKnowledgeToolScope(user, { collectionIds: [22] }, { run: { metadata: f.metadata() } }, f.deps)).collectionIds, [22]);
        await assert.rejects(resolveKnowledgeToolScope(user, { collectionIds: [11] }, { run: { metadata: f.metadata() } }, f.deps), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
    }
});

test('续接标签和显式知识范围生效，未选择保留旧范围，清除不得恢复全库', async () => {
    const f = fixture();
    await continueConversationTask({ ...f.input, routeOverrides: {}, decision: { ...f.input.decision, knowledgeScope: { collectionIds: [22], tagNames: ['有效制度'] } } }, f.deps);
    assert.deepEqual(f.metadata().chatBridge.ragScope.tagNames, ['有效制度']);
    await continueConversationTask({ ...f.input, userMessageId: 101, routeOverrides: {} }, f.deps);
    assert.deepEqual(f.metadata().chatBridge.ragScope.collectionIds, [22]);
    await continueConversationTask({ ...f.input, userMessageId: 102, routeOverrides: { excludeRag: true } }, f.deps);
    assert.equal(f.metadata().chatBridge.ragEnabled, false);
    assert.equal(f.metadata().capabilityConstraints.excludeKnowledge, true);
    await assert.rejects(resolveKnowledgeToolScope(user, {}, { run: { metadata: f.metadata() } }, f.deps), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
    await continueConversationTask({ ...f.input, userMessageId: 103 }, f.deps);
    assert.equal(f.metadata().chatBridge.ragEnabled, false, '显式专题不得恢复此前撤销的能力');
});

test('新知识范围仍验证账号及项目上限，旧消息和无权限范围不产生控制消息', async () => {
    const f = fixture();
    await assert.rejects(continueConversationTask({ ...f.input, routeOverrides: { collections: [999] } }, f.deps), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
    assert.equal(f.messages.length, 0);
    f.run.context_config = { collectionIds: [11] };
    await assert.rejects(continueConversationTask(f.input, f.deps), error => error.code === 'KNOWLEDGE_SCOPE_DENIED');
    f.run.context_config = {};
    await continueConversationTask(f.input, f.deps);
    await assert.rejects(continueConversationTask({ ...f.input, userMessageId: 99, routeOverrides: { collections: [11] } }, f.deps), error => error.code === 'CHAT_KNOWLEDGE_SCOPE_STALE');
    assert.deepEqual(f.metadata().chatBridge.ragScope.collectionIds, [22]);
    assert.equal(f.messages.length, 1);
});

test('知识库与工具同时改选时合并必要知识工具，保留网络和其余工具限制', async () => {
    const f = fixture();
    f.deps.resolveChatSelectedTools = async () => ({ names: ['mcp.1.read'], tools: [{ capabilities: ['data.query'] }], origins: ['https://approved.example'], ports: [443] });
    await continueConversationTask({ ...f.input, routeOverrides: { collections: [22], tools: ['mcp.1.read'] } }, f.deps);
    assert.deepEqual(f.metadata().chatToolScope.toolAllowlist, ['mcp.1.read', 'chat.read_source', 'rag.search', 'knowledge.list', 'knowledge.graph.query']);
    assert.deepEqual(f.metadata().chatToolScope.networkPolicy.allowed_origins, ['https://approved.example']);
    const old = { from_run_id: null, payload: { source: 'chat', sourceMessageId: 99, knowledgeScope: { collectionIds: [11] }, taskContractPatch: { goal: '旧目标' } } };
    assert.equal(currentKnowledgeControlMessage(old, f.metadata()).payload.taskContractPatch, undefined);
    assert.equal(currentKnowledgeControlMessage(old, f.metadata()).payload.knowledgeScopeSuperseded, true);
    assert.equal(currentKnowledgeControlMessage({ ...old, from_run_id: 'child' }, f.metadata()).payload.taskContractPatch.goal, '旧目标');
});

test('知识范围及控制消息在PostgreSQL持久化，乱序消费与恢复不能重开旧专题', { skip: !process.env.DATABASE_URL }, async () => {
    const { queryOne, execute } = require('../server/db/client');
    const { claimAgentControlMessages, applyAgentControlMessages, listAppliedAgentControlMessages } = require('../server/services/agent-control');
    const actor = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const collectionA = await queryOne("INSERT INTO knowledge_collections (user_id,name,scope) VALUES (?,'续接专题甲','personal') RETURNING id", [actor.id]);
    const collectionB = await queryOne("INSERT INTO knowledge_collections (user_id,name,scope) VALUES (?,'续接专题乙','personal') RETURNING id", [actor.id]);
    const id = `knowledge-continuation-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata) VALUES (?,?,'知识续接','总结制度','running',?)", [id, actor.id,
        JSON.stringify({ chatBridge: { ragEnabled: true, ragScope: { collectionIds: [Number(collectionA.id)] }, ragContext: '旧内容' }, capabilityConstraints: { present: true, capabilities: ['knowledge.search'] } })]);
    try {
        const input = { user: actor, sessionId: 'scope', instruction: '按当前专题继续总结', decision: { continuationOf: id, objective: '新专题目标', requiredCapabilities: ['knowledge.search'], routing: { tools: 'task' } } };
        const deps = { listSessionTasks: async () => [await queryOne('SELECT * FROM agent_runs WHERE id = ?', [id])] };
        await continueConversationTask({ ...input, userMessageId: 101, routeOverrides: { collections: [Number(collectionB.id)] } }, deps);
        const first = await claimAgentControlMessages(id, actor);
        await continueConversationTask({ ...input, userMessageId: 102, routeOverrides: { collections: [Number(collectionA.id)] }, decision: { ...input.decision, objective: '最终专题目标' } }, deps);
        const second = await claimAgentControlMessages(id, actor);
        await applyAgentControlMessages(id, actor, second);
        const stale = await applyAgentControlMessages(id, actor, first);
        assert.equal(stale[0].payload.knowledgeScopeSuperseded, true);
        const saved = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [id]);
        assert.deepEqual(saved.metadata.chatBridge.ragScope.collectionIds, [Number(collectionA.id)]);
        assert.equal(saved.metadata.taskContract.goal, '最终专题目标');
        assert.equal(saved.metadata.chatBridge.ragContext, '');
        const restored = await listAppliedAgentControlMessages(id, actor);
        assert.equal(restored.find(message => message.payload.sourceMessageId === 101).payload.knowledgeScopeSuperseded, true);
        assert.deepEqual((await resolveKnowledgeToolScope(actor, {}, { run: saved })).collectionIds, [Number(collectionA.id)]);
    } finally {
        await execute('DELETE FROM agent_control_messages WHERE to_run_id = ?', [id]);
        await execute('DELETE FROM agent_runs WHERE id = ?', [id]);
        await execute('DELETE FROM knowledge_collections WHERE id IN (?,?)', [collectionA.id, collectionB.id]);
    }
});
