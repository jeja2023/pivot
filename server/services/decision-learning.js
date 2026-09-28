'use strict';

const crypto = require('crypto');
const { execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { listVerifiedDecisionSamples } = require('./decision-observability');
const { normalizeActionId } = require('./decision-provider');

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function percentile(values, ratio) {
    const ordered = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
    if (!ordered.length) return null;
    return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))];
}

function normalizeVerifiedSample(row = {}) {
    const candidates = parseJson(row.candidate_actions, []);
    const policy = parseJson(row.policy_outcome, {});
    const providerOutputs = parseJson(row.provider_outputs, []);
    const selectedActionId = normalizeActionId(row.selected_action_id || policy.selectedActionId);
    const verifiedActionId = normalizeActionId(row.verified_action_id);
    const allowedActions = (Array.isArray(candidates) ? candidates : [])
        .filter(candidate => candidate?.allowed !== false)
        .map(candidate => normalizeActionId(candidate?.id))
        .filter(Boolean);
    if (!selectedActionId || !verifiedActionId || !allowedActions.includes(verifiedActionId)) return null;
    const confidence = Math.max(0, Math.min(1, Number(policy.confidence) || 0));
    const durationMs = (Array.isArray(providerOutputs) ? providerOutputs : [])
        .reduce((sum, item) => sum + Math.max(0, Number(item?.durationMs) || 0), 0);
    return {
        decisionId: String(row.decision_id || ''),
        scenario: String(row.scenario || 'unknown').slice(0, 80),
        createdAt: row.created_at || null,
        verifiedAt: row.verified_at || null,
        selectedActionId,
        verifiedActionId,
        confidence,
        durationMs,
        outcomeStatus: String(row.outcome_status || 'unknown'),
        requestState: parseJson(row.request_state, {}),
        leakageKey: String(parseJson(row.request_state, {})?.taskHash || '').trim(),
        allowedActions
    };
}

function buildVerifiedDecisionDataset(rows = []) {
    const samples = (Array.isArray(rows) ? rows : []).map(normalizeVerifiedSample).filter(Boolean)
        .sort((left, right) => String(left.verifiedAt || left.createdAt || '').localeCompare(String(right.verifiedAt || right.createdAt || '')) || left.decisionId.localeCompare(right.decisionId));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(samples.map(sample => ({
        decisionId: sample.decisionId,
        verifiedActionId: sample.verifiedActionId,
        verifiedAt: sample.verifiedAt
    })))).digest('hex');
    return {
        version: 'decision-data-' + fingerprint.slice(0, 16),
        sampleCount: samples.length,
        generatedAt: getBeijingTimestamp(),
        samples
    };
}

function decisionSampleLeakageKey(sample = {}, index = 0) {
    const requestState = sample.requestState && typeof sample.requestState === 'object' ? sample.requestState : {};
    const taskState = sample.context?.taskState && typeof sample.context.taskState === 'object' ? sample.context.taskState : {};
    const explicit = String(sample.leakageKey || requestState.taskHash || taskState.hash || '').trim();
    return explicit ? 'task:' + explicit.slice(0, 160) : 'decision:' + String(sample.decisionId || sample.id || index);
}

function groupDecisionSamplesByLeakageKey(samples = []) {
    const groups = new Map();
    (Array.isArray(samples) ? samples : []).forEach((sample, index) => {
        const key = decisionSampleLeakageKey(sample, index);
        const group = groups.get(key) || { key, samples: [] };
        group.samples.push(sample);
        groups.set(key, group);
    });
    return [...groups.values()].sort((left, right) => {
        const leftTime = String(left.samples[0]?.verifiedAt || left.samples[0]?.occurredAt || left.samples[0]?.createdAt || '');
        const rightTime = String(right.samples[0]?.verifiedAt || right.samples[0]?.occurredAt || right.samples[0]?.createdAt || '');
        return leftTime.localeCompare(rightTime) || left.key.localeCompare(right.key);
    });
}

