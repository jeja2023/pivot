'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { listVerifiedDecisionSamples } = require('../server/services/decision-observability');
const { registerDecisionModelArtifact } = require('../server/services/decision-learning');
const { computeDecisionModelHash, writeLocalLinearDecisionModel } = require('../server/services/decision-light-model');
const { trainAndEvaluateLinearDecisionModel } = require('../server/services/decision-training');
const { readTypedEnv } = require('../server/config/env-registry');
const { getDecisionEvaluationSetGovernance } = require('../server/services/decision-evaluation-reviews');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

async function loadFrozenEvaluationEvidence(modelVersion) {
    const reportPath = arg('--frozen-evaluation-report', '');
    if (!reportPath) throw new Error('--register 必须指定 --frozen-evaluation-report，并以已审核冻结集完成独立基准。');
    const benchmark = JSON.parse(await require('node:fs').promises.readFile(path.resolve(reportPath), 'utf8'));
    const version = String(arg('--frozen-evaluation-version', benchmark.evaluationSetVersion || process.env.PIVOT_DECISION_EVALUATION_SET_VERSION || '')).trim();
    const governance = await getDecisionEvaluationSetGovernance(version);
    const provider = (Array.isArray(benchmark.providers) ? benchmark.providers : []).find(item => (
        String(item?.providerId || '') === 'light-linear'
            && String(item?.providerVersion || '') === String(modelVersion || '')
    ));
    if (!governance
        || Number(governance.total || 0) === 0
        || Number(governance.pending || 0) !== 0
        || Number(governance.verified || 0) !== Number(governance.total || 0)
        || !provider) {
        throw new Error('冻结评测证据无效：需匹配已完成管理员审核的评测集及当前轻量模型版本。');
    }
    return {
        version: governance.version,
        sourceDigest: governance.sourceDigest,
        caseCount: governance.total,
        providerId: provider.providerId,
        providerVersion: provider.providerVersion,
        metrics: provider.metrics || {},
        timeoutOrErrorRate: provider.timeoutOrErrorRate ?? null,
        p95DurationMs: provider.p95DurationMs ?? null
    };
}

async function gitRevision() {
    try {
        const { stdout } = await require('node:child_process').promises.execFile('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '..') });
        return stdout.trim().slice(0, 128);
    } catch (_) {
        return '';
    }
}

async function main() {
    const limit = Math.max(30, Math.min(Number.parseInt(arg('--limit', '5000'), 10) || 5000, 10000));
    const minimumSamples = Math.max(1, Math.min(Number.parseInt(arg('--minimum-samples', '30'), 10) || 30, 10000));
    const criticalScenarios = arg('--critical-scenarios', '').split(',').map(value => value.trim()).filter(Boolean);
    const tenantId = Number.parseInt(arg('--tenant-id', ''), 10);
    const allowGlobal = hasFlag('--allow-global');
    const hasTenantScope = Number.isSafeInteger(tenantId) && tenantId > 0;
    const globalTrainingRequested = !hasTenantScope && allowGlobal;
    if (!hasTenantScope && !allowGlobal) throw new Error('必须通过 --tenant-id 指定租户；跨租户训练需要显式传入 --allow-global。');
    if (globalTrainingRequested && readTypedEnv('PIVOT_DECISION_ALLOW_GLOBAL_TRAINING', process.env) !== true) {
        throw new Error('跨租户训练尚未获得数据治理批准；请先设置已审批的 PIVOT_DECISION_ALLOW_GLOBAL_TRAINING=true。');
    }
    const rows = await listVerifiedDecisionSamples({ scenario: arg('--scenario', ''), tenantId: hasTenantScope ? tenantId : null, limit });
    const result = trainAndEvaluateLinearDecisionModel(rows, {
        minimumSamples,
        maxP95RegressionMs: Math.max(0, Number.parseInt(arg('--max-p95-regression-ms', '0'), 10) || 0),
        criticalScenarios
    });
    const codeVersion = await gitRevision();
    const weightsHash = computeDecisionModelHash(result.model);
    const report = {
        generatedAt: new Date().toISOString(),
        trainingScope: hasTenantScope ? 'tenant' : 'global',
        tenantId: hasTenantScope ? tenantId : null,
        globalTrainingGovernanceApproved: globalTrainingRequested,
        codeVersion,
        weightsHash,
        ...result
    };
    if (hasFlag('--register')) {
        report.frozenEvaluation = await loadFrozenEvaluationEvidence(result.model.modelVersion);
    }
    const reportPath = arg('--report', '');
    if (reportPath) await require('node:fs').promises.writeFile(path.resolve(reportPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
    if (hasFlag('--write-candidate')) {
        const modelFile = arg('--model-file', '');
        if (!modelFile) throw new Error('--write-candidate 必须指定 --model-file');
        await writeLocalLinearDecisionModel(result.model, {
            rootDir: arg('--model-root', process.env.PIVOT_LIGHT_DECISION_MODEL_ROOT || 'data/decision-models'),
            modelFile
        });
    }
    if (hasFlag('--register')) {
        await registerDecisionModelArtifact({
            providerId: result.model.providerId,
            modelVersion: result.model.modelVersion,
            dataVersion: result.datasetVersion,
            codeVersion,
            weightsHash,
            calibration: result.calibration,
            evaluationReport: report,
            trainingTenantId: hasTenantScope ? tenantId : null,
            globalTrainingApproved: globalTrainingRequested
        });
    }
    process.stdout.write(JSON.stringify({
        datasetVersion: result.datasetVersion,
        tenantId: hasTenantScope ? tenantId : null,
        modelVersion: result.model.modelVersion,
        splitCounts: result.splitCounts,
        candidate: result.candidate,
        baseline: result.baseline,
        calibration: result.calibration,
        releaseGate: result.releaseGate,
        wroteCandidate: hasFlag('--write-candidate'),
        registered: hasFlag('--register')
    }, null, 2) + '\n');
    if (!result.releaseGate.passed) process.exitCode = 2;
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
