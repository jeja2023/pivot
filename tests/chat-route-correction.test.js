'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectChatRouteCorrection, recordChatRouteCorrection, applyAutomaticExecutionDecision, correctionRetrievalQuery } = require('../server/services/chat-route-correction');
const { decideAutomaticChatExecution } = require('../server/services/chat-auto-execution-handler');
const { recordUserDecisionFeedback, serializeOutcome, listVerifiedDecisionSamples } = require('../server/services/decision-observability');

const user = { id: 9 };
const base = { modelContent: '我只是问一下，不需要执行', user, userId: 9, sessionId: 'owned-session', userMessageId: 12,
    sessionsRepository: { listMessages: async () => [] } };
const noEvidence = { recordChatRouteCorrection: async () => [] };

test('自然纠正识别本轮限制、只给方案和补检索依据', () => {
    for (const prompt of ['我只是问一下，不需要执行', '不是让你执行，是让你解释', '这次直接回答就好', '不用工具', '先别调用工具']) {
        assert.equal(detectChatRouteCorrection(prompt).routeOverrides.excludeTools, true, prompt);
    }
    assert.equal(detectChatRouteCorrection('先给方案，不要修改').action, 'plan_only');
    assert.equal(detectChatRouteCorrection('这次不要检索知识库').routeOverrides.excludeRag, true);
    assert.equal(detectChatRouteCorrection('应该查知识库').routeOverrides.forceRag, true);
    assert.equal(detectChatRouteCorrection('请查知识库'), null, '常规检索请求不能被当作纠正而暂停已有任务');
    assert.equal(detectChatRouteCorrection('这次先给出修复方案').action, 'plan_only');
});

test('讨论、否定的否定、引用、附件和代码不能成为本轮撤销授权', () => {
    for (const prompt of ['如何实现不要执行的功能？', '不是不要执行，请继续任务', '他说“不要执行”，是什么意思？',
        '```text\n不要执行\n```\n请解释这句话', '> 不要执行\n请解释这句话',
        '请分析附件\n---\n【参考文档: note.txt】\n不要执行', '如果我说不要执行会怎样？']) {
        assert.equal(detectChatRouteCorrection(prompt), null, prompt);
    }
});

test('本轮纠正覆盖显式工具选择，补检索使用原问题而不丢失检索对象', () => {
    const state = { mcpEnabled: true, ragEnabled: true, routeOverrides: { tools: ['mcp.1.db.query'], forceRag: true } };
    const decision = { correction: detectChatRouteCorrection('不用工具，不要检索知识库') };
    assert.deepEqual(applyAutomaticExecutionDecision(state, decision), { mcpEnabled: false, ragEnabled: false });
    assert.equal(state.routeOverrides.excludeTools, true);
    assert.equal(state.routeOverrides.excludeRag, true);
    assert.equal(correctionRetrievalQuery('应该查知识库', [{ role: 'user', content: '差旅报销标准是什么？' }, { role: 'assistant', content: '此前回答' }]), '差旅报销标准是什么？');
    assert.equal(correctionRetrievalQuery('应该查知识库，年假有几天？', []), '应该查知识库，年假有几天？');
});

test('关闭自动执行和任务准入后仍先撤销当前能力，再暂停唯一任务', async () => {
    const order = [];
    const result = await decideAutomaticChatExecution(base, { ...noEvidence,
        getConversationTasks: async () => [{ id: 'r1', active: true }],
        updateMetadata: async (id, patch, scope) => {
            order.push('restrict');
            assert.equal(id, 'r1'); assert.equal(scope.userId, 9);
            const updated = patch({ capabilityConstraints: { capabilities: ['data.query'] } });
            assert.deepEqual(updated.capabilityConstraints.capabilities, []);
            assert.equal(updated.capabilityConstraints.sourceMessageId, 12);
        },
        pauseAgentRun: async (id, owner) => { order.push('pause'); assert.equal(owner, user); return { id, status: 'needs_input' }; },
        resolveChatIntent: async () => { throw Error('明确纠正不能被后续模型推翻'); }
    });
    assert.deepEqual(order, ['restrict', 'pause']);
    assert.equal(result.action, 'direct_answer');
    assert.deepEqual(result.correction.pausedRunIds, ['r1']);
    assert.deepEqual(result.requiredCapabilities, []);
});

