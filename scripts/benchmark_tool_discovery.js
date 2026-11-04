'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { rankTools } = require('../server/services/tool-discovery');

function evaluateToolDiscovery({ tools = [], cases = [], allowedToolNames = [] } = {}) {
    const allowed = new Set(allowedToolNames);
    const catalog = tools.filter(tool => allowed.has(tool.name) && tool.enabled !== false);
    const samples = cases.map(item => {
        const started = performance.now(), ranked = rankTools(item.query, catalog).slice(0, 24).map(item => item.tool.name);
        const expected = new Set(item.expectedTools || []);
        return { top1: expected.size ? expected.has(ranked[0]) : ranked.length === 0,
            hitAt24: expected.size ? ranked.some(name => expected.has(name)) : ranked.length === 0, durationMs: performance.now() - started };
    });
    const times = samples.map(item => item.durationMs).sort((a, b) => a - b);
    return { schemaVersion: 1, kind: 'ranking_only', catalogSize: catalog.length, cases: samples.length,
        top1Accuracy: samples.length ? samples.filter(item => item.top1).length / samples.length : null,
        hitAt24: samples.length ? samples.filter(item => item.hitAt24).length / samples.length : null,
        p95Ms: times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * .95) - 1)] : null,
        modelSelectionAccuracy: null, note: '仅测输入的已授权目录快照排序；真实模型选用正确率须在目标环境另测。' };
}

if (require.main === module) {
    const file = process.argv[2];
    if (!file) throw new Error('请提供脱敏的工具目录与评测样本 JSON 文件。');
    process.stdout.write(JSON.stringify(evaluateToolDiscovery(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2) + '\n');
}
module.exports = { evaluateToolDiscovery };
