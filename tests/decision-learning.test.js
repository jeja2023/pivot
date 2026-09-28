const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createHttpDecisionProvider,
    createScoreDecisionProvider,
    evaluateDecisionProviders,
    sanitizeDecisionContext
} = require('../server/services/decision-provider');
const { applyDecisionPolicy } = require('../server/services/decision-policy');
const { resolveBusinessDecision } = require('../server/services/decision-runtime');
const { flushPendingDecisionObservability, getDecisionOperationalMetrics, listVerifiedDecisionSamples, recordDecision, recordDecisionOutcome, recordUserDecisionFeedback } = require('../server/services/decision-observability');
const { getDecisionPreference, saveDecisionPreference } = require('../server/services/decision-preferences');
const {
    buildVerifiedDecisionDataset,
    evaluateDecisionReleaseGate,
    evaluateDecisionSamples,
    splitDecisionDatasetByTime
} = require('../server/services/decision-learning');

test('统一决策器只接收脱敏状态和允许动作，并拒绝未知动作输出', async () => {
    const context = sanitizeDecisionContext({
        decisionId: 'decision_test',
        scenario: 'chat.rag',
        tenantId: 8,
        taskState: {
            hash: 'task-hash',
            currentQuestion: '这段原文不应进入决策器',
            evidenceNeeds: ['knowledge_base'],
            toolIntent: { requestedCapabilities: ['data.query'] },
            constraints: ['不得泄露原文']
        },
        candidates: [
            { id: 'retrieve', description: '检索可访问知识库' },
            { id: 'skip', description: '不检索' }
        ]
    });
    assert.equal(JSON.stringify(context).includes('这段原文不应进入决策器'), false);
    const [result] = await evaluateDecisionProviders({
        context,
        providers: [createScoreDecisionProvider({
            id: 'baseline',
            scores: { retrieve: 0.82, injected_action: 1 },
            selectedActionId: 'injected_action'
        })]
    });
    assert.equal(result.selectedActionId, 'retrieve');
    assert.equal(result.scores.injected_action, undefined);
});

test('策略层默认影子模式且高风险、需审批动作不会自动采用', () => {
    const candidates = [
        { id: 'safe', description: '安全动作' },
        { id: 'approve', description: '需审批动作', risk: 'high', requiresApproval: true }
    ];
    const outputs = [{ providerId: 'laya', weight: 1, selectedActionId: 'approve', scores: { safe: 0.1, approve: 0.99 } }];
    const shadow = applyDecisionPolicy({ candidates, providerOutputs: outputs, fallbackActionId: 'safe' });
    assert.equal(shadow.mode, 'shadow');
    assert.equal(shadow.selectedActionId, 'safe');
    assert.equal(shadow.reasonCode, 'shadow_mode');
    const active = applyDecisionPolicy({ candidates, providerOutputs: outputs, fallbackActionId: 'safe', config: { mode: 'active' } });
    assert.equal(active.selectedActionId, 'safe');
    assert.equal(active.reasonCode, 'approval_required');
});

test('内网 Laya 超时不会影响已有决策基线', async () => {
    const provider = createHttpDecisionProvider({
        url: 'http://laya.intranet/decision',
        timeoutMs: 20,
        fetchFn: async (_url, { signal }) => await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    });
    const [result] = await evaluateDecisionProviders({
        context: { candidates: [{ id: 'retrieve', description: '检索' }, { id: 'skip', description: '跳过' }] },
        providers: [provider]
    });
    assert.equal(result.error, 'provider_timeout');
    assert.equal(result.selectedActionId, 'retrieve');
});

