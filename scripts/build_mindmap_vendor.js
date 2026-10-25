'use strict';
// 版本、输入摘要与构建参数一起记录，便于离线分发与升级复核。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
async function main() {
    const root = path.resolve(__dirname, '..');
    const output = path.join(root, 'client/common/vendor/simple-mind-map/0.14.0-fix.3');
    fs.mkdirSync(output, { recursive: true });
    const build = await require('esbuild').build({ entryPoints: [path.join(__dirname, 'vendor-mindmap-entry.mjs')], bundle: true, minify: true, metafile: true, format: 'esm', target: ['chrome110', 'firefox115'], legalComments: 'external', outfile: path.join(output, 'editor.mjs') });
    const collaboration = await require('esbuild').build({ entryPoints: [path.join(__dirname, 'vendor-mindmap-crdt-entry.mjs')], bundle: true, minify: true, metafile: true, format: 'esm', target: ['chrome110', 'firefox115'], legalComments: 'external', outfile: path.join(output, 'collaboration.mjs') });
    if (!fs.existsSync(path.join(output, 'collaboration.mjs.LEGAL.txt'))) fs.writeFileSync(path.join(output, 'collaboration.mjs.LEGAL.txt'), '');
    const packageNames = [...new Set([...Object.keys(build.metafile.inputs), ...Object.keys(collaboration.metafile.inputs)].map(input => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input.replace(/\\/g, '/'))?.[1]).filter(Boolean))].sort();
    const dependencies = packageNames.map(name => { const metadata = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')); return { name, version: metadata.version, license: metadata.license }; });
    const licenses = [fs.readFileSync(path.join(root, 'docs/licenses/SIMPLE-MIND-MAP-MIT.txt'), 'utf8')];
    for (const name of packageNames.filter(name => name !== 'simple-mind-map')) {
        const packageRoot = path.join(root, 'node_modules', name);
        const license = fs.readdirSync(packageRoot).find(file => /^licen[sc]e(?:\.(?:txt|md))?$/i.test(file));
        if (!license) throw new Error(`构建依赖 ${name} 缺少完整许可文件。`);
        licenses.push(`\n${name}\n\n${fs.readFileSync(path.join(packageRoot, license), 'utf8')}`);
    }
    fs.writeFileSync(path.join(output, 'LICENSES.txt'), licenses.join('\n'));
    const files = ['editor.mjs', 'editor.mjs.LEGAL.txt', 'collaboration.mjs', 'collaboration.mjs.LEGAL.txt', 'LICENSES.txt'];
    const provenance = { package: 'simple-mind-map', version: require('simple-mind-map/package.json').version, license: 'MIT', source: 'https://github.com/wanglin2/mind-map', bundler: `esbuild@${require('esbuild/package.json').version}`, dependencies, entrySha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'vendor-mindmap-entry.mjs'))).digest('hex'), files: Object.fromEntries(files.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex')])) };
    provenance.collaborationInputs = Object.fromEntries(['scripts/vendor-mindmap-crdt-entry.mjs', 'client/common/mindmap-crdt.js', 'client/common/mindmap-document.js'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
    provenance.editorInputs = { 'scripts/mindmap-text-layout.mjs': crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'mindmap-text-layout.mjs'))).digest('hex') };
    fs.writeFileSync(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    console.log('思维导图资源构建完成。');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
