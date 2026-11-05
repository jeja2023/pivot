'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = '11.17.2';
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'client/common/vendor/mermaid', VERSION);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
    const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/mermaid/package.json'), 'utf8'));
    if (packageInfo.version !== VERSION) throw new Error('Mermaid 依赖版本与离线资源基线不一致。');
    fs.mkdirSync(directory, { recursive: true });
    const entry = path.join(__dirname, 'vendor-mermaid-entry.mjs');
    const build = await require('esbuild').build({ entryPoints: [entry], bundle: true, minify: true, metafile: true, format: 'iife', target: ['chrome110', 'firefox115'],
        plugins: [{ name: '静态表格转换', setup(build) {
            build.onLoad({ filter: /d3-dsv[\\/]dist[\\/]d3-dsv\.mjs$/ }, async args => {
                const source = await fs.promises.readFile(args.path, 'utf8');
                const pattern = /function objectConverter\(columns\) \{[\s\S]*?\n\}/;
                if (!pattern.test(source)) throw new Error('D3 表格转换实现已变化，请复核静态适配。');
                return { contents: source.replace(pattern, `function objectConverter(columns) {
                    return function(row) {
                        const result = {};
                        columns.forEach(function(name, index) { Object.defineProperty(result, name, { value: row[index] || '', enumerable: true, configurable: true, writable: true }); });
                        return result;
                    };
                }`), loader: 'js' };
            });
        } }], legalComments: 'external', outfile: path.join(directory, 'mermaid.min.js') });
    const packages = [...new Set(Object.keys(build.metafile.inputs).map(file => /^((?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file.replace(/\\/g, '/'))?.[1]).filter(Boolean))].sort();
    const dependencies = []; const licenses = [];
    for (const relative of packages) {
        const packageRoot = path.join(root, relative);
        const info = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
        const name = info.name;
        const license = fs.readdirSync(packageRoot).find(file => /^licen[sc]e(?:[-.].*)?$/i.test(file) && fs.statSync(path.join(packageRoot, file)).isFile());
        const readmeLicense = !license && fs.existsSync(path.join(packageRoot, 'README.md'))
            ? fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8').match(/## License\s+([\s\S]+)$/)?.[1] : '';
        if (!license && !/Permission is hereby granted[\s\S]+THE SOFTWARE IS PROVIDED/i.test(readmeLicense || '')) throw new Error(`构建依赖 ${name} 缺少完整许可文件。`);
        const selectedLicense = info.license || (/The MIT License/.test(fs.readFileSync(path.join(packageRoot, license), 'utf8')) ? 'MIT' : '');
        dependencies.push({ name, version: info.version, license: selectedLicense });
        licenses.push(`\n${name}@${info.version}\n\n${license ? fs.readFileSync(path.join(packageRoot, license), 'utf8') : readmeLicense}`);
    }
    fs.writeFileSync(path.join(directory, 'LICENSES.txt'), licenses.join('\n'));
    const files = ['mermaid.min.js', 'mermaid.min.js.LEGAL.txt', 'LICENSES.txt'];
    const provenance = { package: 'mermaid', version: VERSION, license: 'MIT', source: 'https://github.com/mermaid-js/mermaid',
        bundler: `esbuild@${require('esbuild/package.json').version}`, entrySha256: digest(fs.readFileSync(entry)), buildSha256: digest(fs.readFileSync(__filename)), dependencies,
        files: Object.fromEntries(files.map(name => [name, digest(fs.readFileSync(path.join(directory, name)))])) };
    fs.writeFileSync(path.join(directory, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    console.log(`Mermaid 离线资源构建完成，${fs.statSync(path.join(directory, 'mermaid.min.js')).size} 字节。`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
