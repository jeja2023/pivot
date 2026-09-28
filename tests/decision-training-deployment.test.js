const assert = require('node:assert/strict');
const test = require('node:test');
const { buildDecisionProviderContext, createLinearDecisionProvider, createStructuredModelDecisionProvider, decisionFeatureMap, linearScores, sanitizeDecisionContext } = require('../server/services/decision-provider');
const { trainAndEvaluateLinearDecisionModel, trainLinearDecisionModel } = require('../server/services/decision-training');
const { activateDecisionModelArtifact } = require('../server/services/decision-model-registry');
const { checkLayaDecisionHealth } = require('../server/services/decision-provider-health');
const { benchmarkDecisionProviders } = require('../server/services/decision-benchmark');
const { createScoreDecisionProvider } = require('../server/services/decision-provider');
const { buildLayaDecisionDataset } = require('../server/services/decision-dataset-exporter');
const { computeDecisionModelHash } = require('../server/services/decision-light-model');
const { isLocalLightArtifactEligible } = require('../server/services/decision-runtime');
const { publishedWorkflowCandidates, recommendPublishedWorkflow } = require('../server/services/decision-workflow-recommender');
const { buildRouteMetadata, createSemanticRouter } = require('../server/services/semantic-router');
const { cleanupExpiredDecisionRecords, getDecisionMaintenanceReport } = require('../server/services/decision-maintenance');
const { evaluateDecisionArtifactBreaker, sweepDecisionArtifactBreakers } = require('../server/services/decision-artifact-breaker');
const { loadReviewedDecisionEvaluationCases, reviewDecisionEvaluationCase } = require('../server/services/decision-evaluation-reviews');
const { getDecisionDeploymentReadiness } = require('../server/services/decision-deployment-readiness');

function row(id, at, label, selected = 'skip') {
    return {
        decision_id: id, scenario: 'chat.rag',
        request_state: { status: 'active', evidenceNeeds: ['knowledge_base'], requestedCapabilities: [], constraintCount: 0, entityCount: 0 },
        candidate_actions: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }],
        provider_outputs: [], selected_action_id: selected, verified_action_id: label, verified_at: at
    };
}

test('轻量线性决策器只从脱敏特征计算候选分数', async () => {
    const context = {
        scenario: 'chat.rag',
        taskState: { hash: 't1', evidenceNeeds: ['knowledge_base'], currentQuestion: '不得进入特征的原文' },
        candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }]
    };
    const model = { modelVersion: 'linear-test', actionWeights: { retrieve: { bias: 0, features: { 'evidence:knowledge_base': 4 } }, skip: { bias: 0, features: {} } } };
    const scores = linearScores(context, model);
    assert.ok(scores.retrieve > scores.skip);
    assert.equal(JSON.stringify(decisionFeatureMap(context)).includes('不得进入特征的原文'), false);
    const provider = createLinearDecisionProvider({ model });
    assert.equal((await provider.decide(context)).scores.retrieve > 0.5, true);
});

test('Qwen 结构化决策器固定 JSON、关闭思考且不会采纳未知动作', async () => {
    let options = null;
    const provider = createStructuredModelDecisionProvider({
        modelCfg: { model_name: 'Qwen3.6-35B' },
        invoke: async (_model, _messages, input) => {
            options = input;
            return '{\"selectedActionId\":\"unknown\",\"scores\":{\"retrieve\":0.9,\"unknown\":1}}';
        }
    });
    const result = await provider.decide({ candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }] });
    assert.equal(result.selectedActionId, 'unknown');
    assert.equal(result.scores.unknown, 1);
    assert.equal(options.enableThinking, false);
    assert.equal(options.temperature, 0);
});

