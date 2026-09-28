'use strict';

const { getDecisionRuntimeConfig } = require('./decision-runtime');
const { getDecisionDeploymentReadiness } = require('./decision-deployment-readiness');
const { getDecisionEvaluationReviewStatus } = require('./decision-evaluation-reviews');

function overallStatus(checks = []) {
    return checks.some(check => check.status === 'error') ? 'error' : 'ok';
}

async function getDecisionDevelopmentReadiness({ env = process.env } = {}, deps = {}) {
    const config = (deps.getDecisionRuntimeConfig || getDecisionRuntimeConfig)(env);
    const production = await (deps.getDecisionDeploymentReadiness || getDecisionDeploymentReadiness)({ env }, deps);
    const reviewStatus = await (deps.getDecisionEvaluationReviewStatus || getDecisionEvaluationReviewStatus)(config.evaluationSetVersion || 'v2');
    const migration = (production.checks || []).find(check => check.name === 'decisionMigrations');
    const providersEnabled = Boolean(config.laya?.enabled || config.qwen?.enabled || config.light?.enabled);
    const safeMode = config.mode !== 'active' && Number(config.rolloutPercent || 0) === 0;
    const evaluationSetImported = Number(reviewStatus?.total || 0) > 0;
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
            message: evaluationSetImported ? '冻结评测集已导入开发数据库' : '冻结评测集尚未导入开发数据库'
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

