'use strict';

const fs = require('node:fs');
const { compareCodeReviewRuns } = require('./lib/code_review_comparison');

try {
    const [input, output, ...extra] = process.argv.slice(2);
    if (!input || extra.length) throw new Error('用法：npm run compare:code-review -- <对照记录.json> [新报告.json]');
    if (fs.statSync(input).size > 20 * 1024 * 1024) throw new Error('对照记录超过20MB，请按模型或批次拆分。');
    const report = compareCodeReviewRuns(JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '')));
    const text = JSON.stringify(report, null, 2) + '\n';
    if (output) fs.writeFileSync(output, text, { encoding: 'utf8', flag: 'wx' });
    else process.stdout.write(text);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
