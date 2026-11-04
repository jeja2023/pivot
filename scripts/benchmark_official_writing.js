// 受控状态体积与归一化基准，不代表生产并发或模型写作质量。
const { performance } = require('node:perf_hooks');
const document = require('../client/common/official-writing-document');

const material = '材'.repeat(180000);
const legacy = { docType: '通知', draft: '当前正文', source: material,
    autoSaves: Array.from({ length: 8 }, (_, index) => ({ id: String(index), name: '自动草稿', draft: '版本' + index, source: material, createdAt: '2026-11-04T00:00:00.000Z' })) };
const compact = document.normalize(legacy);
const samples = [];
for (let round = 0; round < 20; round++) {
    const started = performance.now();
    document.normalize(legacy);
    samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
const before = document.bytes(legacy), after = document.bytes(compact);
const summaries = Array.from({ length: 10 }, (_, index) => ({ id: String(index), title: '公文' + index, version: 1, summary: document.summary(compact) }));
console.log(JSON.stringify({ fixture: '18万汉字材料与8次正文快照，10篇列表摘要',
    materialBytes: document.bytes(material), legacyStateBytes: before, compactStateBytes: after,
    reductionPercent: Math.round((1 - after / before) * 10000) / 100, historyMaterialCopies: Object.keys(compact.materialVersions).length,
    tenSummaryBytes: document.bytes({ data: summaries }), normalizationMedianMs: Math.round(samples[10] * 100) / 100,
    normalizationP95Ms: Math.round(samples[18] * 100) / 100 }, null, 2));