test('统一运行时默认影子模式，记录建议但保持既有选择', async () => {
    const decisions = [];
    const result = await resolveBusinessDecision({
        scenario: 'chat.rag',
        taskState: { currentQuestion: '根据制度说明报销', hash: 't1', evidenceNeeds: ['knowledge_base'] },
        candidates: [{ id: 'retrieve', description: '检索' }, { id: 'skip', description: '跳过' }],
        fallbackActionId: 'retrieve',
        actionScores: { retrieve: 0.1, skip: 0.9 },
        env: {}
    }, {
        getDecisionRuntimeConfig: () => ({
            mode: 'shadow', version: 'policy-test', autoThreshold: 0.5, highRiskThreshold: 0.8,
            calibrationScale: 1, calibrationIntercept: 0,
            laya: { enabled: false, url: '', version: '', timeoutMs: 100, weight: 1 }
        }),
        recordDecision: value => decisions.push(value)
    });
    assert.equal(result.policy.suggestedActionId, 'skip');
    assert.equal(result.selectedActionId, 'retrieve');
    assert.equal(decisions.length, 1);
});

test('决策与结果异步持久化，不保存请求原文', async () => {
    const decision = recordDecision({
        decisionId: 'decision_observe_test',
        context: {
            decisionId: 'decision_observe_test', scenario: 'chat.rag',
            taskState: { hash: 'h1', currentQuestion: '不应持久化的提问原文' },
            candidates: [{ id: 'retrieve', description: '检索' }, { id: 'skip', description: '跳过' }]
        },
        userId: 7,
        sessionId: 's1',
        providerOutputs: [{ providerId: 'baseline', scores: { retrieve: 0.8, skip: 0.2 } }],
        policy: { selectedActionId: 'retrieve', confidence: 0.8, mode: 'shadow' },
        selectedActionId: 'retrieve'
    });
    const outcome = recordDecisionOutcome({ decisionId: decision.decisionId, eventType: 'verification', source: 'admin', status: 'success', selectedActionId: 'retrieve', verifiedActionId: 'retrieve' });
    const calls = [];
    const flushed = await flushPendingDecisionObservability({ execute: async (sql, params) => calls.push({ sql, params }) });
    assert.deepEqual(flushed, { decisions: 1, outcomes: 1 });
    assert.equal(JSON.stringify(calls).includes('不应持久化的提问原文'), false);
    assert.equal(calls[0].params[0], 'decision_observe_test');
    assert.equal(calls[1].params[1], 'decision_observe_test');
    assert.equal(outcome.isVerified, true);
});

test('评测数据按时间切分，发布门槛拒绝关键场景回退', () => {
    const dataset = buildVerifiedDecisionDataset([
        { decision_id: 'd1', scenario: 'chat.rag', candidate_actions: [{ id: 'retrieve', allowed: true }], policy_outcome: { confidence: 0.9 }, selected_action_id: 'retrieve', verified_action_id: 'retrieve', verified_at: '2026-01-01T00:00:00Z' },
        { decision_id: 'd2', scenario: 'chat.tools', candidate_actions: [{ id: 'propose', allowed: true }], policy_outcome: { confidence: 0.8 }, selected_action_id: 'propose', verified_action_id: 'propose', verified_at: '2026-02-01T00:00:00Z' },
        { decision_id: 'd3', scenario: 'chat.rag', candidate_actions: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }], policy_outcome: { confidence: 0.9 }, selected_action_id: 'retrieve', verified_action_id: 'skip', verified_at: '2026-03-01T00:00:00Z' }
    ]);
    const splits = splitDecisionDatasetByTime(dataset, { trainRatio: 0.34, calibrationRatio: 0.33 });
    assert.equal(splits.train[0].decisionId, 'd1');
    assert.equal(splits.calibration[0].decisionId, 'd2');
    assert.equal(splits.test[0].decisionId, 'd3');
    const candidate = evaluateDecisionSamples(dataset.samples);
    const baseline = { ...candidate, byScenario: { ...candidate.byScenario, 'chat.rag': { ...candidate.byScenario['chat.rag'], accuracy: 1 } } };
    const gate = evaluateDecisionReleaseGate({ candidate, baseline, minimumSamples: 3, criticalScenarios: ['chat.rag'] });
    assert.equal(gate.passed, false);
    assert.ok(gate.reasons.includes('critical_scenario_regression:chat.rag'));
});