test('训练严格按时间切分，输出候选模型、校准结果和发布门槛', () => {
    const rows = [
        row('d1', '2026-01-01T00:00:00Z', 'retrieve'), row('d2', '2026-01-02T00:00:00Z', 'retrieve'),
        row('d3', '2026-01-03T00:00:00Z', 'skip'), row('d4', '2026-01-04T00:00:00Z', 'retrieve'),
        row('d5', '2026-01-05T00:00:00Z', 'skip'), row('d6', '2026-01-06T00:00:00Z', 'retrieve'),
        row('d7', '2026-01-07T00:00:00Z', 'skip'), row('d8', '2026-01-08T00:00:00Z', 'retrieve'),
        row('d9', '2026-01-09T00:00:00Z', 'skip'), row('d10', '2026-01-10T00:00:00Z', 'retrieve')
    ];
    const report = trainAndEvaluateLinearDecisionModel(rows, { split: { trainRatio: 0.6, calibrationRatio: 0.2 }, minimumSamples: 1 });
    assert.deepEqual(report.splitCounts, { train: 6, calibration: 2, test: 2 });
    assert.equal(report.model.providerId, 'light-linear');
    assert.ok(report.calibration.sampleCount > 0);
    assert.equal(typeof report.releaseGate.passed, 'boolean');
    assert.ok(Object.keys(trainLinearDecisionModel([{ context: { candidates: [{ id: 'retrieve', allowed: true }] }, label: 'retrieve' }]).actionWeights).includes('retrieve'));
});

test('模型注册表只激活已通过发布门槛的候选制品', async () => {
    const calls = [];
    const artifact = { id: 'artifact-1', provider_id: 'light-linear', status: 'candidate', evaluation_report: { releaseGate: { passed: true } } };
    const result = await activateDecisionModelArtifact('artifact-1', {
        transaction: async fn => await fn({ queryOne: async () => artifact, execute: async (sql, params) => calls.push({ sql, params }) })
    });
    assert.equal(result.id, 'artifact-1');
    assert.equal(calls.length, 2);
    const blocked = await activateDecisionModelArtifact('artifact-2', {
        transaction: async fn => await fn({ queryOne: async () => ({ ...artifact, evaluation_report: { releaseGate: { passed: false } } }), execute: async () => 0 })
    });
    assert.equal(blocked, null);
});

test('Laya 健康检查在禁用和版本不一致时保持明确状态', async () => {
    assert.equal((await checkLayaDecisionHealth({ env: { PIVOT_LAYA_DECISION_ENABLED: 'false' } })).status, 'ok');
    const mismatch = await checkLayaDecisionHealth({
        env: { PIVOT_LAYA_DECISION_ENABLED: 'true', PIVOT_LAYA_DECISION_URL: 'http://laya/decision', PIVOT_LAYA_DECISION_HEALTH_URL: 'http://laya/healthz', PIVOT_LAYA_DECISION_VERSION: 'approved' },
        fetchFn: async () => ({ ok: true, json: async () => ({ modelVersion: 'other' }) })
    });
    assert.equal(mismatch.status, 'degraded');
    const missingVersion = await checkLayaDecisionHealth({
        env: { PIVOT_LAYA_DECISION_ENABLED: 'true', PIVOT_LAYA_DECISION_URL: 'http://laya/decision', PIVOT_LAYA_DECISION_HEALTH_URL: 'http://laya/healthz', PIVOT_LAYA_DECISION_VERSION: '' }
    });
    assert.equal(missingVersion.status, 'error');
});

test('冻结核验集对所有决策器输入相同脱敏候选并产出可比较指标', async () => {
    const report = await benchmarkDecisionProviders({
        cases: [{
            id: 'verified-case-1', reviewStatus: 'verified', reviewedBy: 'admin', reviewedAt: '2026-01-01T00:00:00Z',
            scenario: 'chat.rag', language: 'zh', taskState: { evidenceNeeds: ['knowledge_base'] },
            candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }], expectedActionId: 'retrieve'
        }],
        providers: [createScoreDecisionProvider({ id: 'baseline', scores: { retrieve: 0.9, skip: 0.1 } })]
    });
    assert.equal(report.evaluationCaseCount, 1);
    assert.equal(report.providers[0].providerId, 'baseline');
    assert.equal(report.providers[0].metrics.accuracy, 1);
});

