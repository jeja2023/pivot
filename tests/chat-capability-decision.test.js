'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveChatIntent, normalizeIntent } = require('../server/services/chat-intent-resolver');
const { decideAutomaticChatExecution } = require('../server/services/chat-auto-execution-handler');
const { createSemanticRouter } = require('../server/services/semantic-router');
const { applyAutomaticExecutionDecision, detectChatRouteCorrection } = require('../server/services/chat-route-correction');
const { isAutomaticReadTool, getChatCapabilityAvailability } = require('../server/services/chat-capability-scope');
const { evaluateToolPolicy } = require('../server/services/agent-policy');
const { resolveResponsePreferences } = require('../server/services/agent-response-preferences');

const user = { id: 9 };
const input = { prompt: '我们公司婚假有几天？', user, userMessageId: 11, sessionId: 'owned', modelCfg: { id: 8 } };
const decision = { action: 'direct_answer', objective: input.prompt, requiredCapabilities: [], evidenceRefs: ['current_message'],
    routing: { knowledge: 'required', tools: 'none', retrievalQuery: input.prompt } };
const modelDeps = raw => ({ config: { mode: 'active', timeoutMs: 1000, rolloutPercent: 100 }, callModelJson: async () => JSON.stringify(raw), recordDecision() {} });

test('日常组织问答与上下文追问进入同一次语义判断，携带完整检索问题', async () => {
    const first = await resolveChatIntent(input, modelDeps(decision));
    assert.equal(first.routing.knowledge, 'required');
    const followup = await resolveChatIntent({ ...input, prompt: '那实习生呢？', history: [{ id: 1, role: 'user', content: input.prompt }] },
        modelDeps({ ...decision, objective: '查询公司制度中实习生的婚假适用口径', routing: { ...decision.routing, retrievalQuery: '公司婚假制度对实习生的适用规则' } }));
    assert.equal(followup.routing.retrievalQuery, '公司婚假制度对实习生的适用规则');
    assert.equal(followup.modelCalls, 1);
});

test('语义指明需要知识依据后，旧关键词入口和学习层不能丢弃检索', async () => {
    const resolved = await resolveChatIntent(input, modelDeps(decision));
    const router = createSemanticRouter({ getChatAutoRouteConfig: () => ({ enabled: true, autoRagEnabled: true, autoToolDiscoveryEnabled: true,
        maxToolCandidates: 8, maxCollections: 2, toolThreshold: 0.5 }), getEmbeddingConfig: () => ({}), recordChatRouteMetric() {},
        resolveBusinessDecision: async request => ({ selectedActionId: 'skip', context: { candidates: request.candidates }, policy: { applied: true, confidence: 1, reasonCode: 'test' } }) });
    const plan = await router.resolveRoutePlan({ prompt: input.prompt, user, state: { ragEnabled: true, ragPreference: 'auto', intentDecision: resolved } });
    assert.equal(plan.execution.rag.shouldRetrieve, true);
    const blocked = await router.resolveRoutePlan({ prompt: input.prompt, user, state: { ragEnabled: false, intentDecision: resolved } });
    assert.equal(blocked.execution.rag.shouldRetrieve, false, '语义判断不能重新开启用户关闭的知识库许可');
});

test('关闭自动任务仍理解业务问题，但不能因模型建议自动创建或续接运行', async () => {
    let called = false;
    const result = await decideAutomaticChatExecution({ ...input, userId: 9, modelContent: input.prompt, sessionsRepository: { listMessages: async () => [] } }, {
        getConversationTasks: async () => [], retrieveLongTermMemories: async () => [], getChatCapabilityAvailability: async () => ({ tools: [] }),
        resolveChatIntent: async value => { called = true; assert.equal(value.executionAllowed, false); return resolveChatIntent(value, modelDeps({ ...decision, action: 'agent_run' })); }
    });
    assert.equal(called, true);
    assert.equal(result.action, 'direct_answer');
    assert.equal(result.reasonCode, 'execution_not_enabled');
    assert.equal(result.routing.tools, 'none');
});