test('人工核验只接受当时允许的动作，才能成为训练标签', async () => {
    const { recordVerifiedDecisionOutcome } = require('../server/services/decision-observability');
    const verified = await recordVerifiedDecisionOutcome({
        decisionId: 'decision_verified',
        verifiedActionId: 'skip',
        selectedActionId: 'retrieve',
        status: 'success',
        source: 'admin'
    }, {
        persist: false,
        queryOne: async () => ({ candidate_actions: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }] })
    });
    assert.equal(verified.isVerified, true);
    assert.equal(verified.verifiedActionId, 'skip');
    const rejected = await recordVerifiedDecisionOutcome({ decisionId: 'decision_verified', verifiedActionId: 'unknown' }, {
        persist: false,
        queryOne: async () => ({ candidate_actions: [{ id: 'retrieve', allowed: true }] })
    });
    assert.equal(rejected, null);
});

test('active 模式仅在稳定灰度范围内改变路由，并支持租户和场景回退', () => {
    const { isDecisionActiveForScope } = require('../server/services/decision-runtime');
    const config = { mode: 'active', rolloutPercent: 100, rolloutTenants: ['8'], rolloutScenarios: ['chat.rag'] };
    assert.equal(isDecisionActiveForScope({ config, scenario: 'chat.rag', tenantId: 8, sessionId: 's', userId: 1, decisionId: 'd' }), true);
    assert.equal(isDecisionActiveForScope({ config, scenario: 'chat.tools', tenantId: 8, sessionId: 's', userId: 1, decisionId: 'd' }), false);
    assert.equal(isDecisionActiveForScope({ config, scenario: 'chat.rag', tenantId: 9, sessionId: 's', userId: 1, decisionId: 'd' }), false);
    assert.equal(isDecisionActiveForScope({ config: { ...config, rolloutPercent: 0 }, scenario: 'chat.rag', tenantId: 8, sessionId: 's', userId: 1, decisionId: 'd' }), false);
    const fiftyPercent = { ...config, rolloutPercent: 50 };
    const first = isDecisionActiveForScope({ config: fiftyPercent, scenario: 'chat.rag', tenantId: 8, sessionId: 'stable-session', userId: 1, decisionId: 'first' });
    const second = isDecisionActiveForScope({ config: fiftyPercent, scenario: 'chat.rag', tenantId: 8, sessionId: 'stable-session', userId: 1, decisionId: 'second' });
    assert.equal(first, second);
});

test('用户修正必须与其所属会话和当时允许的动作相匹配，且不会直接成为训练标签', async () => {
    const feedback = await recordUserDecisionFeedback({
        decisionId: 'decision-user-feedback', userId: 8, sessionId: 'session-1', correctedActionId: 'skip', selectedActionId: 'retrieve', status: 'partial'
    }, {
        persist: false,
        queryOne: async () => ({ user_id: 8, session_id: 'session-1', candidate_actions: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }] })
    });
    assert.equal(feedback.eventType, 'feedback');
    assert.equal(feedback.source, 'user');
    assert.equal(feedback.isVerified, false);
    const rejected = await recordUserDecisionFeedback({ decisionId: 'decision-user-feedback', userId: 9, sessionId: 'session-1', correctedActionId: 'skip' }, {
        persist: false,
        queryOne: async () => ({ user_id: 8, session_id: 'session-1', candidate_actions: [{ id: 'skip', allowed: true }] })
    });
    assert.equal(rejected, null);
});

test('决策运行指标聚合提供按提供器的延迟和错误率，不读取请求原文', async () => {
    const calls = [];
    const metrics = await getDecisionOperationalMetrics({ minutes: 30 }, {
        query: async (sql, params) => {
            calls.push({ sql, params });
            return [];
        }
    });
    assert.equal(metrics.minutes, 30);
    assert.equal(calls.length, 3);
    assert.equal(calls.every(call => call.params[0] === 30), true);
    assert.equal(JSON.stringify(calls).includes('用户原文'), false);
});

