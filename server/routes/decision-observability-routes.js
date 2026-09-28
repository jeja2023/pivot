'use strict';

const { asyncHandler } = require('../http');

function registerDecisionObservabilityRoutes(router, dependencies = {}) {
    const {
        authMiddleware, adminMiddleware, logAction,
        getDecisionOperationalMetrics, recordVerifiedDecisionOutcome,
        buildVerifiedDecisionDatasetFromStore, evaluateDecisionSamples,
        activateDecisionModelArtifact, listDecisionModelArtifacts, rollbackDecisionModelArtifact,
        listDecisionPreferences, saveDecisionPreference, registerDecisionPolicyArtifact,
        getDecisionDeploymentReadiness, getDecisionMaintenanceReport,
        importFrozenDecisionEvaluationSet, listDecisionEvaluationCases, reviewDecisionEvaluationCase
    } = dependencies;

    router.post('/observability/decision-evaluation-sets/import', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const imported = await importFrozenDecisionEvaluationSet({ userId: req.user.id });
        logAction(req, '导入冻结决策评测集', '版本: ' + imported.version + '，新增用例: ' + imported.inserted);
        res.status(201).json({ success: true, imported });
    }));

    router.get('/observability/decision-evaluation-sets/:version/cases', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listDecisionEvaluationCases({ version: req.params.version, limit: req.query?.limit }) });
    }));

    router.post('/observability/decision-evaluation-sets/:version/cases/:caseId/review', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const review = await reviewDecisionEvaluationCase({
            version: req.params.version, caseId: req.params.caseId, expectedActionId: req.body?.expectedActionId,
            reviewNote: req.body?.reviewNote, reviewerId: req.user.id
        });
        if (!review) return res.status(404).json({ error: '冻结评测案例不存在。' });
        logAction(req, '核验冻结决策评测案例', '版本: ' + review.version + '，案例: ' + review.caseId + '，动作: ' + review.expectedActionId);
        res.json({ success: true, review });
    }));

    router.get('/observability/decision-preferences', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const scope = String(req.query?.scope || 'tenant').toLowerCase() === 'user' ? 'user' : 'tenant';
        res.json({ data: await listDecisionPreferences({ scope, userId: req.query?.userId, tenantId: req.query?.tenantId }) });
    }));

    router.put('/observability/decision-preferences', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const scope = String(req.body?.scope || 'tenant').toLowerCase() === 'user' ? 'user' : 'tenant';
        const preference = await saveDecisionPreference({
            scope, userId: req.body?.userId, tenantId: req.body?.tenantId, scenario: req.body?.scenario,
            actionId: req.body?.actionId, enabled: req.body?.enabled !== false, actorId: req.user.id
        });
        logAction(req, '更新组织路由偏好', '范围: ' + preference.scope + '，场景: ' + preference.scenario + '，动作: ' + preference.actionId);
        res.json({ success: true, preference });
    }));

    router.get('/observability/decision-readiness', authMiddleware, adminMiddleware, asyncHandler(async (_req, res) => {
        res.json(await getDecisionDeploymentReadiness());
    }));

    router.get('/observability/decision-maintenance', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        res.json(await getDecisionMaintenanceReport({ lookbackDays: req.query?.lookbackDays, minimumVerifiedSamples: req.query?.minimumVerifiedSamples }));
    }));

    router.get('/observability/decision-metrics', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        res.json(await getDecisionOperationalMetrics({ minutes: req.query?.minutes }));
    }));

    router.get('/observability/decision-learning', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const dataset = await buildVerifiedDecisionDatasetFromStore({ scenario: req.query?.scenario, tenantId: req.query?.tenantId, limit: req.query?.limit });
        const metrics = evaluateDecisionSamples(dataset.samples);
        res.json({ dataVersion: dataset.version, sampleCount: dataset.sampleCount, generatedAt: dataset.generatedAt, splitPolicy: 'time_ordered_no_random_shuffle', metrics });
    }));

    router.post('/observability/decision-outcomes', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const outcome = await recordVerifiedDecisionOutcome({ decisionId: req.body?.decisionId, verifiedActionId: req.body?.verifiedActionId, selectedActionId: req.body?.selectedActionId, status: req.body?.status, source: 'admin' });
        if (!outcome) return res.status(400).json({ error: '决策不存在，或核验动作不在该决策当时允许的候选中。' });
        logAction(req, '核验业务决策结果', '决策ID: ' + outcome.decisionId + '，核验动作: ' + outcome.verifiedActionId);
        res.status(202).json({ success: true, outcome });
    }));

    router.post('/observability/decision-policy-artifacts', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const artifact = await registerDecisionPolicyArtifact({
            version: req.body?.version, dataVersion: req.body?.dataVersion, codeVersion: req.body?.codeVersion,
            policyConfig: req.body?.policyConfig, evaluationReport: req.body?.evaluationReport, createdBy: req.user.id
        });
        logAction(req, '登记业务决策策略制品', '策略版本: ' + String(req.body?.version || '').slice(0, 128));
        res.status(201).json({ success: true, artifact });
    }));

    router.get('/observability/decision-models', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listDecisionModelArtifacts({ providerId: req.query?.providerId, limit: req.query?.limit }) });
    }));

    router.post('/observability/decision-models/:id/activate', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const artifact = await activateDecisionModelArtifact(req.params.id);
        if (!artifact) return res.status(409).json({ error: '模型不存在、已退役，或尚未通过独立评测发布门槛。' });
        logAction(req, '激活业务决策模型', '模型制品: ' + artifact.id + '，提供器: ' + artifact.provider_id + '，版本: ' + artifact.model_version);
        res.json({ success: true, artifact });
    }));

    router.post('/observability/decision-models/:id/rollback', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const artifact = await rollbackDecisionModelArtifact(req.params.id);
        if (!artifact) return res.status(409).json({ error: '只有当前 active 的模型制品可以回滚。' });
        logAction(req, '回滚业务决策模型', '模型制品: ' + artifact.id + '，提供器: ' + artifact.provider_id);
        res.json({ success: true, artifact });
    }));
}

module.exports = { registerDecisionObservabilityRoutes };
