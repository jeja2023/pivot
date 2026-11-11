'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeDecisionContext, decisionFeatureMap, linearScores, createLinearDecisionProvider, evaluateDecisionProviders } = require('../server/services/decision-provider');
const { recordDecision } = require('../server/services/decision-observability');
const { resolveChatIntent } = require('../server/services/chat-intent-resolver');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const { flushPendingDecisionObservability } = require('../server/services/decision-observability');
const { recordAgentRunOutcome } = require('../server/services/agent-feedback');
const { collectDecisionArtifactMetrics, evaluateDecisionArtifactBreaker } = require('../server/services/decision-artifact-breaker');

test('决策特征经过提供器、持久序列化和重复归一化仍与原始输入一致', async () => {
    const context = { scenario: 'knowledge', taskState: { hash: 'same-task', evidenceNeeds: ['knowledge_base'],
        toolIntent: { requestedCapabilities: ['knowledge.search'] }, constraints: ['只读'], entities: ['制度'], secret: '禁止保存' },
    candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }] };
    const safe = sanitizeDecisionContext(context);
    assert.deepEqual(sanitizeDecisionContext(safe), safe);
    assert.deepEqual(decisionFeatureMap(safe), decisionFeatureMap(context));
    const model = { actionWeights: { retrieve: { bias: -1, features: { 'evidence:knowledge_base': 5 } }, skip: { bias: 0 } } };
    const [output] = await evaluateDecisionProviders({ context, providers: [createLinearDecisionProvider({ model })] });
    assert.deepEqual(output.scores, linearScores(context, model));
    assert.equal(output.selectedActionId, 'retrieve');
    const saved = recordDecision({ decisionId: 'feature-roundtrip', context: safe }, { persist: false });
    assert.equal(saved.requestState.taskHash, 'same-task');
    assert.equal(saved.requestState.constraintCount, 1);
    assert.deepEqual(saved.requestState.requestedCapabilities, ['knowledge.search']);
    assert.equal(JSON.stringify(saved).includes('禁止保存'), false);
});

test('实际学习策略的任务失败进入制品指标且重试投递不增加结果行', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const id = `audit-outcome-${crypto.randomUUID()}`;
    const artifactId = `artifact-${id}`;
    recordDecision({ decisionId: id, userId: user.id, context: { scenario: 'chat.execution', candidates: [{ id: 'agent_run', allowed: true }] },
        policy: { policyArtifactId: artifactId, applied: true }, selectedActionId: 'agent_run' });
    recordDecision({ decisionId: `${id}-shadow`, userId: user.id, context: { scenario: 'chat.execution' },
        policy: { policyArtifactId: artifactId, applied: false } });
    recordDecision({ decisionId: `${id}-intent`, userId: user.id, context: { scenario: 'chat.execution' }, selectedActionId: 'agent_run' });
    await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,metadata) VALUES (?,?,'学习路由','生成报告','error',?::jsonb)",
        [id, user.id, JSON.stringify({ automaticExecution: { decisionId: id, intentDecisionId: `${id}-intent` }, taskVerification: { outcomeStatus: 'needs_input' } })]);
    try {
        await recordAgentRunOutcome(id, 'error'); await recordAgentRunOutcome(id, 'error');
        await flushPendingDecisionObservability();
        const metrics = await collectDecisionArtifactMetrics({ id: artifactId, provider_id: 'decision-policy' }, 30);
        assert.equal(metrics.samples, 2); assert.equal(metrics.executionSamples, 1); assert.equal(metrics.executionFailures, 1);
        assert.equal(evaluateDecisionArtifactBreaker({ minSamples: 1, maxProviderErrorRate: 1, maxExecutionFailureRate: 0.2 }, metrics).tripped, true);
        assert.equal(Number((await queryOne('SELECT COUNT(*) AS count FROM decision_outcomes WHERE decision_id=?', [id])).count), 1);
        assert.equal(Number((await queryOne('SELECT COUNT(*) AS count FROM decision_outcomes WHERE decision_id=?', [`${id}-intent`])).count), 1);
    } finally {
        await execute('DELETE FROM decision_outcomes WHERE decision_id IN (?,?)', [id, `${id}-intent`]);
        await execute('DELETE FROM decision_records WHERE decision_id IN (?,?,?)', [id, `${id}-shadow`, `${id}-intent`]);
        await execute('DELETE FROM agent_runs WHERE id=?', [id]);
    }
});

test('实际生效的学习路由成为结果主身份，影子建议保留独立身份', async () => {
    const raw = { action: 'agent_run', objective: '读取资料并生成文件', requiredCapabilities: ['artifact.deliver'],
        constraints: [], routing: { knowledge: 'none', tools: 'task' }, acceptance: {}, evidenceRefs: ['current_message'] };
    for (const applied of [true, false]) {
        const result = await resolveChatIntent({ prompt: '读取资料并生成文件', history: [], tasks: [], user: { id: 9 }, userMessageId: 11, sessionId: 'audit-route', availability: { tools: [] } }, {
            config: { mode: 'active', timeoutMs: 2000, rolloutPercent: 100 }, recordDecision() {},
            callModelJson: async () => raw,
            resolveBusinessDecision: async () => ({ decisionId: 'learned-effective', selectedActionId: 'agent_run', policy: { applied } })
        });
        assert.equal(result.action, 'agent_run');
        assert.equal(result.learningApplied, applied);
        assert.equal(result.learningDecisionId, 'learned-effective');
        assert.equal(result.decisionId === 'learned-effective', applied);
        assert.match(result.intentDecisionId, /^chat_intent_/);
    }
});