test('明确偏好立即采用允许动作，但不能绕过审批要求', () => {
    const direct = applyDecisionPolicy({
        candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }],
        providerOutputs: [], fallbackActionId: 'retrieve', explicitActionId: 'skip', preferenceId: 'pref-1', config: { mode: 'shadow' }
    });
    assert.equal(direct.selectedActionId, 'skip');
    assert.equal(direct.applied, true);
    assert.equal(direct.reasonCode, 'explicit_preference');
    const guarded = applyDecisionPolicy({
        candidates: [{ id: 'propose', allowed: true, requiresApproval: true, risk: 'high' }, { id: 'skip', allowed: true }],
        providerOutputs: [], fallbackActionId: 'skip', explicitActionId: 'propose', config: { mode: 'active' }
    });
    assert.equal(guarded.selectedActionId, 'skip');
    assert.equal(guarded.reasonCode, 'explicit_preference_requires_approval');
    const disabled = applyDecisionPolicy({
        candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }],
        providerOutputs: [], fallbackActionId: 'retrieve', explicitActionId: 'skip', config: { mode: 'disabled' }
    });
    assert.equal(disabled.selectedActionId, 'retrieve');
    assert.equal(disabled.reasonCode, 'policy_disabled');
});

test('运行时可读取显式偏好并将其作为可审计策略结果', async () => {
    const result = await resolveBusinessDecision({
        scenario: 'chat.rag', tenantId: 2, userId: 8, taskState: { hash: 'pref-task' },
        candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }], fallbackActionId: 'retrieve', actionScores: { retrieve: 0.9, skip: 0.1 }
    }, {
        getDecisionRuntimeConfig: () => ({
            mode: 'shadow', version: 'policy-pref', autoThreshold: 0.5, highRiskThreshold: 0.8,
            calibrationScale: 1, calibrationIntercept: 0, preferencesEnabled: true,
            light: { enabled: false }, qwen: { enabled: false }, laya: { enabled: false }
        }),
        getDecisionPreference: async () => ({ id: 'pref-8', actionId: 'skip' }),
        recordDecision() {}
    });
    assert.equal(result.selectedActionId, 'skip');
    assert.equal(result.policy.preferenceId, 'pref-8');
});

test('用户级偏好优先于租户级偏好，且保存后可立即替换', async () => {
    const calls = [];
    const preference = await getDecisionPreference({ userId: 8, tenantId: 2, scenario: 'chat.rag' }, {
        queryOne: async (_sql, params) => {
            calls.push(params);
            return { id: 'pref-user', scope: 'user', action_id: 'skip', scenario: 'chat.rag', updated_at: '2026-01-01' };
        }
    });
    assert.equal(preference.actionId, 'skip');
    assert.deepEqual(calls[0], ['chat.rag', 'user:8', 'tenant:2']);
    const writes = [];
    const saved = await saveDecisionPreference({ scope: 'user', userId: 8, scenario: 'chat.rag', actionId: 'retrieve', actorId: 8 }, {
        execute: async (_sql, params) => writes.push(params)
    });
    assert.equal(saved.actionId, 'retrieve');
    assert.equal(writes[0][2], 'user:8');
});

test('训练样本查询只选择有效账号的已核验结果，并可按租户隔离', async () => {
    const calls = [];
    await listVerifiedDecisionSamples({ scenario: 'chat.rag', tenantId: 12, limit: 20 }, {
        query: async (sql, params) => {
            calls.push({ sql, params });
            return [];
        }
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /u.deleted_at IS NULL/);
    assert.match(calls[0].sql, new RegExp("COALESCE\\(u\\.status, 'active'\\) <> 'disabled'"));
    assert.match(calls[0].sql, /d\.tenant_id = \?/);
    assert.deepEqual(calls[0].params, ['chat.rag', 12, 20]);
});

test('disabled 模式不调用 Qwen、Laya 或轻量学习型决策器', async () => {
    let qwenCalls = 0;
    const result = await resolveBusinessDecision({
        scenario: 'chat.rag', taskState: { hash: 'disabled' }, modelCfg: { model_name: 'Qwen3.6-35B' },
        candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }], fallbackActionId: 'retrieve'
    }, {
        getDecisionRuntimeConfig: () => ({
            mode: 'disabled', version: 'disabled', autoThreshold: 0.5, highRiskThreshold: 0.8,
            calibrationScale: 1, calibrationIntercept: 0, preferencesEnabled: false,
            light: { enabled: true }, qwen: { enabled: true, maxTokens: 64, weight: 1 },
            laya: { enabled: true, url: 'http://laya/decision', maxConcurrent: 1, weight: 1 }
        }),
        callModelText: async () => { qwenCalls += 1; return '{}'; },
        loadLocalLinearDecisionModel: async () => { throw new Error('禁用模式不应加载本地线性模型'); },
        recordDecision() {}
    });
    assert.equal(qwenCalls, 0);
    assert.equal(result.selectedActionId, 'retrieve');
    assert.deepEqual(result.providerOutputs.map(item => item.providerId), ['existing-router']);
});

