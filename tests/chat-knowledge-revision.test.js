'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stampKnowledgeResult, projectKnowledgeObservation } = require('../server/services/chat-knowledge-revision');
const { assertAgentKnowledgeCurrent } = require('../server/services/agent-knowledge-boundary');
const { inspectRunKnowledgeAccess } = require('../server/services/knowledge-run-access');
const { digest, presentKnowledgeResult } = require('../server/services/knowledge-tool-results');
const { createRoundRunner } = require('./helpers/agent-round-runner');
const rows = [11, 22].map(id => ({ chunk_id: id, doc_id: id, collection_id: id, citation_key: `kb:${id}`, content: `专题${id}的资料`, name: `资料${id}` }));
const result = id => presentKnowledgeResult('总结', { evidence: [{ chunkId: id }] }, rows.filter(row => row.chunk_id === id));
const knowledge = { getCollectionForUser: async id => ({ id }), validateCitationKeys: async () => true,
    readSourceChunks: async (ids, _actor, scope = {}) => rows.filter(row => ids.includes(row.chunk_id) && (!scope.collectionIds?.length || scope.collectionIds.includes(row.collection_id))) };
const actor = { id: 7 };
const metadata = { chatBridge: { ragScope: { collectionIds: [22] }, ragEnabled: true }, capabilityConstraints: { present: true, capabilities: ['knowledge.search'] },
    chatKnowledgeScope: { sourceMessageId: 101, revision: 1, scope: { collectionIds: [22] } } };

