'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { queryOne } = require('../server/db/client');
const { getRunnableModelForUserAsync } = require('../server/services/models');
const { resolveChatIntent } = require('../server/services/chat-intent-resolver');
const { classifyChatAutoExecution } = require('../server/services/chat-auto-execution');
const { evaluateChatIntentCase, summarizeChatIntentEvaluation } = require('./lib/chat_intent_evaluation');
const boundaryFixtures = require('../tests/fixtures/chat-intent-cases.v8.json');
const holdoutFixtures = require('../tests/fixtures/chat-intent-holdout-cases.v2.json');
const { evaluateChatIntentEntry } = require('./lib/chat_intent_entry_evaluation');
const { chatIntentImplementation } = require('./lib/chat_intent_implementation');
const manifest = require('../tests/fixtures/chat-intent-evaluation-manifest.v2.json');

async function main() {
    const args = process.argv.slice(2);
    const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const userId = Number(value('--user-id'));
    const modelId = Number(value('--model-id'));
    if (!args.includes('--user-id') || !args.includes('--model-id') || !userId || !modelId) throw new Error('请指定 --user-id 和 --model-id。仅对给定账号可用模型运行公开合成问题，不执行业务工具。');
    for (const entry of manifest.suites) {
        const bytes = await fs.readFile(path.resolve(__dirname, '../tests/fixtures', entry.file));
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('评测集摘要与冻结清单不一致，请先复核并创建新版本。');
    }
    const user = await queryOne("SELECT id,role,unit FROM users WHERE id = ? AND status = 'active'", [userId]);
    const model = user && await getRunnableModelForUserAsync(modelId, user);
    if (!model) throw new Error('指定用户无权使用该模型或模型不可用。');
    const suite = value('--suite') || 'all';
    const entryPoint = value('--entry-point') || 'both';
    const concurrency = Number(value('--concurrency') || 1);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('评测并发必须为 1 到 4。');
    if (!['all', 'boundary', 'holdout'].includes(suite) || !['both', 'resolver', 'handler'].includes(entryPoint)) throw new Error('请选择有效的评测集和入口：--suite all|boundary|holdout，--entry-point both|resolver|handler。');
    const fixtures = { version: 'chat-intent-engineering-v8', cases: [...(suite !== 'holdout' ? boundaryFixtures.cases : []), ...(suite !== 'boundary' ? holdoutFixtures.cases : [])] };
    const selectedIds = new Set(String(value('--case-ids') || '').split(',').filter(Boolean));
    const cases = selectedIds.size ? fixtures.cases.filter(item => selectedIds.has(item.id)) : fixtures.cases;
    if (!cases.length || [...selectedIds].some(id => !cases.some(item => item.id === id))) throw new Error('评测案例标识不存在。');
    const results = [];
    const output = value('--output') ? path.resolve(value('--output')) : path.resolve(__dirname, '../output/chat-intent-model-evaluation.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    const routingConfig = { mode: 'active', timeoutMs: 30000, rolloutPercent: 100, ...require('../server/services/chat-route-config').getChatAutoRouteConfig() };
    const implementation = await chatIntentImplementation(path.resolve(__dirname, '..'), routingConfig);
    const jobs = cases.flatMap(item => (entryPoint === 'both' ? ['resolver', 'handler'] : [entryPoint]).map(evaluatedEntryPoint => ({ item, evaluatedEntryPoint })));
    const fixtureDigest = crypto.createHash('sha256').update(JSON.stringify(fixtures)).digest('hex');
    const baseReport = { fixtureVersion: fixtures.version, fixtureDigest, manifestVersion: manifest.version, ...implementation, suite, entryPoint, concurrency, modelId,
        kind: 'synthetic_model_evaluation', businessToolsExecuted: false, selectedCaseIds: cases.map(item => item.id), evaluationCases: cases };
    let checkpoint = Promise.resolve();
    const saveCheckpoint = complete => {
        const finished = results.filter(Boolean);
        const snapshot = JSON.stringify({ ...baseReport, complete, generatedAt: new Date().toISOString(), completedJobs: finished.length, totalJobs: jobs.length,
            results: finished, summary: summarizeChatIntentEvaluation(finished) }, null, 2) + '\n';
        checkpoint = checkpoint.then(async () => { await fs.writeFile(output + '.tmp', snapshot); await fs.rename(output + '.tmp', output); });
        return checkpoint;
    };
    await saveCheckpoint(false);
    let nextJob = 0;
    const executeJobs = async () => {
        while (nextJob < jobs.length) {
            const jobIndex = nextJob++;
            const { item, evaluatedEntryPoint } = jobs[jobIndex];
            const start = Date.now();
            const baseline = classifyChatAutoExecution({ prompt: item.prompt, history: item.history || [] });
            const input = { prompt: item.prompt, history: item.history || [], tasks: item.tasks || [], providedSources: item.providedSources || [], availability: item.availability || {}, user, userMessageId: 1, sessionId: 'engineering-benchmark', modelCfg: model };
            const resolve = input => resolveChatIntent(input, { config: { mode: 'active', timeoutMs: 30000, rolloutPercent: 100 }, recordDecision() {} });
            const decision = evaluatedEntryPoint === 'handler' ? await evaluateChatIntentEntry(item, input, resolve) : await resolve(input);
            const evaluation = evaluateChatIntentCase(item, decision);
            results[jobIndex] = { id: item.id, entryPoint: evaluatedEntryPoint, expected: item.expected, expectedRouting: item.expectedRouting || null, actual: decision.action, routing: decision.routing || null, ...evaluation,
                critical: Boolean(item.critical), baseline: baseline.action, baselinePassed: item.expected.includes(baseline.action), durationMs: Date.now() - start, reason: decision.reasonCode,
                failureCode: decision.failureCode || '', contractFailureReason: decision.contractFailureReason || '', question: decision.question || '', businessScope: decision.businessScope || {}, requiredCapabilities: decision.requiredCapabilities || [], constraints: decision.constraints || [], modelCalls: decision.modelCalls || 0, providerRetries: decision.providerRetries || 0,
                providerAction: decision.providerAction || '', contractAdjustments: decision.contractAdjustments || [], usage: decision.usage || null, timing: decision.timing || null, structuredOutput: decision.structuredOutput || null, evaluationEffects: decision.evaluationEffects || [], acceptance: decision.acceptance || null, continuationOf: decision.continuationOf || null };
            process.stdout.write(`${item.id} [${evaluatedEntryPoint}]: ${decision.action} ${evaluation.passed ? '通过' : '未通过'}\n`);
            await saveCheckpoint(false);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, executeJobs));
    const completedImplementation = await chatIntentImplementation(path.resolve(__dirname, '..'), routingConfig);
    const implementationSnapshotMatches = completedImplementation.implementationDigest === implementation.implementationDigest;
    await checkpoint;
    const report = { ...baseReport, complete: true, completedJobs: results.length, totalJobs: jobs.length, implementationSnapshotMatches,
        completedImplementationDigest: completedImplementation.implementationDigest, generatedAt: new Date().toISOString(), results, summary: summarizeChatIntentEvaluation(results) };
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ...report.summary, output }) + '\n');
    if (!implementationSnapshotMatches || report.summary.criticalFailures || report.summary.passed / report.summary.total < 0.9) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`对话意图评测失败：${error.message}\n`); process.exitCode = 1; }).finally(async () => {
    await require('../server/services/db-write-queue').flushAllWrites();
    await require('../server/db/pg-connection').closePgPool();
});