test('Laya 训练数据导出仅含脱敏状态、允许候选和已核验标签', () => {
    const rows = [
        { decision_id: 'e1', scenario: 'chat.rag', request_state: { taskHash: 'h1', evidenceNeeds: ['knowledge_base'] }, candidate_actions: [{ id: 'retrieve', description: '检索', allowed: true }, { id: 'skip', allowed: true }], verified_action_id: 'retrieve', verified_at: '2026-01-01T00:00:00Z' },
        { decision_id: 'e2', scenario: 'chat.rag', request_state: { taskHash: 'h2', evidenceNeeds: [] }, candidate_actions: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }], verified_action_id: 'skip', verified_at: '2026-01-02T00:00:00Z' },
        { decision_id: 'e3', scenario: 'chat.rag', request_state: { taskHash: 'h3', evidenceNeeds: [] }, candidate_actions: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }], verified_action_id: 'skip', verified_at: '2026-01-03T00:00:00Z' },
        { decision_id: 'e4', scenario: 'chat.rag', request_state: { taskHash: 'h4', evidenceNeeds: ['knowledge_base'] }, candidate_actions: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }], verified_action_id: 'retrieve', verified_at: '2026-01-04T00:00:00Z' }
    ];
    const dataset = buildLayaDecisionDataset(rows, { split: { trainRatio: 0.5, calibrationRatio: 0.25 } });
    assert.equal(dataset.manifest.rawUserTextIncluded, false);
    assert.equal(dataset.manifest.splits.train, 2);
    assert.equal(dataset.manifest.splits.calibration, 1);
    assert.equal(dataset.manifest.splits.test, 1);
    assert.equal(dataset.files.train.includes('用户原文'), false);
    assert.equal(dataset.files.train.includes('"selectedActionId"'), true);
});

test('相同任务哈希不会跨训练、校准和测试分区泄漏', () => {
    const rows = [
        { ...row('l1', '2026-01-01T00:00:00Z', 'retrieve'), request_state: { taskHash: 'same-task', evidenceNeeds: ['knowledge_base'] } },
        { ...row('l2', '2026-01-02T00:00:00Z', 'retrieve'), request_state: { taskHash: 'same-task', evidenceNeeds: ['knowledge_base'] } },
        { ...row('l3', '2026-01-03T00:00:00Z', 'skip'), request_state: { taskHash: 'task-3' } },
        { ...row('l4', '2026-01-04T00:00:00Z', 'retrieve'), request_state: { taskHash: 'task-4' } },
        { ...row('l5', '2026-01-05T00:00:00Z', 'skip'), request_state: { taskHash: 'task-5' } },
        { ...row('l6', '2026-01-06T00:00:00Z', 'retrieve'), request_state: { taskHash: 'task-6' } },
        { ...row('l7', '2026-01-07T00:00:00Z', 'skip'), request_state: { taskHash: 'task-7' } },
        { ...row('l8', '2026-01-08T00:00:00Z', 'retrieve'), request_state: { taskHash: 'task-8' } }
    ];
    const report = trainAndEvaluateLinearDecisionModel(rows, { split: { trainRatio: 0.5, calibrationRatio: 0.25 }, minimumSamples: 1 });
    assert.equal(report.leakage.hasCrossSplitLeakage, false);
    assert.equal(report.leakage.duplicateSampleCount, 1);
});

test('可选路由文本只以规则脱敏形式提供给决策器，审计上下文不保存文本', () => {
    const context = {
        scenario: 'chat.rag',
        taskState: {
            currentQuestion: '请查询 alice@example.com 的 13800138000 记录，令牌 sk-abcdefghijklmnopqrstuvwxyz，路径 C:\\private\\report.xlsx',
            evidenceNeeds: ['knowledge_base']
        },
        candidates: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }]
    };
    const providerContext = buildDecisionProviderContext(context, { includeRoutingText: true });
    assert.match(providerContext.requestState.routingText, /[EMAIL]/);
    assert.match(providerContext.requestState.routingText, /[PHONE]/);
    assert.match(providerContext.requestState.routingText, /[SECRET]/);
    assert.match(providerContext.requestState.routingText, /[PATH]/);
    assert.equal(providerContext.requestState.routingText.includes('alice@example.com'), false);
    assert.equal('routingText' in sanitizeDecisionContext(context).requestState, false);
    assert.equal('routingText' in buildDecisionProviderContext(context).requestState, false);
});

test('active 轻量模型必须与激活制品的版本和权重哈希一致', async () => {
    const model = { modelVersion: 'light-v1', actionWeights: { retrieve: { bias: 1, features: {} } } };
    const config = { mode: 'active', requireActiveArtifact: true, artifactTimeoutMs: 50 };
    const eligible = await isLocalLightArtifactEligible(model, config, {
        getActiveDecisionModelArtifact: async () => ({ model_version: 'light-v1', weights_hash: computeDecisionModelHash(model) })
    });
    assert.equal(eligible, true);
    const rejected = await isLocalLightArtifactEligible(model, config, {
        getActiveDecisionModelArtifact: async () => ({ model_version: 'light-v1', weights_hash: 'sha256:mismatch' })
    });
    assert.equal(rejected, false);
});

