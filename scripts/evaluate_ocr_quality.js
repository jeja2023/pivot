'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateGoldenCase, summarizeGoldenResults } = require('../server/services/document-processing/quality-evaluation');

function argument(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : '';
}

function usage(message = '') {
    if (message) process.stderr.write(`${message}\n`);
    process.stderr.write('用法：node scripts/evaluate_ocr_quality.js --results <results.json> [--output <report.json>]\n');
    process.exitCode = 2;
}

function main() {
    const input = argument('--results');
    if (!input) return usage('缺少 --results。');
    const absoluteInput = path.resolve(input);
    let cases;
    try { cases = JSON.parse(fs.readFileSync(absoluteInput, 'utf8')); } catch (error) { return usage(`无法读取评测结果：${error.message}`); }
    const rows = Array.isArray(cases) ? cases : cases?.cases;
    if (!Array.isArray(rows) || !rows.length) return usage('结果文件必须包含非空的 cases 数组。');
    const results = rows.map(row => ({ id: String(row.id || ''), category: String(row.category || ''), ...evaluateGoldenCase({ expected: row.expected, actual: row.actual }) }));
    const report = { generatedAt: new Date().toISOString(), input: absoluteInput, summary: summarizeGoldenResults(results), results };
    const output = argument('--output');
    if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report.summary)}\n`);
    if (report.summary.passed !== report.summary.cases) process.exitCode = 1;
}

main();