test('评测报告包含动作精确率召回率、修正率、业务完成率与语言拆分', () => {
    const metrics = evaluateDecisionSamples([
        { scenario: 'chat.rag', language: 'zh', selectedActionId: 'retrieve', verifiedActionId: 'retrieve', confidence: 0.9, durationMs: 12, outcomeStatus: 'success' },
        { scenario: 'chat.rag', language: 'zh', selectedActionId: 'skip', verifiedActionId: 'retrieve', confidence: 0.6, durationMs: 18, outcomeStatus: 'partial' },
        { scenario: 'chat.tools', language: 'en', selectedActionId: 'propose', verifiedActionId: 'propose', confidence: 0.8, durationMs: 25, outcomeStatus: 'success' }
    ]);
    assert.equal(metrics.routeCorrectionRate, 1 / 3);
    assert.equal(metrics.verifiedBusinessCompletionRate, 2 / 3);
    assert.equal(metrics.byAction.retrieve.recall, 0.5);
    assert.equal(metrics.byAction.skip.precision, 0);
    assert.equal(metrics.byLanguage.zh.sampleCount, 2);
    assert.equal(metrics.byLanguage.en.accuracy, 1);
});

test('active 灰度只使用已激活策略制品，缺失制品时安全回退影子模式', async () => {
    const common = {
        scenario: 'chat.rag', tenantId: 2, userId: 8, sessionId: 'policy-session',
        taskState: { hash: 'policy-task' },
        candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }],
        fallbackActionId: 'skip', actionScores: { retrieve: 0.9, skip: 0.1 }
    };
    const config = {
        mode: 'active', version: 'policy-v2', autoThreshold: 0.8, highRiskThreshold: 0.9,
        calibrationScale: 1, calibrationIntercept: 0, rolloutPercent: 100, rolloutTenants: [], rolloutScenarios: [],
        requireActiveArtifact: false, useActivePolicyArtifact: true, artifactTimeoutMs: 50, preferencesEnabled: false,
        light: { enabled: false }, qwen: { enabled: false }, laya: { enabled: false }
    };
    const active = await resolveBusinessDecision(common, {
        getDecisionRuntimeConfig: () => config,
        getActiveDecisionPolicyArtifact: async () => ({
            id: 'policy-artifact-2', model_version: 'policy-v2',
            policyConfig: { version: 'policy-v2', autoThreshold: 0.5, highRiskThreshold: 0.9, calibrationScale: 1, calibrationIntercept: 0 }
        }),
        recordDecision() {}
    });
    assert.equal(active.policy.mode, 'active');
    assert.equal(active.selectedActionId, 'retrieve');
    assert.equal(active.policy.policyArtifactId, 'policy-artifact-2');
    const fallback = await resolveBusinessDecision(common, {
        getDecisionRuntimeConfig: () => config,
        getActiveDecisionPolicyArtifact: async () => null,
        recordDecision() {}
    });
    assert.equal(fallback.policy.mode, 'shadow');
    assert.equal(fallback.selectedActionId, 'skip');
    assert.equal(fallback.policy.policyArtifactStatus, 'unavailable');
});