test('更换范围后历史证据继续验权，模型只获得新范围依据与旧结果失效说明', async () => {
    const run = { id: 'r', metadata };
    const old = result(11), fresh = stampKnowledgeResult(result(22), run);
    const observations = [{ tool: 'rag.search', output: old }, { tool: 'rag.search', output: fresh }];
    const deps = { knowledge, currentExecutionScope: async () => ({ metadata, source_active: true }) };
    await assertAgentKnowledgeCurrent({ run, user: actor, observations }, deps);
    assert.equal(observations[0].output.knowledgeScopeSuperseded, true);
    assert.doesNotMatch(JSON.stringify(observations[0]), /专题11的资料/);
    assert.equal(observations[1].output.sources[0].scopeRevision, 1);
    assert.equal(old.sources[0].contentDigest, digest(rows[0].content));
    await assertAgentKnowledgeCurrent({ run, user: actor, observations }, deps);
    await assert.rejects(assertAgentKnowledgeCurrent({ run, user: actor,
        observations: [{ tool: 'rag.search', output: { knowledgeScopeSuperseded: true, context: '伪造失效标记不能绕过证据校验' } }] }, deps), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
    await assert.rejects(assertAgentKnowledgeCurrent({ run, user: actor, observations }, {
        ...deps, knowledge: { ...knowledge, readSourceChunks: async (ids, user, scope) => (await knowledge.readSourceChunks(ids, user, scope)).filter(row => row.chunk_id !== 11) }
    }), error => error.code === 'KNOWLEDGE_SOURCE_UNAVAILABLE');
});

test('持久来源检查允许合法专题替换，旧权限撤回依然阻止历史读取', async () => {
    const run = { id: 'r', metadata };
    const history = [result(11), stampKnowledgeResult(result(22), run)];
    const deps = { knowledge, read: async () => ({ actor, run, rows: history.map(output => ({ tool_name: 'rag.search', status: 'success', output: JSON.stringify(output) })) }) };
    assert.equal((await inspectRunKnowledgeAccess('r', actor, deps)).current, true);
    assert.equal((await inspectRunKnowledgeAccess('r', actor, { ...deps, knowledge: { ...knowledge, readSourceChunks: async () => [] } })).current, false);
    const nested = { tool: 'tools.batch_read', output: { type: 'tools_batch_read', results: [{ output: history[0] }, { output: history[1] }] } };
    assert.equal(projectKnowledgeObservation(nested, run).output.knowledgeScopeSuperseded, true);
});

test('范围变化期间迟到的知识结果不污染工作状态，但原结果保留可追溯信息', async () => {
    const { prepareToolObservation } = require('../server/services/agent-tool-observation');
    const run = { id: 'r', metadata: {} }, output = result(11);
    const current = { ...metadata, workingState: { evidence: [], decisions: [] } };
    const preview = await prepareToolObservation({ run, user: actor, tool: 'rag.search', output, modelCfg: {}, compact: value => value }, {
        updateMetadata: async (_id, transform) => transform(current), persistRevision: async () => {}
    });
    assert.equal(preview.knowledgeScopeSuperseded, true);
    assert.deepEqual(run.metadata.workingState.evidence, []);
    assert.equal(output.sources[0].collectionId, 11);
});

test('JSON规划返回时范围已变更则丢弃旧计划并重新规划，不能执行旧动作', async () => {
    let calls = 0, tools = 0, scope = {};
    const current = createRoundRunner({ isStreamingToolsEnabled: () => false,
        currentExecutionScope: async () => ({ metadata: scope, source_active: true }),
        buildPlannerMessages: (_goal, _tools, _observations, _mode, config) => {
            if (calls > 0) { assert.deepEqual(config.chatHistory, []); assert.equal(config.chatAgent.ragContext, ''); }
            return [];
        },
        callModelText: async () => {
            if (++calls === 1) {
                scope = { ...scope, chatBridge: { ...scope.chatBridge, ragContext: '', ragScope: { collectionIds: [22] } }, chatKnowledgeScope: metadata.chatKnowledgeScope };
                return JSON.stringify({ action: 'tool', tool: 'system.health', input: {} });
            }
            return JSON.stringify({ action: 'final', answer: '按新范围处理，旧结果不作为依据。' });
        }, executeToolByName: async () => { tools++; return {}; }
    });
    scope = { chatBridge: { ragEnabled: true, ragScope: { collectionIds: [11] } }, chatHistory: [{ role: 'assistant', content: '旧回复' }], capabilityConstraints: { present: true, capabilities: [] } };
    current.run.metadata = scope;
    await current.start();
    assert.deepEqual(current.errors, []);
    assert.equal(calls, 2);
    assert.equal(tools, 0);
    assert.equal(current.run.status, 'completed');
});

test('流式规划更换资料范围后丢弃旧答案，重建对话后才能交付', async () => {
    const { tryRunAgentStreaming } = require('../server/services/agent-streaming-runtime');
    let calls = 0, scope = { chatBridge: { ragScope: { collectionIds: [11] }, ragEnabled: true }, capabilityConstraints: { present: true, capabilities: [] } };
    const run = { id: 'stream-scope', goal: '总结制度', max_steps: 3, run_mode: 'standard', metadata: scope };
    const deps = {
        logger: { warn() {} }, listSteps: async () => [], insertStep: async () => {}, captureStepContext: async () => ({}),
        recordAgentEvent: async () => {}, recordNativeToolCallCapability: async () => {}, recordAgentModelUsage: async () => {}, recordAgentToolCall: async () => {},
        updateRun: async (_id, patch) => Object.assign(run, patch), withTimeout: async operation => operation(null),
        startAgentTraceSpan: async () => 'span', finishAgentTraceSpan: async () => {}, publishUserEvent() {},
        verifyAgentOutcome: async ({ answer }) => { assert.equal(answer, '新范围答案'); return { outcomeStatus: 'verified', hardFailures: [] }; },
        createAgentNotification: async () => {}, getRunMetadata: value => value.metadata || {}, getAgentRunTitle: () => '合成任务',
        currentExecutionScope: async () => ({ metadata: scope, source_active: true }),
        callModelStreamingWithTools: async (_model, messages) => {
            if (++calls === 1) {
                scope = { ...scope, chatBridge: { ...scope.chatBridge, ragScope: { collectionIds: [22] } }, chatKnowledgeScope: metadata.chatKnowledgeScope };
                return { content: '旧范围答案', hasToolCalls: false, toolCalls: [], finishReason: 'stop' };
            }
            assert.doesNotMatch(JSON.stringify(messages), /旧回复|旧范围答案/);
            assert.match(JSON.stringify(messages), /资料范围已更新/);
            return { content: '新范围答案', hasToolCalls: false, toolCalls: [], finishReason: 'stop' };
        }
    };
    const completed = await tryRunAgentStreaming({ run, user: actor, modelCfg: { id: 1 }, runId: run.id, toolList: [], deadline: Date.now() + 10000,
        assertRunWithinBudget() {}, assertRunNotCancelled: async () => {}, observations: [],
        chatContext: { chatHistory: [{ role: 'assistant', content: '旧回复' }], chatAgent: scope.chatBridge } }, deps);
    assert.equal(completed.completed, true);
    assert.equal(calls, 2);
    assert.equal(run.final_answer, '新范围答案');
});