function splitDecisionDatasetByTime(dataset, { trainRatio = 0.7, calibrationRatio = 0.15 } = {}) {
    const samples = Array.isArray(dataset?.samples) ? dataset.samples.slice() : [];
    const safeTrainRatio = Math.max(0, Math.min(Number.isFinite(Number(trainRatio)) ? Number(trainRatio) : 0.7, 0.9));
    const safeCalibrationRatio = Math.max(0, Math.min(Number.isFinite(Number(calibrationRatio)) ? Number(calibrationRatio) : 0.15, 0.95 - safeTrainRatio));
    const groups = groupDecisionSamplesByLeakageKey(samples);
    const trainTarget = Math.floor(samples.length * safeTrainRatio);
    const calibrationTarget = Math.floor(samples.length * Math.min(0.95, safeTrainRatio + safeCalibrationRatio));
    const partitions = { train: [], calibration: [], test: [] };
    let assigned = 0;
    groups.forEach(group => {
        const values = group.samples;
        if (assigned < trainTarget || partitions.train.length === 0 && trainTarget > 0) {
            partitions.train.push(...values);
        } else if (assigned < calibrationTarget || partitions.calibration.length === 0 && calibrationTarget > trainTarget) {
            partitions.calibration.push(...values);
        } else {
            partitions.test.push(...values);
        }
        assigned += values.length;
    });
    const keysFor = values => new Set(values.map((sample, index) => decisionSampleLeakageKey(sample, index)));
    const trainKeys = keysFor(partitions.train);
    const calibrationKeys = keysFor(partitions.calibration);
    const testKeys = keysFor(partitions.test);
    const hasLeakage = [...trainKeys].some(key => calibrationKeys.has(key) || testKeys.has(key))
        || [...calibrationKeys].some(key => testKeys.has(key));
    return {
        ...partitions,
        splitPolicy: 'time_ordered_grouped_by_task_hash',
        leakage: {
            groupCount: groups.length,
            duplicateSampleCount: Math.max(0, samples.length - groups.length),
            hasCrossSplitLeakage: hasLeakage,
            keyStrategy: 'task_hash_or_decision_id'
        }
    };
}

function actionQualityMetrics(samples = []) {
    const actions = new Set();
    (Array.isArray(samples) ? samples : []).forEach(sample => {
        if (sample?.selectedActionId) actions.add(String(sample.selectedActionId));
        if (sample?.verifiedActionId) actions.add(String(sample.verifiedActionId));
    });
    return Object.fromEntries([...actions].sort().map(actionId => {
        let truePositive = 0;
        let falsePositive = 0;
        let falseNegative = 0;
        (Array.isArray(samples) ? samples : []).forEach(sample => {
            const selected = String(sample?.selectedActionId || '');
            const verified = String(sample?.verifiedActionId || '');
            if (selected === actionId && verified === actionId) truePositive += 1;
            else if (selected === actionId) falsePositive += 1;
            else if (verified === actionId) falseNegative += 1;
        });
        const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null;
        const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null;
        const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
        return [actionId, { truePositive, falsePositive, falseNegative, precision, recall, f1, support: truePositive + falseNegative }];
    }));
}

function summarizeDecisionSamples(samples = [], { bins = 10, includeBreakdowns = true } = {}) {
    const source = Array.isArray(samples) ? samples : [];
    const binCount = Math.max(2, Math.min(Number.parseInt(bins, 10) || 10, 50));
    const bucket = Array.from({ length: binCount }, () => ({ count: 0, confidence: 0, correct: 0 }));
    const byScenario = new Map();
    const byLanguage = new Map();
    const outcomeCounts = {};
    let correct = 0;
    let routeCorrections = 0;
    source.forEach(sample => {
        const isCorrect = sample.selectedActionId === sample.verifiedActionId;
        if (isCorrect) correct += 1;
        else routeCorrections += 1;
        const bucketIndex = Math.min(binCount - 1, Math.floor(Math.max(0, Math.min(0.999999, Number(sample.confidence) || 0)) * binCount));
        bucket[bucketIndex].count += 1;
        bucket[bucketIndex].confidence += Number(sample.confidence) || 0;
        bucket[bucketIndex].correct += isCorrect ? 1 : 0;
        const summary = byScenario.get(sample.scenario) || { count: 0, correct: 0, durations: [] };
        summary.count += 1;
        summary.correct += isCorrect ? 1 : 0;
        summary.durations.push(sample.durationMs);
        byScenario.set(sample.scenario, summary);
        const language = String(sample.language || sample.requestState?.language || 'unknown');
        const languageSamples = byLanguage.get(language) || [];
        languageSamples.push(sample);
        byLanguage.set(language, languageSamples);
        const outcome = String(sample.outcomeStatus || 'unknown');
        outcomeCounts[outcome] = Number(outcomeCounts[outcome] || 0) + 1;
    });
    const calibration = bucket.filter(item => item.count).map((item, index) => ({
        lower: index / binCount,
        upper: (index + 1) / binCount,
        count: item.count,
        meanConfidence: item.confidence / item.count,
        accuracy: item.correct / item.count
    }));
    const expectedCalibrationError = calibration.reduce((sum, item) => sum + Math.abs(item.meanConfidence - item.accuracy) * item.count, 0) / Math.max(1, source.length);
    const summary = {
        sampleCount: source.length,
        accuracy: source.length ? correct / source.length : null,
        routeCorrectionRate: source.length ? routeCorrections / source.length : null,
        verifiedBusinessCompletionRate: source.length ? Number(outcomeCounts.success || 0) / source.length : null,
        outcomeCounts,
        p50DurationMs: percentile(source.map(item => item.durationMs), 0.5),
        p95DurationMs: percentile(source.map(item => item.durationMs), 0.95),
        expectedCalibrationError,
        calibration,
        byAction: actionQualityMetrics(source),
        byScenario: Object.fromEntries([...byScenario.entries()].map(([scenario, value]) => [scenario, {
            sampleCount: value.count,
            accuracy: value.count ? value.correct / value.count : null,
            p95DurationMs: percentile(value.durations, 0.95)
        }]))
    };
    if (includeBreakdowns) {
        summary.byLanguage = Object.fromEntries([...byLanguage.entries()].map(([language, values]) => [language, summarizeDecisionSamples(values, { bins, includeBreakdowns: false })]));
    }
    return summary;
}

