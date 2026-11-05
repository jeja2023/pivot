'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'client/common/vendor/mermaid/11.17.2');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'provenance.json'), 'utf8'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (manifest.version !== '11.17.2' || manifest.license !== 'MIT') throw new Error('Mermaid 版本或许可不符合基线。');
if (manifest.entrySha256 !== digest(fs.readFileSync(path.join(__dirname, 'vendor-mermaid-entry.mjs')))) throw new Error('Mermaid 构建入口已变化，请重新构建。');
if (manifest.buildSha256 !== digest(fs.readFileSync(path.join(__dirname, 'build_mermaid_vendor.js')))) throw new Error('Mermaid 静态构建适配已变化，请重新构建。');
const allowed = new Set(['mermaid.min.js', 'mermaid.min.js.LEGAL.txt', 'LICENSES.txt']);
for (const [name, expected] of Object.entries(manifest.files)) {
    if (!allowed.delete(name) || digest(fs.readFileSync(path.join(directory, name))) !== expected) throw new Error(`Mermaid 资源 ${name} 校验失败。`);
}
if (allowed.size) throw new Error('Mermaid 资源清单不完整。');
const source = fs.readFileSync(path.join(directory, 'mermaid.min.js'), 'utf8');
require('acorn').parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) throw new Error('Mermaid 构建含动态代码执行。');
const licenses = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0', '(MIT OR Apache-2.0)', '(MPL-2.0 OR Apache-2.0)', '(BSD-2-Clause OR MIT OR Apache-2.0)']);
if (manifest.dependencies.some(item => !licenses.has(item.license))) throw new Error('Mermaid 构建包含未审核许可。');
console.log('Mermaid 离线资源检查通过：版本、摘要、许可与语法有效。');