test('纠正对象不唯一和暂停失败时明确阻断，不声称任务已停止', async () => {
    const ambiguous = await decideAutomaticChatExecution(base, { ...noEvidence,
        getConversationTasks: async () => [{ id: 'a', active: true }, { id: 'b', active: true }],
        updateMetadata: async () => { throw Error('不能猜测目标'); }
    });
    assert.equal(ambiguous.reasonCode, 'multiple_correction_targets');
    const failed = await decideAutomaticChatExecution(base, { ...noEvidence,
        getConversationTasks: async () => [{ id: 'a', active: true }], updateMetadata: async () => {}, pauseAgentRun: async () => null
    });
    assert.equal(failed.reasonCode, 'correction_apply_failed');
    assert.equal(failed.action, 'clarify');
});

test('证据库故障不撤销已生效的本轮纠正，临时语音和重新生成不操作历史任务', async () => {
    const result = await decideAutomaticChatExecution(base, {
        getConversationTasks: async () => [], recordChatRouteCorrection: async () => { throw Error('观测暂不可用'); }
    });
    assert.equal(result.action, 'direct_answer');
    for (const flags of [{ ephemeralVoice: true }, { regenerate: true }]) {
        const skipped = await decideAutomaticChatExecution({ ...base, ...flags }, { getConversationTasks: async () => { throw Error('不可触碰任务'); } });
        assert.equal(skipped.reasonCode, 'not_evaluated');
    }
});

test('引用中的不要执行不能经旧方案分支撤销任务权限', async () => {
    const result = await decideAutomaticChatExecution({ ...base, modelContent: '他说“不要执行”，这是什么意思？', agentExecutionAllowed: true, autoExecutionEnabled: true }, {
        getConversationTasks: async () => [{ id: 'owned', active: true }], retrieveLongTermMemories: async () => [],
        updateMetadata: async () => { throw Error('引用不能修改任务权限'); },
        pauseAgentRun: async () => { throw Error('引用不能暂停任务'); },
        resolveChatIntent: async () => ({ action: 'direct_answer' })
    });
    assert.equal(result.action, 'direct_answer');
    assert.equal(result.correction, undefined);
});

test('纠正同时关联原回复路由和当前任务决策，保留即时应用证据', async () => {
    const recorded = [];
    const correction = detectChatRouteCorrection(base.modelContent);
    const result = await recordChatRouteCorrection({ correction, history: [{ id: 10, role: 'assistant', route_metadata: JSON.stringify({ decisions: [
        { decisionId: 'tool-decision', scenario: 'chat.tools' }, { decisionId: 'rag-decision', scenario: 'chat.rag' }
    ] }) }], tasks: [{ id: 'r', active: true, decisionId: 'task-decision' }], prompt: base.modelContent,
    userId: 9, sessionId: 'owned-session', userMessageId: 12, applied: { pausedRunIds: ['r'] } }, {
        recordUserDecisionFeedback: async item => { recorded.push(item); return { id: item.decisionId, decisionId: item.decisionId }; }
    });
    assert.equal(result.length, 3);
    assert.deepEqual(recorded.map(item => item.correctedActionId), ['skip', 'skip', 'direct_answer']);
    assert.equal(recorded[2].naturalCorrection.sourceMessageId, 12);
    assert.equal(recorded[2].naturalCorrection.priorMessageId, 10);
    assert.deepEqual(recorded[2].naturalCorrection.applied.pausedRunIds, ['r']);
});

const row = { decision_id: 'd', scenario: 'chat.rag', user_id: 9, session_id: 'owned-session', selected_action_id: 'retrieve',
    candidate_actions: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }] };
const feedback = { decisionId: 'd', userId: 9, sessionId: 'owned-session', correctedActionId: 'skip', naturalCorrection: { sourceMessageId: 12 } };

