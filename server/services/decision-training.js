'use strict';

const crypto = require('crypto');
const { decisionFeatureMap, linearScores, normalizeActionId } = require('./decision-provider');
const { buildVerifiedDecisionDataset, evaluateDecisionReleaseGate, evaluateDecisionSamples, splitDecisionDatasetByTime } = require('./decision-learning');

const SMOOTHING = 1;

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function toTaskState(requestState = {}) {
    const source = requestState && typeof requestState === 'object' ? requestState : {};
    return {
        hash: String(source.taskHash || ''),
        status: String(source.status || 'active'),
        evidenceNeeds: Array.isArray(source.evidenceNeeds) ? source.evidenceNeeds : [],
        constraints: Array.from({ length: Math.max(0, Math.min(Number(source.constraintCount) || 0, 32)) }, () => 'present'),
        entities: Array.from({ length: Math.max(0, Math.min(Number(source.entityCount) || 0, 32)) }, () => 'present'),
        toolIntent: { requestedCapabilities: Array.isArray(source.requestedCapabilities) ? source.requestedCapabilities : [] }
    };
}

function toTrainingExample(row = {}) {
    const candidates = parseJson(row.candidate_actions, []);
    const requestState = parseJson(row.request_state, {});
    const label = normalizeActionId(row.verified_action_id);
    const baselineActionId = normalizeActionId(row.selected_action_id);
    const allowed = (Array.isArray(candidates) ? candidates : []).filter(candidate => candidate?.allowed !== false)
        .map(candidate => normalizeActionId(candidate?.id)).filter(Boolean);
    if (!label || !baselineActionId || !allowed.includes(label)) return null;
    return {
        decisionId: String(row.decision_id || ''),
        scenario: String(row.scenario || 'unknown'),
        context: {
            scenario: String(row.scenario || 'unknown'),
            taskState: toTaskState(requestState),
            candidates
        },
        label,
        baselineActionId,
        durationMs: (parseJson(row.provider_outputs, []) || []).reduce((sum, item) => sum + Math.max(0, Number(item?.durationMs) || 0), 0),
        occurredAt: row.verified_at || row.created_at || null
    };
}

function buildTrainingExamples(rows = []) {
    return (Array.isArray(rows) ? rows : []).map(toTrainingExample).filter(Boolean)
        .sort((left, right) => String(left.occurredAt || '').localeCompare(String(right.occurredAt || '')) || left.decisionId.localeCompare(right.decisionId));
}

function chooseAction(scores = {}, context = {}) {
    const allowed = (context.candidates || []).filter(candidate => candidate?.allowed !== false)
        .map(candidate => normalizeActionId(candidate?.id)).filter(Boolean);
    return allowed.slice().sort((left, right) => Number(scores[right] || 0) - Number(scores[left] || 0) || left.localeCompare(right))[0] || '';
}

function trainLinearDecisionModel(examples = [], options = {}) {
    const source = Array.isArray(examples) ? examples : [];
    const labels = [...new Set(source.map(example => example.label))].sort();
    if (!source.length || !labels.length) throw new Error('insufficient_verified_training_examples');
    const actionCounts = Object.fromEntries(labels.map(label => [label, 0]));
    const featureCounts = Object.fromEntries(labels.map(label => [label, {}]));
    source.forEach(example => {
        actionCounts[example.label] += 1;
        decisionFeatureMap(example.context).forEach(feature => {
            featureCounts[example.label][feature] = Number(featureCounts[example.label][feature] || 0) + 1;
        });
    });
    const total = source.length;
    const actionWeights = Object.fromEntries(labels.map(label => {
        const count = actionCounts[label];
        const features = Object.fromEntries(Object.entries(featureCounts[label]).map(([feature, featureCount]) => [
            feature,
            Math.log((featureCount + SMOOTHING) / (count + SMOOTHING * 2))
        ]));
        return [label, {
            bias: Math.log((count + SMOOTHING) / (total + SMOOTHING * labels.length)),
            features
        }];
    }));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ labels, actionCounts, featureCounts })).digest('hex');
    return {
        schemaVersion: 1,
        providerId: 'light-linear',
        modelVersion: String(options.modelVersion || 'light-linear-' + fingerprint.slice(0, 16)).slice(0, 128),
        actionWeights,
        metadata: { trainingExamples: total, labels, smoothing: SMOOTHING, trainingFingerprint: fingerprint }
    };
}

