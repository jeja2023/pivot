'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { listVerifiedDecisionSamples } = require('../server/services/decision-observability');
const { buildLayaDecisionDataset } = require('../server/services/decision-dataset-exporter');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

async function main() {
    const tenantId = Number.parseInt(arg('--tenant-id'), 10);
    const outputDir = path.resolve(arg('--output-dir'));
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error('--tenant-id 必须是有效的单租户 ID。');
    if (!arg('--output-dir')) throw new Error('--output-dir 必须指定受控导出目录。');
    const rows = await listVerifiedDecisionSamples({
        tenantId,
        scenario: arg('--scenario', ''),
        limit: Math.max(30, Math.min(Number.parseInt(arg('--limit', '10000'), 10) || 10000, 10000))
    });
    const dataset = buildLayaDecisionDataset(rows, { split: { trainRatio: 0.7, calibrationRatio: 0.15 } });
    if (!dataset.manifest.splits.train || !dataset.manifest.splits.calibration || !dataset.manifest.splits.test) throw new Error('已核验样本不足，无法生成训练、校准和独立测试三份时间切分数据。');
    await fs.promises.mkdir(outputDir, { recursive: true });
    for (const [name, content] of Object.entries(dataset.files)) {
        await fs.promises.writeFile(path.join(outputDir, name + '.jsonl'), content, { encoding: 'utf8', mode: 0o600 });
    }
    await fs.promises.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({ ...dataset.manifest, tenantId, exportedAt: dataset.createdAt }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(JSON.stringify({ dataVersion: dataset.dataVersion, tenantId, outputDir, records: dataset.records, splits: dataset.manifest.splits, rawUserTextIncluded: false }, null, 2) + '\n');
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
