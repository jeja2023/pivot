'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { getDecisionRuntimeConfig } = require('../server/services/decision-runtime');
const { getActiveDecisionModelArtifact } = require('../server/services/decision-model-registry');
const { getActiveDecisionPolicyArtifact } = require('../server/services/decision-policy-registry');
const { getDecisionEvaluationReviewStatus } = require('../server/services/decision-evaluation-reviews');
const { computeDecisionModelHash, loadLocalLinearDecisionModel } = require('../server/services/decision-light-model');
const { checkLayaDecisionHealth } = require('../server/services/decision-provider-health');

function withTimeout(promise, timeoutMs) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('决策模型注册表检查超时')), timeoutMs);
        })
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

function readEvaluationSet(filePath) {
    const source = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const cases = Array.isArray(source?.cases) ? source.cases : [];
    const pending = cases.filter(item => item?.reviewStatus !== 'verified');
    const invalid = cases.filter(item => item?.reviewStatus === 'verified' && (!item?.expectedActionId || !item?.reviewedBy || !item?.reviewedAt));
    return { version: source?.version || '', total: cases.length, pending: pending.length, invalid: invalid.length };
}

async function main() {
    const config = getDecisionRuntimeConfig(process.env);
    const activeRollout = config.mode === 'active' && Number(config.rolloutPercent || 0) > 0;
    const requireVerified = process.argv.includes('--require-verified') || activeRollout;
    const evaluationSetPath = path.resolve(process.argv.includes('--evaluation-set') ? process.argv[process.argv.indexOf('--evaluation-set') + 1] : path.resolve(__dirname, '../docs/decision-evaluation-set.v2.json'));
    const checks = [];
    const dbTimeoutMs = Math.max(500, Math.min(Number.parseInt(process.env.PIVOT_DECISION_PREFLIGHT_TIMEOUT_MS || '5000', 10) || 5000, 30000));
    const evaluation = readEvaluationSet(evaluationSetPath);
    checks.push({ name: 'evaluationSet', status: evaluation.invalid ? 'error' : 'ok', ...evaluation });
    if (requireVerified) {
        try {
            const reviews = await withTimeout(getDecisionEvaluationReviewStatus(evaluation.version), dbTimeoutMs);
            const fullyReviewed = reviews && Number(reviews.total || 0) === Number(evaluation.total || 0)
                && Number(reviews.verified || 0) === Number(evaluation.total || 0)
                && Number(reviews.pending || 0) === 0;
            checks.push({
                name: 'persistedEvaluationReviews',
                status: fullyReviewed ? 'ok' : 'error',
                version: evaluation.version,
                total: Number(reviews?.total || 0),
                verified: Number(reviews?.verified || 0),
                pending: Number(reviews?.pending || 0),
                message: fullyReviewed ? '' : '冻结评测集尚未在数据库中完成全部管理员核验'
            });
        } catch (error) {
            checks.push({ name: 'persistedEvaluationReviews', status: 'error', message: String(error.message || '冻结评测集复核状态不可用').slice(0, 240) });
        }
    }
    if (config.laya.enabled) checks.push({ name: 'layaHealth', ...(await checkLayaDecisionHealth()) });
    if (activeRollout) {
        if (config.requireActiveArtifact !== true) checks.push({ name: 'activeArtifactGate', status: 'error', message: 'active 灰度必须启用 PIVOT_DECISION_REQUIRE_ACTIVE_ARTIFACT' });
        if (config.useActivePolicyArtifact !== true) {
            checks.push({ name: 'activePolicyArtifact', status: 'error', message: 'active 灰度必须启用 PIVOT_DECISION_USE_ACTIVE_POLICY_ARTIFACT' });
        } else {
            try {
                const artifact = await withTimeout(getActiveDecisionPolicyArtifact(), dbTimeoutMs);
                checks.push({
                    name: 'activePolicyArtifact',
                    status: artifact && String(artifact.model_version) === String(config.version) ? 'ok' : 'error',
                    modelVersion: artifact?.model_version || '',
                    message: artifact ? '激活策略版本与 PIVOT_DECISION_POLICY_VERSION 不一致' : '没有已激活且通过评测的策略参数制品'
                });
            } catch (error) {
                checks.push({ name: 'activePolicyArtifact', status: 'error', message: String(error.message || '策略制品检查失败').slice(0, 240) });
            }
        }
        const providers = [];
        if (config.light.enabled) {
            try {
                const model = await loadLocalLinearDecisionModel({ rootDir: config.light.modelRoot, modelFile: config.light.modelFile });
                providers.push({ providerId: 'light-linear', modelVersion: model.modelVersion, weightsHash: computeDecisionModelHash(model) });
            } catch (error) {
                checks.push({ name: 'activeArtifact:light-linear', status: 'error', message: '无法读取已配置的轻量模型：' + String(error.message || '').slice(0, 180) });
            }
        }
        if (config.qwen.enabled) {
            if (!config.qwen.version) checks.push({ name: 'activeArtifact:qwen', status: 'error', message: 'active 灰度必须配置 PIVOT_QWEN_DECISION_VERSION' });
            else providers.push({ providerId: 'qwen', modelVersion: config.qwen.version, weightsHash: '' });
        }
        if (config.laya.enabled) {
            if (!config.laya.version) checks.push({ name: 'activeArtifact:laya', status: 'error', message: 'active 灰度必须配置 PIVOT_LAYA_DECISION_VERSION' });
            else providers.push({ providerId: 'laya', modelVersion: config.laya.version, weightsHash: '' });
        }
        for (const provider of providers) {
            try {
                const artifact = await withTimeout(getActiveDecisionModelArtifact(provider.providerId), dbTimeoutMs);
                const versionMatches = artifact && String(artifact.model_version) === String(provider.modelVersion);
                const hashMatches = !provider.weightsHash || String(artifact?.weights_hash || '') === String(provider.weightsHash);
                checks.push({ name: 'activeArtifact:' + provider.providerId, status: versionMatches && hashMatches ? 'ok' : 'error', modelVersion: artifact?.model_version || '', message: versionMatches ? (hashMatches ? '' : '激活制品权重哈希与本地模型不一致') : '没有匹配版本的已激活且通过评测的模型制品' });
            } catch (error) {
                checks.push({ name: 'activeArtifact:' + provider.providerId, status: 'error', message: String(error.message || '模型注册表检查失败').slice(0, 240) });
            }
        }
    }
    const failed = checks.filter(item => item.status === 'error');
    process.stdout.write(JSON.stringify({ ready: failed.length === 0, decisionMode: config.mode, rolloutPercent: config.rolloutPercent, checks }, null, 2) + '\n');
    if (failed.length) process.exitCode = 1;
}

main().then(() => {
    process.exit(process.exitCode || 0);
}).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