test('Laya 返回权重版本漂移时结果不参与策略融合', async () => {
    const provider = createHttpDecisionProvider({
        url: 'http://laya.intranet/decision',
        version: 'approved-v1',
        fetchFn: async () => ({ ok: true, json: async () => ({ modelVersion: 'unapproved-v2', selectedActionId: 'skip', scores: { retrieve: 0.1, skip: 0.9 } }) })
    });
    const [result] = await evaluateDecisionProviders({
        context: { candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }] },
        providers: [provider]
    });
    assert.equal(result.error, 'provider_version_mismatch');
    assert.equal(result.selectedActionId, 'retrieve');
});

test('内网 Laya HTTP 500 被记录为提供器错误且不改变既有决策', async () => {
    const provider = createHttpDecisionProvider({
        url: 'http://laya.intranet/decision',
        version: 'approved-v1',
        fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) })
    });
    const [result] = await evaluateDecisionProviders({
        context: { candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }] },
        providers: [provider]
    });
    assert.equal(result.error, 'provider_http_500');
    assert.equal(result.selectedActionId, 'retrieve');
});

test('内网 Laya 达到并发上限时保持既有决策并记录限流原因', async () => {
    let resolveFetchStarted;
    let releaseFetch;
    const fetchStarted = new Promise(resolve => { resolveFetchStarted = resolve; });
    const fetchRelease = new Promise(resolve => { releaseFetch = resolve; });
    const config = {
        mode: 'shadow', version: 'policy-v1', autoThreshold: 0.58, highRiskThreshold: 0.85, calibrationScale: 1, calibrationIntercept: 0,
        preferencesEnabled: false, light: { enabled: false }, qwen: { enabled: false },
        laya: { enabled: true, url: 'http://laya.intranet/decision', version: 'approved-v1', timeoutMs: 1000, maxConcurrent: 1, weight: 1 }
    };
    const request = {
        scenario: 'chat.rag', taskState: { hash: 'laya-limit' },
        candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }], fallbackActionId: 'retrieve', actionScores: { retrieve: 0.9, skip: 0.1 }
    };
    const deps = {
        getDecisionRuntimeConfig: () => config,
        fetchFn: async () => { resolveFetchStarted(); await fetchRelease; return { ok: true, json: async () => ({ modelVersion: 'approved-v1', selectedActionId: 'skip', scores: { retrieve: 0.1, skip: 0.9 } }) }; },
        recordDecision() {}
    };
    const first = resolveBusinessDecision(request, deps);
    await fetchStarted;
    const second = await resolveBusinessDecision({ ...request, taskState: { hash: 'laya-limit-second' } }, deps);
    assert.equal(second.selectedActionId, 'retrieve');
    assert.equal(second.providerOutputs.find(item => item.providerId === 'laya').error, 'provider_concurrency_limited');
    releaseFetch();
    await first;
});

test('Laya 未配置审核版本时不会发起网络调用', async () => {
    let calls = 0;
    const result = await resolveBusinessDecision({
        scenario: 'chat.rag', taskState: { hash: 'laya-version-required' },
        candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }], fallbackActionId: 'retrieve', actionScores: { retrieve: 0.9, skip: 0.1 }
    }, {
        getDecisionRuntimeConfig: () => ({
            mode: 'shadow', version: 'policy-v1', autoThreshold: 0.58, highRiskThreshold: 0.85, calibrationScale: 1, calibrationIntercept: 0, preferencesEnabled: false,
            light: { enabled: false }, qwen: { enabled: false },
            laya: { enabled: true, url: 'http://laya.intranet/decision', version: '', timeoutMs: 100, maxConcurrent: 1, weight: 1 }
        }),
        fetchFn: async () => { calls += 1; throw new Error('should_not_call_laya'); },
        recordDecision() {}
    });
    assert.equal(calls, 0);
    assert.equal(result.selectedActionId, 'retrieve');
    assert.equal(result.providerOutputs.find(item => item.providerId === 'laya').error, 'provider_version_not_configured');
});
