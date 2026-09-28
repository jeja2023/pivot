'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { queryOne } = require('../server/db/client');
const { getRunnableModelForUserAsync } = require('../server/services/models');
const { callModelText } = require('../server/services/agent-model');
const { benchmarkDecisionProviders } = require('../server/services/decision-benchmark');
const { createHttpDecisionProvider, createLinearDecisionProvider, createStructuredModelDecisionProvider } = require('../server/services/decision-provider');
const { loadLocalLinearDecisionModel } = require('../server/services/decision-light-model');
const { getDecisionRuntimeConfig } = require('../server/services/decision-runtime');
const { loadReviewedDecisionEvaluationCases } = require('../server/services/decision-evaluation-reviews');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function loadJson(filePath, fallback = {}) {
    if (!filePath) return fallback;
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function normalizeBaselineResults(source = {}) {
    const records = source?.cases && typeof source.cases === 'object' ? source.cases : source;
    return records && typeof records === 'object' ? records : {};
}

function buildExistingRouterProvider(results = {}) {
    return {
        id: 'existing-router',
        version: String(results.version || 'captured-shadow-results').slice(0, 128),
        weight: 1,
        async decide(context) {
            const record = results[context.decisionId] || {};
            return {
                selectedActionId: record.selectedActionId || record.selected_action_id || '',
                scores: record.scores || record.actionScores || {},
                metadata: { model: 'captured-shadow-router', configurationVersion: String(results.version || '') }
            };
        }
    };
}

function verifiedCases(source = {}) {
    const cases = Array.isArray(source?.cases) ? source.cases : [];
    const pending = cases.filter(item => item?.reviewStatus !== 'verified');
    if (pending.length) throw new Error('冻结评测集仍有 ' + pending.length + ' 个未核验用例，不能执行正式基准测试。');
    return cases;
}

async function createQwenProvider(modelRef, userId, weight) {
    const safeUserId = Number.parseInt(userId, 10);
    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0 || !modelRef) throw new Error('Qwen 基准需要 --qwen-user-id 和 --qwen-model。');
    const user = await queryOne("SELECT id, username, nickname, unit, role FROM users WHERE id = ? AND deleted_at IS NULL AND status <> 'disabled'", [safeUserId]);
    if (!user) throw new Error('Qwen 基准用户不存在或已停用。');
    const modelCfg = await getRunnableModelForUserAsync(modelRef, user);
    if (!modelCfg) throw new Error('Qwen 基准模型不可用或无权使用。');
    return createStructuredModelDecisionProvider({ id: 'qwen', version: modelCfg.model_name || modelCfg.name, modelCfg, user, invoke: callModelText, maxTokens: Number.parseInt(arg('--qwen-max-tokens', '256'), 10) || 256, weight });
}

async function main() {
    const reviewedSetVersion = arg('--reviewed-set-version');
    const evaluationSet = loadJson(arg('--evaluation-set', path.resolve(__dirname, '../docs/decision-evaluation-set.v2.json')));
    const cases = reviewedSetVersion
        ? await loadReviewedDecisionEvaluationCases(reviewedSetVersion)
        : verifiedCases(evaluationSet);
    const requested = new Set(arg('--providers', 'laya,light,qwen').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
    const config = getDecisionRuntimeConfig(process.env);
    const providers = [];
    if (requested.has('existing-router') || requested.has('baseline')) {
        const baselineFile = arg('--baseline-results');
        if (!baselineFile) throw new Error('比较现有路由需要 --baseline-results <影子结果JSON>。');
        providers.push(buildExistingRouterProvider(normalizeBaselineResults(loadJson(baselineFile))));
    }
    if (requested.has('light')) {
        const model = await loadLocalLinearDecisionModel({
            rootDir: arg('--light-model-root', config.light.modelRoot),
            modelFile: arg('--light-model-file', config.light.modelFile)
        });
        providers.push(createLinearDecisionProvider({ id: 'light-linear', version: model.modelVersion, model, weight: config.light.weight }));
    }
    if (requested.has('laya')) {
        const url = arg('--laya-url', config.laya.url);
        if (!url) throw new Error('Laya 基准需要 --laya-url 或 PIVOT_LAYA_DECISION_URL。');
        providers.push(createHttpDecisionProvider({
            id: 'laya', version: arg('--laya-version', config.laya.version), url,
            timeoutMs: Number.parseInt(arg('--laya-timeout-ms', config.laya.timeoutMs), 10) || config.laya.timeoutMs,
            weight: config.laya.weight
        }));
    }
    if (requested.has('qwen')) providers.push(await createQwenProvider(arg('--qwen-model'), arg('--qwen-user-id'), config.qwen.weight));
    if (!providers.length) throw new Error('没有可执行的基准提供器。');
    const report = await benchmarkDecisionProviders({ cases, providers });
    const output = { generatedAt: new Date().toISOString(), evaluationSetVersion: evaluationSet.version || '', providers: [...requested], ...report };
    const reportFile = arg('--report');
    if (reportFile) await fs.promises.writeFile(path.resolve(reportFile), JSON.stringify(output, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
