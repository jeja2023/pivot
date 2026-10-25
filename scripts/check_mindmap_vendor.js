'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const acorn = require('acorn');
const root = path.resolve(__dirname, '../client/common/vendor/simple-mind-map/0.14.0-fix.3');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'provenance.json'), 'utf8'));
if (manifest.version !== '0.14.0-fix.3' || manifest.license !== 'MIT') throw new Error('思维导图资源版本或许可记录不符合基线。');
const entryDigest = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'vendor-mindmap-entry.mjs'))).digest('hex');
if (entryDigest !== manifest.entrySha256) throw new Error('思维导图插件入口已变更，请重新构建资源。');
for (const [name, expected] of Object.entries(manifest.files)) {
    if (!['editor.mjs', 'editor.mjs.LEGAL.txt', 'collaboration.mjs', 'collaboration.mjs.LEGAL.txt', 'LICENSES.txt'].includes(name)) throw new Error('思维导图资源清单包含未知路径。');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
    if (actual !== expected) throw new Error(`思维导图资源 ${name} 摘要不匹配，请重新构建。`);
}
const source = fs.readFileSync(path.join(root, 'editor.mjs'), 'utf8');
acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) throw new Error('思维导图运行资源含动态代码执行，请检查构建配置。');
for (const [name, digest] of Object.entries(manifest.collaborationInputs || {})) {
    if (!['scripts/vendor-mindmap-crdt-entry.mjs', 'client/common/mindmap-crdt.js', 'client/common/mindmap-document.js'].includes(name)) throw new Error('协作构建包含未知源路径。');
    if (crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', name))).digest('hex') !== digest) throw new Error('协作源文件已更新，请重新构建。');
}
const collaboration = fs.readFileSync(path.join(root, 'collaboration.mjs'), 'utf8');
if (!manifest.editorInputs?.['scripts/mindmap-text-layout.mjs'] || manifest.editorInputs['scripts/mindmap-text-layout.mjs'] !== crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, 'mindmap-text-layout.mjs'))).digest('hex')) throw new Error('文字布局适配已更新，请重新构建。');
acorn.parse(collaboration, { ecmaVersion: 'latest', sourceType: 'module' });
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(collaboration)) throw new Error('协作资源含动态代码执行。');
if (manifest.dependencies.some(item => item.license !== 'MIT' || ['quill', 'katex', 'y-webrtc'].includes(item.name))) throw new Error('思维导图构建包含未经允许的组件或许可。');
console.log('思维导图资源检查通过：版本、摘要、许可与静态模块语法均有效。');