function evaluateModelExamples(examples = [], model = {}) {
    const scored = (Array.isArray(examples) ? examples : []).map(example => {
        const scores = linearScores(example.context, model);
        const selectedActionId = chooseAction(scores, example.context);
        return {
            ...example,
            selectedActionId,
            verifiedActionId: example.label,
            confidence: Number(scores[selectedActionId] || 0)
        };
    });
    const metrics = evaluateDecisionSamples(scored);
    return { examples: scored, metrics };
}

function evaluateBaselineExamples(examples = []) {
    const scored = (Array.isArray(examples) ? examples : []).map(example => ({
        ...example,
        selectedActionId: example.baselineActionId,
        verifiedActionId: example.label,
        confidence: 1
    }));
    return { examples: scored, metrics: evaluateDecisionSamples(scored) };
}

function fitCalibration(examples = []) {
    const candidates = [];
    [0.5, 0.75, 1, 1.25, 1.5, 2].forEach(scale => [-0.5, 0, 0.5].forEach(intercept => candidates.push({ scale, intercept })));
    if (!examples.length) return { scale: 1, intercept: 0, brierScore: null, sampleCount: 0 };
    return candidates.map(candidate => {
        const brierScore = examples.reduce((sum, example) => {
            const probability = Math.max(0.0001, Math.min(0.9999, Number(example.confidence) || 0));
            const calibrated = 1 / (1 + Math.exp(-(Math.log(probability / (1 - probability)) * candidate.scale + candidate.intercept)));
            const correct = example.selectedActionId === example.verifiedActionId ? 1 : 0;
            return sum + ((calibrated - correct) ** 2);
        }, 0) / examples.length;
        return { ...candidate, brierScore, sampleCount: examples.length };
    }).sort((left, right) => left.brierScore - right.brierScore || left.scale - right.scale)[0];
}

function trainAndEvaluateLinearDecisionModel(rows = [], options = {}) {
    const dataset = buildVerifiedDecisionDataset(rows);
    const examples = buildTrainingExamples(rows);
    const split = splitDecisionDatasetByTime({ ...dataset, samples: examples }, options.split);
    if (!split.train.length || !split.calibration.length || !split.test.length) throw new Error('insufficient_time_split_examples');
    const model = trainLinearDecisionModel(split.train, { modelVersion: options.modelVersion });
    const calibrationEvaluation = evaluateModelExamples(split.calibration, model);
    const testCandidate = evaluateModelExamples(split.test, model).metrics;
    const testBaseline = evaluateBaselineExamples(split.test).metrics;
    const calibration = fitCalibration(calibrationEvaluation.examples);
    const releaseGate = evaluateDecisionReleaseGate({
        candidate: testCandidate,
        baseline: testBaseline,
        minimumSamples: options.minimumSamples,
        maxP95RegressionMs: options.maxP95RegressionMs,
        criticalScenarios: options.criticalScenarios
    });
    return {
        datasetVersion: dataset.version,
        splitPolicy: split.splitPolicy,
        splitCounts: { train: split.train.length, calibration: split.calibration.length, test: split.test.length },
        leakage: split.leakage,
        model,
        calibration,
        candidate: testCandidate,
        baseline: testBaseline,
        releaseGate
    };
}

module.exports = {
    trainAndEvaluateLinearDecisionModel,
    trainLinearDecisionModel
};
