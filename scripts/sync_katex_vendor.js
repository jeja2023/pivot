'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules/katex/dist');
const target = path.join(root, 'client/common/vendor');
const check = process.argv.includes('--check');
const pkg = require('katex/package.json');
if (pkg.version !== '0.18.2') throw new Error('KaTeX 版本与资源基线不一致。');
const files = ['katex.min.js', 'katex.min.css', ...fs.readdirSync(path.join(source, 'fonts'))
    .filter(name => name.endsWith('.woff2')).map(name => `fonts/${name}`)];
const mismatches = [];
for (const file of files) {
    const input = fs.readFileSync(path.join(source, file));
    const output = path.join(target, file);
    if (check) {
        if (!fs.existsSync(output) || !fs.readFileSync(output).equals(input)) mismatches.push(file);
    } else {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, input);
    }
}
if (mismatches.length) throw new Error(`KaTeX 静态资源与依赖不一致：${mismatches.join(', ')}`);
console.log(`KaTeX ${pkg.version} 静态资源${check ? '检查' : '同步'}完成：${files.length} 个文件。`);
