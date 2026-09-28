const assert = require('node:assert/strict');
const test = require('node:test');
const { registerDecisionObservabilityRoutes } = require('../server/routes/decision-observability-routes');
const { registerAgentRoutingRoutes } = require('../server/routes/agent-routing-routes');
const { persistFinalChatResponse } = require('../server/services/chat-decision-outcomes');

function createRouterRecorder() {
    const routes = [];
    return {
        routes,
        get(path, ...handlers) { routes.push({ method: 'get', path, handlers }); },
        post(path, ...handlers) { routes.push({ method: 'post', path, handlers }); },
        put(path, ...handlers) { routes.push({ method: 'put', path, handlers }); }
    };
}

test('智能决策管理路由完整注册审核、观测、模型和回滚端点', () => {
    const router = createRouterRecorder();
    const noop = async () => ({});
    registerDecisionObservabilityRoutes(router, {
        authMiddleware: (_req, _res, next) => next(), adminMiddleware: (_req, _res, next) => next(), logAction() {},
        getDecisionOperationalMetrics: noop, recordVerifiedDecisionOutcome: noop,
        buildVerifiedDecisionDatasetFromStore: noop, evaluateDecisionSamples: () => ({}),
        activateDecisionModelArtifact: noop, listDecisionModelArtifacts: noop, rollbackDecisionModelArtifact: noop,
        listDecisionPreferences: noop, saveDecisionPreference: noop, registerDecisionPolicyArtifact: noop,
        getDecisionDeploymentReadiness: noop, getDecisionMaintenanceReport: noop,
        importFrozenDecisionEvaluationSet: noop, listDecisionEvaluationCases: noop, reviewDecisionEvaluationCase: noop
    });
    const endpoints = new Set(router.routes.map(route => route.method + ' ' + route.path));
    assert.equal(endpoints.has('post /observability/decision-evaluation-sets/import'), true);
    assert.equal(endpoints.has('post /observability/decision-evaluation-sets/:version/cases/:caseId/review'), true);
    assert.equal(endpoints.has('get /observability/decision-maintenance'), true);
    assert.equal(endpoints.has('post /observability/decision-models/:id/activate'), true);
    assert.equal(endpoints.has('post /observability/decision-models/:id/rollback'), true);
});

test('Agent 路由模块保留受控工具目录与工作流推荐端点', () => {
    const router = createRouterRecorder();
    registerAgentRoutingRoutes(router, {
        authMiddleware: (_req, _res, next) => next(), automationGuard: (_req, _res, next) => next(), logAction() {}
    });
    assert.deepEqual(router.routes.map(route => route.method + ' ' + route.path), [
        'get /agents/tools',
        'post /agents/workflow-recommendations'
    ]);
});

test('最终回复持久化保留模型用量与路由审计元数据', async () => {
    let persistedOptions = null;
    const routePlan = {
        mode: 'auto', shadow: false, rag: { action: 'retrieve' }, tools: { action: 'skip' },
        nextStep: { action: 'direct_answer' }, decisions: {}, timing: { routeDurationMs: 3, embeddingDurationMs: 1 }
    };
    const result = await persistFinalChatResponse({
        persistAssistantResponse: async options => { persistedOptions = options; return { assistantMessageId: 55, assistantMessageResult: { lastInsertRowid: 55 } }; },
        sessionId: 'session-1', userId: 7, userMessageId: 8, user: { id: 7 }, modelCfg: { id: 3 },
        visibleContent: 'answer', assistantContent: 'answer', assistantTokens: 9, costTime: 12, tokensPerSec: 1.5,
        routePlan, providerUsage: { prompt_tokens: 7 }
    });
    assert.equal(result.assistantMessageId, 55);
    assert.equal(routePlan.providerUsage.prompt_tokens, 7);
    assert.equal(persistedOptions.routeMetadata.rag.action, 'retrieve');
});