test('工作流决策只缩减已发布且可访问的候选，建议不会自动执行', async () => {
    const workflows = [
        { id: 7, is_published: true, name: '报表汇总', description: '汇总订单和销售报表' },
        { id: 8, is_published: false, name: '草稿流程', description: '不应进入候选' },
        { id: 9, is_published: true, name: '合同归档', description: '归档合同文档' }
    ];
    const candidates = publishedWorkflowCandidates(workflows, { currentQuestion: '汇总订单报表' }, 1);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].workflowId, 7);
    const recommendation = await recommendPublishedWorkflow({ user: { id: 3 }, prompt: '汇总订单报表' }, {
        listAgentWorkflows: async () => workflows,
        getPrimaryTenantId: async () => 4,
        resolveBusinessDecision: async input => ({
            decisionId: 'workflow-decision', selectedActionId: 'direct_answer', policy: { mode: 'shadow', suggestedActionId: 'workflow:7' }, context: input
        })
    });
    assert.deepEqual(recommendation.selectedWorkflow, { id: 7, name: '报表汇总' });
    assert.equal(recommendation.executionActionId, 'direct_answer');
    assert.equal(recommendation.recommendationActionId, 'workflow:7');
    assert.equal(recommendation.requiresUserConfirmation, true);
    assert.equal(recommendation.candidates.some(candidate => candidate.workflowId === 8), false);
});

test('决策学习维护报告只读汇总样本、故障与提供器运行状态', async () => {
    const report = await getDecisionMaintenanceReport({ lookbackDays: 14, minimumVerifiedSamples: 5 }, {
        query: async sql => sql.includes('FROM decision_outcomes o JOIN decision_records') ? [{ tenant_id: 3, scenario: 'chat.rag', status: 'failure', reason_code: 'retrieval_failed', count: 2 }] : [{ tenant_id: 3, scenario: 'chat.rag', verified_samples: 6, user_feedback_events: 2, execution_failures: 1, last_outcome_at: '2026-01-01' }],
        getDecisionOperationalMetrics: async () => ({ providers: [{ providerId: 'laya' }], unavailable: false })
    });
    assert.equal(report.unavailable, false);
    assert.equal(report.readiness[0].readyForTraining, true);
    assert.equal(report.readiness[0].executionFailures, 1);
    assert.deepEqual(report.errorBreakdown, [{ tenantId: 3, scenario: 'chat.rag', status: 'failure', reasonCode: 'retrieval_failed', count: 2 }]);
    const unavailable = await getDecisionMaintenanceReport({}, {
        query: async () => { throw Object.assign(new Error('missing'), { code: '42P01' }); }
    });
    assert.equal(unavailable.unavailable, true);
});

test('决策制品熔断在冻结阈值超标时退役制品，样本不足时不动作', async () => {
    const thresholds = { minSamples: 10, maxProviderErrorRate: 0.1, maxExecutionFailureRate: 0.2 };
    assert.equal(evaluateDecisionArtifactBreaker(thresholds, { samples: 9, providerErrors: 9 }).tripped, false);
    const triggered = evaluateDecisionArtifactBreaker(thresholds, { samples: 10, providerErrors: 2, executionFailures: 0 });
    assert.equal(triggered.tripped, true);
    assert.equal(triggered.reason, 'provider_error_rate');
    const actions = [];
    const result = await sweepDecisionArtifactBreakers({ windowMinutes: 30 }, {
        query: async (sql) => {
            if (sql.includes('FROM decision_model_artifacts')) return [{
                id: 'laya-release-1', provider_id: 'laya', model_version: 'approved-v1',
                evaluation_report: { breakerThresholds: thresholds }
            }];
            return [{ samples: 10, provider_errors: 0, execution_failures: 3 }];
        },
        rollbackDecisionModelArtifact: async id => { actions.push(id); return { id, status: 'retired' }; }
    });
    assert.equal(result.tripped, 1);
    assert.deepEqual(actions, ['laya-release-1']);
});

