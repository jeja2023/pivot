'use strict';

const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { sourceSnapshot } = require('../scripts/test_support/bi_source_snapshot');
const frozen = process.env.PIVOT_BI_CAPACITY_FROZEN === 'true', sourceBefore = frozen ? sourceSnapshot() : null;
const { runCapacityTier, PROFILES } = require('../scripts/test_support/bi_capacity');

const tiers = String(process.env.PIVOT_BI_CAPACITY_TIERS || 'contract').split(',');
const runtime = process.env.PIVOT_BI_CAPACITY_RUNTIME || 'development_process';
const samples = Math.max(1, Math.min(20, Number(process.env.PIVOT_BI_CAPACITY_SAMPLES || 1)));
const reports = [];
for (const key of tiers) {
    if (!PROFILES[key]) throw new Error('容量验证档位无效，请指定 contract、standard 或 large。');
    test(`${PROFILES[key].name} 宽表、复合键、倾斜和未匹配来源通过完整受控任务及 HTTP 分析`, { timeout: 2400000 }, async t => {
        const result = await runCapacityTier(key, { samples, runtime, progress: event => process.stdout.write(`容量验证：${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`) });
        reports.push(result); t.diagnostic(JSON.stringify({ tier: result.tier, quality: result.quality, slo: result.slo }));
    });
}
test.after(async () => {
    if (!process.env.PIVOT_BI_CAPACITY_REPORT) return;
    const target = path.resolve(process.env.PIVOT_BI_CAPACITY_REPORT);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const crypto = require('node:crypto');
    const workerSha256 = crypto.createHash('sha256').update(await fs.readFile(path.resolve(__dirname, '../server/workers/analysis-model-worker.js'))).digest('hex');
    const sourceAfter = frozen ? sourceSnapshot() : null, sourceUnchanged = frozen ? sourceBefore.sha256 === sourceAfter.sha256 : null;
    await fs.writeFile(target, JSON.stringify({ generatedAt: new Date().toISOString(), runtime, workerSha256, workerImage: runtime === 'docker' ? process.env.DATA_ANALYSIS_MODEL_WORKER_IMAGE : null, sourceBefore, sourceAfter, sourceUnchanged, node: process.version, platform: process.platform, hardware: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() }, complete: reports.length === tiers.length && sourceUnchanged !== false, results: reports }, null, 2) + '\n');
    if (sourceUnchanged === false) throw new Error('容量运行期间源码、锁文件或固定方案发生变化，本次报告不得作为固定构建证据。');
});