test('短只读查询可自动规划已有权限的能力，不能自动纳入写入、审批和非幂等工具', async () => {
    const raw = { ...decision, objective: '核对昨天的销售数据', requiredCapabilities: ['data.query'], routing: { knowledge: 'none', tools: 'read_only' } };
    const resolved = await resolveChatIntent({ ...input, prompt: '帮我看看昨天卖得怎么样' }, modelDeps(raw));
    const state = { mcpEnabled: false, ragEnabled: true };
    applyAutomaticExecutionDecision(state, resolved);
    assert.equal(state.mcpEnabled, true);
    assert.equal(resolved.sourceMessageId, 11);
    const tool = { name: 'db.run_readonly_query', source: 'mcp', capabilities: ['data.query'], idempotent: true, risk: 'low', input_schema: { type: 'object' } };
    assert.equal(isAutomaticReadTool(tool, state.automaticReadCapabilities), true);
    for (const other of [{ ...tool, side_effect: true }, { ...tool, approval_required: true }, { ...tool, idempotent: false }, { ...tool, capabilities: ['filesystem.write_workspace'] }]) {
        assert.equal(isAutomaticReadTool(other, state.automaticReadCapabilities), false);
    }
    const run = { metadata: { capabilityConstraints: { present: true, readOnly: true, capabilities: ['data.query'] } } };
    const changed = evaluateToolPolicy({ run, user, tool: { ...tool, side_effect: true }, input: {} });
    assert.equal(changed.decision, 'denied', '执行前契约变化后仍必须拒绝写入');
    assert.ok(changed.reasonCodes.includes('conversation_readonly_scope'));
});

test('业务来源必须来自本人可见目录，多来源不能凭默认排序猜测', () => {
    const availability = { tools: [1, 2].map(id => ({ name: `mcp.${id}.db.query`, capabilities: ['data.query'], readOnly: true })) };
    const raw = { ...decision, requiredCapabilities: ['data.query'], routing: { knowledge: 'none', tools: 'read_only' } };
    const context = { baseline: {}, tasks: [], history: [], userMessageId: 11, availability };
    assert.equal(normalizeIntent(raw, context).action, 'clarify');
    const targeted = normalizeIntent({ ...raw, routing: { ...raw.routing, toolNames: ['mcp.1.db.query'] } }, context);
    assert.equal(targeted.action, 'direct_answer');
    assert.deepEqual(targeted.routing.toolNames, ['mcp.1.db.query']);
    assert.throws(() => normalizeIntent({ ...raw, routing: { ...raw.routing, toolNames: ['mcp.999.db.query'] } }, context));
});

test('能力目录必须先按用户权限过滤，模型只看到受限元数据', async () => {
    const result = await getChatCapabilityAvailability(user, { listCachedMcpTools: async () => [{ name: 'secret', description: '不应进入模型' }],
        filterMcpToolsByCapability: async () => [{ name: 'db.query', fullName: 'mcp.1.db.query', capabilities: ['data.query'], description: '查询销售数据', credential: '禁止暴露' }] });
    assert.equal(result.tools[0].name, 'mcp.1.db.query');
    assert.doesNotMatch(JSON.stringify(result), /禁止暴露|不应进入模型|credential/);
});

test('语义服务失败或影子模式不能凭失败结果启动工具和任务', async () => {
    const failed = await resolveChatIntent(input, { ...modelDeps(null), callModelJson: async () => { throw Error('暂不可用'); } });
    assert.equal(failed.action, 'direct_answer');
    assert.equal(failed.capabilityDecisionUnavailable, true);
    assert.equal(failed.routing, undefined);
    const shadow = await resolveChatIntent(input, { ...modelDeps(decision), config: { mode: 'shadow', timeoutMs: 1000, rolloutPercent: 100 } });
    const state = { mcpEnabled: false, ragEnabled: true };
    applyAutomaticExecutionDecision(state, shadow);
    assert.equal(state.routeOverrides, undefined);
    assert.equal(state.mcpEnabled, false);
});

test('检索纠正不暂停或清空任务能力，撤销执行授权才暂停', async () => {
    for (const prompt of ['应该查知识库', '不用知识库']) {
        const order = [];
        const result = await decideAutomaticChatExecution({ ...input, modelContent: prompt, userId: 9, sessionsRepository: { listMessages: async () => [] } }, {
            getConversationTasks: async () => [{ id: 'r', active: true }],
            updateMetadata: async (id, patch) => { const updated = patch({ capabilityConstraints: { capabilities: ['data.query'] } }); assert.deepEqual(updated.capabilityConstraints.capabilities, ['data.query']); order.push('metadata'); },
            sendAgentControlMessage: async () => { order.push('steer'); }, pauseAgentRun: async () => { throw Error('检索调整不能暂停任务'); }, recordChatRouteCorrection: async () => []
        });
        assert.equal(result.reasonCode, 'natural_route_correction');
        assert.deepEqual(order, ['metadata', 'steer']);
        assert.deepEqual(result.correction.pausedRunIds, []);
    }
    assert.equal(detectChatRouteCorrection('我只是问一下，不需要执行').pauseExecution, true);
    const denied = evaluateToolPolicy({ run: { metadata: { capabilityConstraints: { excludeKnowledge: true } } }, user,
        tool: { name: 'knowledge.search', capabilities: ['knowledge.search'], idempotent: true, input_schema: { type: 'object' } }, input: {} });
    assert.ok(denied.reasonCodes.includes('conversation_knowledge_excluded'));
});