test('策略制品熔断从决策审计的 policyArtifactId 汇总失败率', async () => {
    const calls = [];
    const result = await sweepDecisionArtifactBreakers({ windowMinutes: 30 }, {
        query: async (sql) => {
            calls.push(sql);
            if (sql.includes('FROM decision_model_artifacts')) return [{
                id: 'policy-artifact-1', provider_id: 'decision-policy', model_version: 'policy-v1',
                evaluation_report: { breakerThresholds: { minSamples: 5, maxProviderErrorRate: 1, maxExecutionFailureRate: 0.1 } }
            }];
            return [{ samples: 5, provider_errors: 0, execution_failures: 1 }];
        },
        rollbackDecisionModelArtifact: async id => ({ id, status: 'retired' })
    });
    assert.equal(result.tripped, 1);
    assert.match(calls[1], /policyArtifactId/);
});

test('持久化冻结集只在所有案例审核完成后才能进入正式基准', async () => {
    const caseRow = {
        set_version: 'v1', case_id: 'case-1', scenario: 'chat.rag', language: 'zh',
        input_context: { requestState: { taskHash: 'case-hash', routingText: '请根据制度说明报销流程', evidenceNeeds: ['knowledge_base'] } },
        candidate_actions: [{ id: 'retrieve', allowed: true }, { id: 'skip', allowed: true }],
        review_status: 'verified', expected_action_id: 'retrieve', reviewed_by: 1, reviewed_by_username: 'reviewer', reviewed_at: '2026-01-01', review_note: '', updated_at: '2026-01-01'
    };
    const cases = await loadReviewedDecisionEvaluationCases('v1', {
        query: async (sql) => sql.includes('COUNT(*)') ? [{ set_version: 'v1', total: 1, verified: 1, pending: 0 }] : [caseRow]
    });
    assert.equal(cases.length, 1);
    assert.equal(cases[0].expectedActionId, 'retrieve');
    assert.equal(cases[0].providerInput.routingText.includes('报销'), true);
    await assert.rejects(
        loadReviewedDecisionEvaluationCases('v1', { query: async () => [{ set_version: 'v1', total: 1, verified: 0, pending: 1 }] }),
        /not_fully_reviewed/
    );
    const review = await reviewDecisionEvaluationCase({ version: 'v1', caseId: 'case-1', expectedActionId: 'retrieve', reviewerId: 1 }, {
        transaction: async fn => await fn({
            queryOne: async () => ({ candidate_actions: [{ id: 'retrieve', allowed: true }] }),
            execute: async () => 1
        })
    });
    assert.equal(review.expectedActionId, 'retrieve');
});

test('部署就绪度统一暴露迁移、审核、策略制品与灰度阻塞项', async () => {
    const activeConfig = {
        mode: 'active', rolloutPercent: 10, version: 'policy-v1', evaluationSetVersion: 'v1',
        laya: { enabled: false }
    };
    const blocked = await getDecisionDeploymentReadiness({}, {
        getDecisionRuntimeConfig: () => activeConfig,
        queryOne: async () => ({ applied: true }),
        getDecisionEvaluationReviewStatus: async () => ({ total: 12, verified: 10, pending: 2 }),
        getActiveDecisionPolicyArtifact: async () => null
    });
    assert.equal(blocked.status, 'error');
    assert.equal(blocked.checks.find(item => item.name === 'evaluationReviews').status, 'error');
    const ready = await getDecisionDeploymentReadiness({}, {
        getDecisionRuntimeConfig: () => activeConfig,
        queryOne: async () => ({ applied: true }),
        getDecisionEvaluationReviewStatus: async () => ({ total: 12, verified: 12, pending: 0 }),
        getActiveDecisionPolicyArtifact: async () => ({ model_version: 'policy-v1' })
    });
    assert.equal(ready.status, 'ok');
});

test('冻结 v2 评测集覆盖已有路由、下一步动作与受控工作流选择', () => {
    const source = require('../docs/decision-evaluation-set.v2.json');
    const cases = Array.isArray(source.cases) ? source.cases : [];
    assert.equal(source.version, 'v2');
    assert.equal(cases.length, 15);
    const coverage = new Set(cases.map(item => item.scenario));
    assert.equal(coverage.has('chat.rag'), true);
    assert.equal(coverage.has('chat.tools'), true);
    assert.equal(coverage.has('chat.next_step'), true);
    assert.equal(coverage.has('agent.workflow'), true);
    const clarify = cases.find(item => item.id === 'next-step-clarify-zh-001');
    assert.deepEqual(clarify.candidates.filter(item => item.allowed !== false).map(item => item.id), ['direct_answer', 'clarify']);
});

