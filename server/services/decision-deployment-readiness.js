'use strict';

const { queryOne } = require('../db/client');
const { getDecisionRuntimeConfig } = require('./decision-runtime');
const { getDecisionEvaluationReviewStatus } = require('./decision-evaluation-reviews');
const { getActiveDecisionPolicyArtifact } = require('./decision-policy-registry');
const { checkLayaDecisionHealth } = require('./decision-provider-health');

const DECISION_MIGRATION_IDS = [
    '202609280001_decision_learning_foundations',
    '202609280002_decision_evaluation_governance'
];
const MIGRATION_STATUS_SQL = 'SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = ?) AS applied';

function overallReadiness(checks = []) {
    const statuses = checks.map(item => item.status);
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('degraded')) return 'degraded';
    return 'ok';
}

async function getDecisionDeploymentReadiness({ env = process.env } = {}, deps = {}) {
    const config = (deps.getDecisionRuntimeConfig || getDecisionRuntimeConfig)(env);
    const queryOneFn = deps.queryOne || queryOne;
    const checks = [];
    let migrationApplied = false;
    try {
        const migrations = await Promise.all(DECISION_MIGRATION_IDS.map(async id => ({
            id,
            applied: (await queryOneFn(MIGRATION_STATUS_SQL, [id]))?.applied
        })));
        const missing = migrations.filter(item => !(item.applied === true || item.applied === 1 || item.applied === 't')).map(item => item.id);
        migrationApplied = missing.length === 0;
        checks.push({
            name: 'decisionMigrations',
            status: migrationApplied ? 'ok' : 'error',
            required: DECISION_MIGRATION_IDS,
            missing,
            message: migrationApplied ? '决策学习与评测治理迁移已应用' : '缺少决策迁移：' + missing.join(', ')
        });
    } catch (error) {
        checks.push({ name: 'decisionMigrations', status: 'error', message: String(error?.message || '数据库不可用').slice(0, 240) });
    }

    const activeRollout = config.mode === 'active' && Number(config.rolloutPercent || 0) > 0;
    if (migrationApplied) {
        try {
            const reviews = await (deps.getDecisionEvaluationReviewStatus || getDecisionEvaluationReviewStatus)(config.evaluationSetVersion || 'v1');
            const complete = reviews && Number(reviews.total || 0) > 0 && Number(reviews.pending || 0) === 0 && Number(reviews.verified || 0) === Number(reviews.total || 0);
            checks.push({
                name: 'evaluationReviews',
                status: complete ? 'ok' : activeRollout ? 'error' : 'degraded',
                total: Number(reviews?.total || 0), verified: Number(reviews?.verified || 0), pending: Number(reviews?.pending || 0),
                message: complete ? '冻结评测集已完成审核' : '冻结评测集尚未完成审核'
            });
        } catch (error) {
            checks.push({ name: 'evaluationReviews', status: activeRollout ? 'error' : 'degraded', message: String(error?.message || '冻结评测集审核状态不可用').slice(0, 240) });
        }
    }

    if (activeRollout) {
        try {
            const policy = await (deps.getActiveDecisionPolicyArtifact || getActiveDecisionPolicyArtifact)();
            const matches = policy && String(policy.model_version || '') === String(config.version || '');
            checks.push({ name: 'activePolicyArtifact', status: matches ? 'ok' : 'error', message: matches ? '策略制品已激活' : '缺少匹配版本的 active 策略制品' });
        } catch (error) {
            checks.push({ name: 'activePolicyArtifact', status: 'error', message: String(error?.message || '策略制品不可用').slice(0, 240) });
        }
    }

    if (config.laya?.enabled) {
        const laya = await (deps.checkLayaDecisionHealth || checkLayaDecisionHealth)({ env });
        checks.push({ name: 'layaDecision', ...laya });
    }

    checks.push({
        name: 'rollout',
        status: activeRollout ? 'ok' : 'degraded',
        mode: config.mode,
        rolloutPercent: Number(config.rolloutPercent || 0),
        message: activeRollout ? 'active 灰度已配置' : '当前为影子、禁用或 0% 灰度'
    });
    return { status: overallReadiness(checks), activeRollout, checks };
}

module.exports = { getDecisionDeploymentReadiness };
