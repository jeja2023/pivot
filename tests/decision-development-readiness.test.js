const assert = require('node:assert/strict');
const test = require('node:test');
const { getDecisionDevelopmentReadiness } = require('../server/services/decision-development-readiness');
const { getDecisionDeploymentReadiness } = require('../server/services/decision-deployment-readiness');

function safeConfig() {
    return {
        mode: 'shadow', rolloutPercent: 0, evaluationSetVersion: 'v2',
        laya: { enabled: false }, qwen: { enabled: false }, light: { enabled: false }
    };
}

test('开发环境验收允许待人工审核但要求迁移、导入冻结集和安全配置', async () => {
    const report = await getDecisionDevelopmentReadiness({}, {
        getDecisionRuntimeConfig: safeConfig,
        getDecisionDeploymentReadiness: async () => ({
            status: 'degraded',
            checks: [{ name: 'decisionMigrations', status: 'ok', message: 'migrations ready' }]
        }),
        getDecisionEvaluationReviewStatus: async () => ({ version: 'v2', total: 15, verified: 0, pending: 15 })
    });
    assert.equal(report.status, 'ok');
    assert.equal(report.environment, 'development');
    assert.equal(report.productionReadiness, 'degraded');
    assert.equal(report.checks.find(item => item.name === 'evaluationSetImported').status, 'ok');
    assert.equal(report.checks.find(item => item.name === 'productionEvidenceDeferred').status, 'info');
});

test('开发验收拒绝 active 灰度、真实学习型提供器或缺失迁移', async () => {
    const report = await getDecisionDevelopmentReadiness({}, {
        getDecisionRuntimeConfig: () => ({ ...safeConfig(), mode: 'active', rolloutPercent: 10, laya: { enabled: true } }),
        getDecisionDeploymentReadiness: async () => ({
            status: 'error',
            checks: [{ name: 'decisionMigrations', status: 'error', message: 'missing governance migration' }]
        }),
        getDecisionEvaluationReviewStatus: async () => null
    });
    assert.equal(report.status, 'error');
    assert.equal(report.checks.find(item => item.name === 'decisionMigrations').status, 'error');
    assert.equal(report.checks.find(item => item.name === 'safeNonProductionMode').status, 'error');
    assert.equal(report.checks.find(item => item.name === 'externalDecisionProvidersDisabled').status, 'error');
});

test('生产就绪度缺少评测治理迁移时拒绝继续', async () => {
    let calls = 0;
    const report = await getDecisionDeploymentReadiness({}, {
        getDecisionRuntimeConfig: () => ({ ...safeConfig(), version: 'policy-v1' }),
        queryOne: async () => ({ applied: calls++ === 0 }),
        getDecisionEvaluationReviewStatus: async () => ({ total: 15, verified: 15, pending: 0 })
    });
    assert.equal(report.status, 'error');
    const migrations = report.checks.find(item => item.name === 'decisionMigrations');
    assert.deepEqual(migrations.missing, ['202609280002_decision_evaluation_governance']);
});