test('active 下一步策略选择澄清时停止 RAG 与工具执行，并保留审计摘要', async () => {
    const router = createSemanticRouter({
        getChatAutoRouteConfig: () => ({ enabled: true, autoRagEnabled: true, autoToolDiscoveryEnabled: true, shadowMode: false, maxToolCandidates: 2, maxCollections: 2, ragThreshold: 0.34, ragGrayThreshold: 0.16, toolThreshold: 0.2, embeddingTimeoutMs: 100 }),
        getEmbeddingConfig: () => ({ http: { url: '' } }),
        generateEmbedding: async () => [],
        getPrimaryTenantId: async () => 4,
        knowledgeCatalogIndex: { getVisibleEntries: async () => [], scheduleRefresh() {} },
        mcpToolCatalogIndex: { getEntries: values => values.map(tool => ({ tool, semanticSignature: tool.description, vector: [] })), scheduleRefresh() {} },
        recordChatRouteMetric() {},
        resolveBusinessDecision: async input => ({
            decisionId: 'next-step-' + input.scenario,
            context: { scenario: input.scenario },
            selectedActionId: input.scenario === 'chat.next_step' ? 'clarify' : input.fallbackActionId,
            policy: { mode: 'active', suggestedActionId: input.scenario === 'chat.next_step' ? 'clarify' : input.fallbackActionId, confidence: 0.95, threshold: 0.58, reasonCode: 'policy_auto_approved', applied: true }
        })
    });
    const plan = await router.resolveRoutePlan({
        prompt: '查询订单数量',
        taskState: { hash: 'clarify-test', currentQuestion: '查询订单数量', toolIntent: { requestedCapabilities: ['data.query'] } },
        user: { id: 3 },
        availableMcpTools: [{ fullName: 'mcp.3.db.query', name: 'db.query', description: '查询数据库' }],
        state: { ragEnabled: true, mcpEnabled: true, autoRouteEnabled: true }
    });
    assert.equal(plan.nextStep.action, 'clarify');
    assert.equal(plan.execution.nextStep.action, 'clarify');
    assert.equal(plan.execution.rag.shouldRetrieve, false);
    assert.equal(plan.execution.tools.shouldPlan, false);
    assert.equal(buildRouteMetadata(plan).nextStep.action, 'clarify');
});

test('决策审计保留期清理只删除到期记录并保留模型与评测制品', async () => {
    const calls = [];
    const result = await cleanupExpiredDecisionRecords({ retentionDays: 180 }, {
        execute: async (sql, params) => { calls.push({ sql, params }); return 7; }
    });
    assert.deepEqual(result, { retentionDays: 180, deletedRecords: 7 });
    assert.match(calls[0].sql, /DELETE FROM decision_records/);
    assert.equal(calls[0].sql.includes('decision_model_artifacts'), false);
    assert.equal(calls[0].sql.includes('decision_evaluation'), false);
    assert.deepEqual(calls[0].params, [180]);
});

test('Laya 制品只有登记完整部署证据后才能激活', async () => {
    const base = { id: 'laya-artifact', provider_id: 'laya', status: 'candidate', evaluation_report: { releaseGate: { passed: true } } };
    const denied = await activateDecisionModelArtifact('laya-artifact', {
        transaction: async fn => await fn({ queryOne: async () => base, execute: async () => 0 })
    });
    assert.equal(denied, null);
    const digest = 'sha256:' + 'a'.repeat(64);
    const complete = { ...base, evaluation_report: { releaseGate: { passed: true }, deploymentEvidence: { imageDigest: digest, modelSha256: digest, dependencyLockSha256: digest, launchCommandDigest: digest } } };
    const calls = [];
    const activated = await activateDecisionModelArtifact('laya-artifact', {
        transaction: async fn => await fn({ queryOne: async () => complete, execute: async (sql, params) => calls.push({ sql, params }) })
    });
    assert.equal(activated.id, 'laya-artifact');
    assert.equal(calls.length, 2);
});