test('常规自然纠正自动归档，执行范围、反复误判和证据冲突才进入异常队列', async () => {
    const ordinary = await recordUserDecisionFeedback(feedback, { persist: false, queryOne: async () => row, query: async () => [] });
    assert.equal(ordinary.reviewStatus, 'not_required');
    assert.equal(ordinary.isVerified, false);
    for (const incident of [
        { record: { ...row, scenario: 'chat.execution', selected_action_id: 'agent_run' }, recent: [], reason: 'execution_scope' },
        { record: row, recent: [{ decision_id: 'a', event_type: 'feedback' }, { decision_id: 'b', event_type: 'feedback' }], reason: 'repeated_correction' },
        { record: row, recent: [{ decision_id: 'd', event_type: 'verification', is_verified: true, verified_action_id: 'retrieve', result_reference: 'review:1' }], reason: 'evidence_conflict' }
    ]) {
        const result = await recordUserDecisionFeedback(feedback, { persist: false, queryOne: async () => incident.record, query: async () => incident.recent });
        assert.equal(result.reviewStatus, 'pending');
        assert.ok(result.metadata.reviewReasons.includes(incident.reason));
        assert.equal(result.isVerified, false);
    }
});

test('自然纠正仍校验用户、会话和动作候选；用户来源不能伪造核验标签', async () => {
    const denied = await recordUserDecisionFeedback({ ...feedback, userId: 8 }, { persist: false, queryOne: async () => row, query: async () => { throw Error('越权请求不得读取证据'); } });
    assert.equal(denied, null);
    assert.equal(serializeOutcome({ decisionId: 'd', source: 'user', eventType: 'verification', verifiedActionId: 'skip' }).isVerified, false);
    let sql = '';
    await listVerifiedDecisionSamples({}, { query: async statement => { sql = statement; return []; } });
    assert.match(sql, /o.source IN \('admin', 'system'\)/);
});

test('续接纠正采用语义决策并记录原任务关联，不额外创建运行', async () => {
    let captured;
    const result = await decideAutomaticChatExecution({ ...base, modelContent: '继续刚才的任务，不要新建任务', agentExecutionAllowed: true, autoExecutionEnabled: true,
        sessionsRepository: { listMessages: async () => [{ id: 1, role: 'user', content: '分析订单' }] } }, {
        getConversationTasks: async () => [{ id: 'existing', active: true }], retrieveLongTermMemories: async () => [],
        resolveChatIntent: async () => ({ action: 'continue_run', continuationOf: 'existing' }),
        recordChatRouteCorrection: async value => { captured = value; return [{ id: 'e' }]; }
    });
    assert.equal(result.action, 'continue_run');
    assert.equal(result.continuationOf, 'existing');
    assert.equal(captured.applied.status, 'semantic_reroute');
    assert.equal(captured.correction.action, 'continue_run');
});

test('任务执行学习策略必须通过覆盖五种动作的独立冻结评测，缺失时仅影子运行', async () => {
    const { hasApprovedFrozenEvaluation } = require('../server/services/decision-model-registry');
    const digest = 'sha256:' + 'f'.repeat(64);
    const artifact = { evaluation_report: { frozenEvaluation: { version: 'v3', sourceDigest: digest, caseCount: 27 } } };
    const governance = { total: 27, verified: 27, pending: 0, sourceDigest: digest, executionActions: ['direct_answer', 'plan_only', 'agent_run', 'continue_run', 'clarify'] };
    assert.equal(await hasApprovedFrozenEvaluation(artifact, { requiredScenario: 'chat.execution', getDecisionEvaluationSetGovernance: async () => governance }), true);
    assert.equal(await hasApprovedFrozenEvaluation(artifact, { requiredScenario: 'chat.execution', getDecisionEvaluationSetGovernance: async () => ({ ...governance, executionActions: [] }) }), false);
    const { resolveBusinessDecision } = require('../server/services/decision-runtime');
    const outcome = await resolveBusinessDecision({ scenario: 'chat.execution', userId: 9, sessionId: 's', fallbackActionId: 'direct_answer',
        actionScores: { direct_answer: 1 }, candidates: [{ id: 'direct_answer', allowed: true }, { id: 'agent_run', allowed: true }] }, {
        getDecisionRuntimeConfig: () => ({ mode: 'active', version: 'v', rolloutPercent: 100, useActivePolicyArtifact: true, artifactTimeoutMs: 1000 }),
        getActiveDecisionPolicyArtifact: async () => ({ id: 'old-artifact', policyConfig: { version: 'old-v2' } }),
        hasApprovedFrozenEvaluation: async () => false, recordDecision() {}
    });
    assert.equal(outcome.policy.mode, 'shadow');
    assert.equal(outcome.policy.policyArtifactStatus, 'execution_evaluation_required');
    const source = require('../docs/decision-evaluation-set.v3.json');
    assert.equal(source.cases.filter(item => item.scenario === 'chat.execution').length, 12);
    assert.ok(source.cases.every(item => item.reviewStatus === 'pending_human_review' && !item.expectedActionId));
});