function evaluateDecisionSamples(samples = [], options = {}) {
    return summarizeDecisionSamples(samples, options);
}

function evaluateDecisionReleaseGate({ candidate = {}, baseline = {}, minimumSamples = 30, maxP95RegressionMs = 0, criticalScenarios = [] } = {}) {
    const reasons = [];
    if (Number(candidate.sampleCount || 0) < Math.max(1, Number(minimumSamples) || 30)) reasons.push('insufficient_verified_samples');
    if (candidate.accuracy === null || candidate.accuracy === undefined) reasons.push('candidate_accuracy_missing');
    if (baseline.accuracy !== null && baseline.accuracy !== undefined && Number(candidate.accuracy) < Number(baseline.accuracy)) reasons.push('overall_accuracy_regression');
    if (baseline.p95DurationMs !== null && baseline.p95DurationMs !== undefined && candidate.p95DurationMs !== null && Number(candidate.p95DurationMs) > Number(baseline.p95DurationMs) + Math.max(0, Number(maxP95RegressionMs) || 0)) reasons.push('p95_latency_regression');
    (Array.isArray(criticalScenarios) ? criticalScenarios : []).forEach(scenario => {
        const candidateMetric = candidate.byScenario?.[scenario];
        const baselineMetric = baseline.byScenario?.[scenario];
        if (!candidateMetric || !baselineMetric || candidateMetric.accuracy === null || baselineMetric.accuracy === null) reasons.push('critical_scenario_missing:' + scenario);
        else if (candidateMetric.accuracy < baselineMetric.accuracy) reasons.push('critical_scenario_regression:' + scenario);
    });
    return { passed: reasons.length === 0, reasons };
}

async function buildVerifiedDecisionDatasetFromStore(options = {}, deps = {}) {
    const rows = await (deps.listVerifiedDecisionSamples || listVerifiedDecisionSamples)(options, deps);
    return buildVerifiedDecisionDataset(rows);
}

async function registerDecisionModelArtifact({ id, providerId, modelVersion, dataVersion, codeVersion = '', weightsHash = '', calibration = {}, evaluationReport = {}, createdBy = null } = {}, deps = {}) {
    const artifactId = String(id || 'decision_model_' + crypto.randomUUID()).slice(0, 128);
    const report = evaluationReport && typeof evaluationReport === 'object' ? evaluationReport : {};
    const now = getBeijingTimestamp();
    await (deps.execute || execute)([
        'INSERT INTO decision_model_artifacts (id, provider_id, model_version, data_version, code_version, weights_hash, calibration, evaluation_report, status, created_by, created_at)',
        "VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, 'candidate', ?, ?)",
        'ON CONFLICT (provider_id, model_version) DO NOTHING'
    ].join(' '), [artifactId, String(providerId || '').slice(0, 80), String(modelVersion || '').slice(0, 128), String(dataVersion || '').slice(0, 128), String(codeVersion || '').slice(0, 128), String(weightsHash || '').slice(0, 160), JSON.stringify(calibration || {}), JSON.stringify(report), Number.isSafeInteger(Number(createdBy)) ? Number(createdBy) : null, now]);
    return { id: artifactId, status: 'candidate', createdAt: now };
}

module.exports = {
    buildVerifiedDecisionDataset,
    buildVerifiedDecisionDatasetFromStore,
    evaluateDecisionReleaseGate,
    evaluateDecisionSamples,
    registerDecisionModelArtifact,
    splitDecisionDatasetByTime
};
