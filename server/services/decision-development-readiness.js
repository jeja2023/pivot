'use strict';

const { getDecisionRuntimeConfig } = require('./decision-runtime');
const { getDecisionDeploymentReadiness } = require('./decision-deployment-readiness');
const {
    getDecisionEvaluationReviewStatus,
    getDecisionEvaluationSetGovernance,
    loadFrozenDecisionEvaluationSet,
    sourceDigest
} = require('./decision-evaluation-reviews');

function overallStatus(checks = []) {
    return checks.some(check => check.status === 'error') ? 'error' : 'ok';
}

async function getDecisionDevelopmentReadiness({ env = process.env } = {}, deps = {}) {
    const config = (deps.getDecisionRuntimeConfig || getDecisionRuntimeConfig)(env);
    const production = await (deps.getDecisionDeploymentReadiness || getDecisionDeploymentReadiness)({ env }, deps);
    let reviewStatus = null;
    let evaluationGovernance = null;
    let source = {};
    let expectedDigest = '';
    let evaluationError = '';
    try {
        source = (deps.loadFrozenDecisionEvaluationSet || loadFrozenDecisionEvaluationSet)();
        expectedDigest = (deps.sourceDigest || sourceDigest)(source);
        [reviewStatus, evaluationGovernance] = await Promise.all([
            (deps.getDecisionEvaluationReviewStatus || getDecisionEvaluationReviewStatus)(config.evaluationSetVersion || 'v2'),
            (deps.getDecisionEvaluationSetGovernance || getDecisionEvaluationSetGovernance)(config.evaluationSetVersion || 'v2', deps)
        ]);
    } catch (error) {
        evaluationError = String(error?.message || '冻结评测集状态不可用').slice(0, 240);
    }
    const migration = (production.checks || []).find(check => check.name === 'decisionMigrations');
    const providersEnabled = Boolean(config.laya?.enabled || config.qwen?.enabled || config.light?.enabled);
    const safeMode = config.mode !== 'active' && Number(config.rolloutPercent || 0) === 0;
    const evaluationSetImported = Number(reviewStatus?.total || 0) > 0;
    const evaluationSourceMatches = evaluationSetImported
        && String(evaluationGovernance?.version || '') === String(source.version || '')
        && String(evaluationGovernance?.sourceDigest || '') === expectedDigest
        && Number(evaluationGovernance?.total || 0) === Number(reviewStatus?.total || 0);
    const checks = [
        {
            name: 'decisionMigrations',
            status: migration?.status === 'ok' ? 'ok' : 'error',
            message: migration?.message || '决策迁移状态不可用'
        },
        {
            name: 'evaluationSetImported',
            status: evaluationSetImported ? 'ok' : 'error',
            version: config.evaluationSetVersion || '',
            total: Number(reviewStatus?.total || 0),
            message: evaluationSetImported ? '冻结评测集已导入开发数据库' : (evaluationError || '冻结评测集尚未导入开发数据库')
        },
        {
            name: 'evaluationSetSourceIntegrity',
            status: evaluationSourceMatches ? 'ok' : 'error',
            version: String(source.version || ''),
            expectedDigest,
            importedDigest: String(evaluationGovernance?.sourceDigest || ''),
            message: evaluationSourceMatches ? '开发数据库中的冻结集与当前源码摘要一致' : (evaluationError || '开发数据库中的冻结集版本、案例数或源码摘要不一致，请重新导入后再继续开发验收')
        },
        {
            name: 'safeNonProductionMode',
            status: safeMode ? 'ok' : 'error',
            mode: config.mode,
            rolloutPercent: Number(config.rolloutPercent || 0),
            message: safeMode ? '开发环境保持非 active 和 0% 灰度' : '开发环境不得启用 active 灰度'
        },
        {
            name: 'externalDecisionProvidersDisabled',
            status: providersEnabled ? 'error' : 'ok',
            providers: { laya: Boolean(config.laya?.enabled), qwen: Boolean(config.qwen?.enabled), light: Boolean(config.light?.enabled) },
            message: providersEnabled ? '开发环境不应连接真实学习型决策器' : '真实学习型决策器未连接'
        },
        {
            name: 'productionEvidenceDeferred',
            status: 'info',
            message: '人工审核、真实模型、GPU 压测和业务结果属于目标内网生产验收，不作为开发完成阻塞项'
        }
    ];
    return {
        status: overallStatus(checks),
        environment: 'development',
        productionReadiness: production.status,
        checks
    };
}

module.exports = { getDecisionDevelopmentReadiness };