test('档案与记忆统一按范围和最新明确设置处理冲突，不把默认值视作用户设置', () => {
    const profile = { communicationStyle: { verbosity: 'balanced', language: 'zh-CN', format: 'structured' }, communicationStyleUpdatedAt: '2026-10-19T09:00:00Z' };
    const older = { id: 1, type: 'preference', scope: 'user', content: '回答简短', updatedAt: '2026-10-18T00:00:00Z' };
    const scoped = { id: 2, type: 'preference', scope: 'session', content: '回答详细', updatedAt: '2026-10-17T00:00:00Z' };
    assert.equal(resolveResponsePreferences(profile, [older]).memories.length, 0);
    const session = resolveResponsePreferences(profile, [older, scoped]);
    assert.equal(session.profile.communicationStyle.verbosity, 'detailed');
    assert.deepEqual(session.memories.map(item => item.id), [2]);
    assert.equal(resolveResponsePreferences({ ...profile, communicationStyleUpdatedAt: null }, [older]).profile.communicationStyle.verbosity, 'concise');
    const newer = { ...older, updatedAt: '2026-10-20T00:00:00Z' };
    assert.equal(resolveResponsePreferences(profile, [newer]).profile.communicationStyle.verbosity, 'concise');
});

test('PostgreSQL 保存沟通偏好的独立更新时间，后续称呼变更不冒充表达偏好更新', async () => {
    const { queryOne, execute } = require('../server/db/client');
    const { getAgentProfile, updateAgentProfile } = require('../server/services/agent-profile');
    const actor = await queryOne('INSERT INTO users (username,password_hash,role,created_at) VALUES (?,?,?,NOW()) RETURNING id', [`preference-${process.pid}-${Date.now()}`, 'test-hash', 'user']);
    const original = await getAgentProfile(actor.id);
    assert.equal(original.communicationStyleUpdatedAt, null);
    const changed = await updateAgentProfile(actor.id, { communicationStyle: { ...original.communicationStyle, verbosity: 'concise' } }, { expectedVersion: original.version });
    assert.ok(changed.communicationStyleUpdatedAt);
    await execute('UPDATE agent_profile_versions SET created_at = ? WHERE user_id = ? AND version = ?', ['2026-10-18 09:00:00', actor.id, changed.version]);
    const renamed = await updateAgentProfile(actor.id, { displayName: '回归用户' }, { expectedVersion: changed.version });
    assert.equal(new Date(renamed.communicationStyleUpdatedAt).getDate(), 18);
    const effective = resolveResponsePreferences(renamed, [{ id: 100, type: 'preference', scope: 'user', content: '以后回答详细', updatedAt: '2026-10-19T00:00:00Z' }]);
    assert.equal(effective.profile.communicationStyle.verbosity, 'detailed');
    const { upsertMemory } = require('../server/services/long-term-memory');
    const remembered = await upsertMemory(actor.id, { type: 'preference', scope: 'user', content: '用户偏好回答详细',
        factKey: 'preference:answer:verbosity', origin: 'explicit', assertedBy: 'user', salience: 0.9, confidence: 1 }, { user: actor, skipEmbedding: true });
    const runId = `preference-run-${actor.id}`;
    await execute('INSERT INTO agent_runs (id,user_id,goal,status,metadata,created_at,updated_at) VALUES (?,?,?,? ,?::jsonb,NOW(),NOW())', [runId, actor.id, '回答一个工作问题', 'planning', '{}']);
    const run = { id: runId, user_id: actor.id, goal: '回答一个工作问题', metadata: {} };
    const { resolveRunLongTermMemory } = require('../server/services/agent-runtime/run-memory');
    const errors = [];
    const runtime = await resolveRunLongTermMemory({ run, user: actor, modelCfg: {}, logger: { warn: (...args) => errors.push(args) } });
    assert.match(runtime.longTermMemoryContext, /用户偏好回答详细/);
    assert.match(run.metadata.agentProfileContext, /详略=detailed/);
    assert.equal(errors.length, 0);
    const saved = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId]);
    assert.ok(saved.metadata.memoryUsage.memoryIds.includes(remembered.id));
});
