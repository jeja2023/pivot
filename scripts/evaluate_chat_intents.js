'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { queryOne } = require('../server/db/client');
const { getRunnableModelForUserAsync } = require('../server/services/models');
const { resolveChatIntent } = require('../server/services/chat-intent-resolver');
const { classifyChatAutoExecution } = require('../server/services/chat-auto-execution');
const fixtures = require('../tests/fixtures/chat-intent-cases.json');

async function main() {
    const args = process.argv.slice(2);
    const value = flag => args[args.indexOf(flag) + 1];
    const userId = Number(value('--user-id'));
    const modelId = Number(value('--model-id'));
    if (!args.includes('--user-id') || !args.includes('--model-id') || !userId || !modelId) throw new Error('请指定 --user-id 和 --model-id。仅对给定账号可用模型运行公开合成问题，不执行业务工具。');
    const user = await queryOne("SELECT id,role,unit FROM users WHERE id = ? AND status = 'active'", [userId]);
    const model = user && await getRunnableModelForUserAsync(modelId, user);
    if (!model) throw new Error('指定用户无权使用该模型或模型不可用。');
    const results = [];
    for (const item of fixtures.cases) {
        const start = Date.now();
        const baseline = classifyChatAutoExecution({ prompt: item.prompt, history: item.history || [] });
        const decision = await resolveChatIntent({ prompt: item.prompt, history: item.history || [], tasks: item.tasks || [], providedSources: item.providedSources || [], availability: item.availability || {}, user, userMessageId: 1, sessionId: 'engineering-benchmark', modelCfg: model }, {
            config: { mode: 'active', timeoutMs: 30000, rolloutPercent: 100 }, recordDecision() {}
        });
        const routingPassed = Object.entries(item.expectedRouting || {}).every(([key, value]) => decision.routing?.[key] === value);
        const passed = item.expected.includes(decision.action) && routingPassed;
        results.push({ id: item.id, expected: item.expected, expectedRouting: item.expectedRouting || null, actual: decision.action, routing: decision.routing || null, passed, routingPassed,
            critical: Boolean(item.critical), baseline: baseline.action, baselinePassed: item.expected.includes(baseline.action), durationMs: Date.now() - start, reason: decision.reasonCode });
        process.stdout.write(`${item.id}: ${decision.action} ${passed ? '通过' : '未通过'}\n`);
    }
    const report = { fixtureVersion: fixtures.version, fixtureDigest: crypto.createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'), modelId, generatedAt: new Date().toISOString(), kind: 'synthetic_model_evaluation', businessToolsExecuted: false, results,
        summary: { total: results.length, passed: results.filter(item => item.passed).length, baselinePassed: results.filter(item => item.baselinePassed).length, criticalFailures: results.filter(item => item.critical && !item.passed).length } };
    const output = path.resolve(__dirname, '../output/chat-intent-model-evaluation.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ...report.summary, output }) + '\n');
    if (report.summary.criticalFailures || report.summary.passed / report.summary.total < 0.9) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`对话意图评测失败：${error.message}\n`); process.exitCode = 1; }).finally(async () => {
    await require('../server/services/db-write-queue').flushAllWrites();
    await require('../server/db/pg-connection').closePgPool();
});