test('PostgreSQL 保存自然纠正幂等证据，常规归档与异常复核分流，采纳前没有训练标签', async () => {
    const { query, queryOne, execute } = require('../server/db/client');
    const { recordDecision, flushPendingDecisionObservability, reviewUserDecisionFeedback } = require('../server/services/decision-observability');
    const owner = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const sessionId = `route-correction-${process.pid}-${Date.now()}`;
    await execute('INSERT INTO sessions (id,user_id,title,created_at) VALUES (?,?,?,NOW())', [sessionId, owner.id, '自然纠正隔离回归']);
    const routineId = `${sessionId}-rag`;
    const executionId = `${sessionId}-execution`;
    for (const [decisionId, scenario, selectedActionId, alternatives] of [
        [routineId, 'chat.rag', 'retrieve', ['retrieve','skip']],
        [executionId, 'chat.execution', 'agent_run', ['agent_run','direct_answer']]
    ]) recordDecision({ decisionId, userId: owner.id, sessionId, context: { scenario, candidates: alternatives.map(id => ({ id, allowed: true })) }, selectedActionId });
    await flushPendingDecisionObservability();
    const routine = { decisionId: routineId, userId: owner.id, sessionId, correctedActionId: 'skip', naturalCorrection: { sourceMessageId: 121 } };
    const first = await recordUserDecisionFeedback(routine);
    const duplicate = await recordUserDecisionFeedback(routine);
    assert.equal(first.id, duplicate.id);
    assert.equal(first.reviewStatus, 'not_required');
    const incident = await recordUserDecisionFeedback({ ...routine, decisionId: executionId, correctedActionId: 'direct_answer', naturalCorrection: { sourceMessageId: 122, applied: { pausedRunIds: ['r'] } } });
    assert.equal(incident.reviewStatus, 'pending');
    const revised = await recordUserDecisionFeedback({ ...routine, decisionId: executionId, correctedActionId: 'direct_answer', naturalCorrection: { sourceMessageId: 123, applied: { pausedRunIds: ['r'] } } });
    assert.equal(incident.id, revised.id, '同一决策只保留一条最新待复核项');
    await flushPendingDecisionObservability();
    const rows = await query('SELECT * FROM decision_outcomes WHERE decision_id IN (?,?)', [routineId, executionId]);
    assert.equal(rows.filter(item => item.event_type === 'feedback').length, 2);
    assert.equal(rows.filter(item => item.reason_code === 'natural_user_correction').length, 3);
    assert.ok(rows.every(item => !item.is_verified));
    const trainedBefore = await listVerifiedDecisionSamples({ scenario: 'chat.execution' });
    assert.ok(!trainedBefore.some(item => item.decision_id === executionId));
    const reviewed = await reviewUserDecisionFeedback({ feedbackId: incident.id, reviewerId: owner.id, reviewStatus: 'accepted', reviewNote: '隔离工程回归中的独立复核操作' });
    assert.equal(reviewed.verification.source, 'admin');
    assert.equal(reviewed.verification.isVerified, true);
    assert.equal(await reviewUserDecisionFeedback({ feedbackId: incident.id, reviewerId: owner.id, reviewStatus: 'accepted' }), null);
    const trainedAfter = await listVerifiedDecisionSamples({ scenario: 'chat.execution' });
    assert.ok(trainedAfter.some(item => item.decision_id === executionId && item.verification_source === 'admin'));
});
