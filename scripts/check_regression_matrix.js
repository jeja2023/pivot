'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const matrixPath = path.join(root, 'docs', 'agent-experience', 'security-regression-matrix.md');

function fail(message) {
    console.error(`安全回归矩阵检查失败：${message}`);
    process.exit(1);
}

function parseReferences(cell) {
    return [...String(cell || '').matchAll(/`(tests\/[\w./-]+\.js)#([^`]+)`/g)]
        .map(match => ({ file: match[1], title: match[2].trim() }));
}

const matrix = fs.readFileSync(matrixPath, 'utf8');
const rows = matrix.split(/\r?\n/)
    .filter(line => /^\|/.test(line))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(([area]) => area && area !== 'Area' && area !== '---');

if (rows.length < 6) fail('至少需要六个 Area 行。');
let evidenceCount = 0;
for (const [area, regression, evidence] of rows) {
    if (!area || !regression) fail('Area 或 Regression 不能为空。');
    const references = parseReferences(evidence);
    if (!references.length) fail(`${area} 缺少可执行测试证据。`);
    for (const reference of references) {
        const filePath = path.resolve(root, reference.file);
        if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath)) {
            fail(`${area} 引用了不存在的测试文件：${reference.file}`);
        }
        const source = fs.readFileSync(filePath, 'utf8');
        if (!source.includes(`test('${reference.title}'`) && !source.includes(`test(\`${reference.title}\``)) {
            fail(`${area} 引用了不存在的测试标题：${reference.file}#${reference.title}`);
        }
        evidenceCount += 1;
    }
}

console.log(`安全回归矩阵检查通过：${rows.length} 个领域，${evidenceCount} 条可执行证据。`);
