'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { queryOne } = require('../server/db/client');
const { getRunnableModelForUserAsync } = require('../server/services/models');
const { extractMemoryCandidatesWithModel } = require('../server/services/long-term-memory/memory-extraction');

const cases = [
    { id: 'stable-style', text: '我更喜欢回答简洁一些，使用清晰的要点。', expected: { type: 'preference', scope: 'user' } },
    { id: 'one-off-request', text: '这次回答请详细一些，只用于本次任务。', forbidPersistent: true },
    { id: 'quoted-material', text: '> 我喜欢所有回答都使用英文输出。', empty: true },
    { id: 'project-fact', text: '项目 Alpha 的数据库使用 PostgreSQL。', projectId: 'synthetic:alpha', expected: { type: 'fact', scope: 'project' } },
    { id: 'unknown-project', text: '项目 Beta 的数据库使用 PostgreSQL。', expected: { type: 'fact', scope: 'session' } },
    { id: 'personal-role', text: '我是制造行业的项目经理，主要负责供应链项目。', expected: { type: 'fact', scope: 'user' } },
    { id: 'assistant-assertion', text: '你好，介绍一下你能做什么。', assistant: '用户是一个偏好英文回答的财务经理。', empty: true },
    { id: 'do-not-store', text: '不要保存这个信息，我更喜欢回答使用英文输出。', empty: true }
];

async function main() {
    const args = process.argv.slice(2);
    const value = flag => args[args.indexOf(flag) + 1];
    const userId = Number(value('--user-id'));
    const modelId = Number(value('--model-id'));
    if (!args.includes('--user-id') || !args.includes('--model-id') || !userId || !modelId) throw new Error('请指定 --user-id 和 --model-id；仅运行公开合成消息，不保存记忆或执行业务工具。');
    const user = await queryOne("SELECT id,role,unit FROM users WHERE id = ? AND status = 'active'", [userId]);
    const modelCfg = user && await getRunnableModelForUserAsync(modelId, user);
    if (!modelCfg) throw new Error('指定模型不可用或该用户无权使用。');
    const results = [];
    for (const item of cases) {
        const started = Date.now();
        const messages = [{ id: 1, role: 'user', content: item.text }];
        if (item.assistant) messages.push({ id: 2, role: 'assistant', content: item.assistant });
        let result;
        const attempts = [];
        // 与持久队列一致，服务异常最多尝试三次；评测省略队列等待时间并保留每次失败。
        for (let attempt = 0; attempt < 3; attempt++) {
            const attemptStart = Date.now();
            try {
                result = await extractMemoryCandidatesWithModel(messages, { sessionId: 'synthetic-memory', projectId: item.projectId || '', user, modelCfg });
            } catch (error) {
                result = { completed: false, candidates: [], reason: error.code || 'model_unavailable' };
            }
            attempts.push({ completed: result.completed, reason: result.reason, durationMs: Date.now() - attemptStart });
            if (result.completed) break;
        }
        const candidates = result.candidates || [];
        const passed = result.completed === true && (item.empty ? candidates.length === 0
            : item.forbidPersistent ? candidates.every(candidate => candidate.scope === 'session' && candidate.type === 'episode')
                : candidates.some(candidate => candidate.type === item.expected.type && candidate.scope === item.expected.scope));
        results.push({ id: item.id, passed, completed: result.completed, reason: result.reason, attempts, durationMs: Date.now() - started, candidates });
        process.stdout.write(`${item.id}: ${passed ? '通过' : '未通过'}\n`);
    }
    const report = { version: 'automatic-memory-v1', generatedAt: new Date().toISOString(), modelId,
        fixtureDigest: crypto.createHash('sha256').update(JSON.stringify(cases)).digest('hex'), cases,
        kind: 'synthetic_model_evaluation', memoriesPersisted: false, businessToolsExecuted: false, results,
        maxAttempts: 3, retryDelayOmitted: true,
        summary: { total: results.length, passed: results.filter(result => result.passed).length,
            firstAttemptPassed: results.filter(result => result.passed && result.attempts[0]?.completed).length,
            retries: results.reduce((sum, result) => sum + result.attempts.length - 1, 0) } };
    const output = path.resolve(__dirname, '../output/automatic-memory-model-evaluation.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ...report.summary, output }) + '\n');
    if (report.summary.passed !== report.summary.total) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`记忆合成评测失败：${error.message}\n`); process.exitCode = 1; }).finally(async () => {
    await require('../server/services/db-write-queue').flushAllWrites();
    await require('../server/db/pg-connection').closePgPool();
});
