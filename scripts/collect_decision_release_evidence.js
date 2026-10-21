'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { getDecisionRuntimeConfig } = require('../server/services/decision-runtime');
const { getDecisionDeploymentReadiness } = require('../server/services/decision-deployment-readiness');
const { getDecisionMaintenanceReport } = require('../server/services/decision-maintenance');
const { getDecisionEvaluationReviewStatus } = require('../server/services/decision-evaluation-reviews');
const { listDecisionModelArtifacts } = require('../server/services/decision-model-registry');
const { sampleDecisionGpu } = require('../server/services/decision-gpu-sampling');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function summarizeArtifact(value = {}) {
    const report = value.evaluationReport && typeof value.evaluationReport === 'object' ? value.evaluationReport : {};
    return {
        id: String(value.id || ''), providerId: String(value.provider_id || ''), modelVersion: String(value.model_version || ''),
        dataVersion: String(value.data_version || ''), codeVersion: String(value.code_version || ''),
        weightsHash: String(value.weights_hash || ''), status: String(value.status || ''),
        releaseGatePassed: report.releaseGate?.passed === true || report.passed === true
    };
}

async function main() {
    const config = getDecisionRuntimeConfig(process.env);
    const gpuSampleTimeoutMs = config.gpuSampleTimeoutMs;
    const evaluationSetVersion = String(config.evaluationSetVersion || '');
    const [deployment, maintenance, evaluationReviews, artifacts, gpu] = await Promise.all([
        getDecisionDeploymentReadiness(),
        getDecisionMaintenanceReport({ lookbackDays: arg('--lookback-days', '30') }),
        getDecisionEvaluationReviewStatus(evaluationSetVersion),
        listDecisionModelArtifacts({ limit: 100 }),
        sampleDecisionGpu({ timeoutMs: gpuSampleTimeoutMs })
    ]);
    const report = {
        generatedAt: new Date().toISOString(),
        kind: 'pivot_decision_release_evidence_snapshot',
        runtime: {
            mode: config.mode, policyVersion: config.version, evaluationSetVersion, rolloutPercent: config.rolloutPercent,
            gpuSampleTimeoutMs,
            providers: {
                qwen: { enabled: config.qwen.enabled, version: config.qwen.version },
                light: { enabled: config.light.enabled, modelFileConfigured: Boolean(config.light.modelFile) }
            }
        },
        deploymentReadiness: deployment,
        evaluationReviews,
        gpu,
        maintenance: {
            unavailable: maintenance.unavailable, lookbackDays: maintenance.lookbackDays,
            readiness: maintenance.readiness, errorBreakdown: maintenance.errorBreakdown
        },
        artifacts: artifacts.map(summarizeArtifact)
    };
    const output = arg('--output');
    if (output) await fs.promises.writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
