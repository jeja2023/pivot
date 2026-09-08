const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const baselinePath = path.join(__dirname, 'dead_exports_baseline.json');
const writeBaseline = process.argv.includes('--write-baseline');

function walk(dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(target, files);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
    return files;
}

function relative(file) {
    return path.relative(root, file).replace(/\\/g, '/');
}

function extractExportNames(source) {
    const names = new Set();
    for (const match of source.matchAll(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(match[1]);
    for (const match of source.matchAll(/module\.exports\s*=\s*\{([\s\S]*?)\n?\};/g)) {
        const body = match[1]
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
        for (const property of body.matchAll(/(?:^|[,\n])\s*([A-Za-z_$][\w$]*)\s*(?=[:,}\n])/g)) {
            names.add(property[1]);
        }
    }
    return [...names];
}

function collectDeadExports() {
    const serverFiles = walk(path.join(root, 'server'));
    const references = ['server', 'tests', 'scripts', 'desktop', 'client']
        .flatMap(directory => walk(path.join(root, directory)))
        .map(file => ({ file, source: fs.readFileSync(file, 'utf8') }));
    const dead = [];
    for (const file of serverFiles) {
        const source = fs.readFileSync(file, 'utf8');
        for (const name of extractExportNames(source)) {
            const matcher = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            const externallyReferenced = references.some(candidate => candidate.file !== file && matcher.test(candidate.source));
            if (!externallyReferenced) dead.push({ file: relative(file), name });
        }
    }
    return dead.sort((left, right) => `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`));
}

function main() {
    const entries = collectDeadExports();
    if (writeBaseline) {
        fs.writeFileSync(baselinePath, `${JSON.stringify({
            description: 'Baseline for server exports with no static external reference. New dead exports are forbidden; existing entries must only decrease after review.',
            total: entries.length,
            entries
        }, null, 2)}\n`, 'utf8');
        console.log(`死导出基线已写入：${entries.length} 项。`);
        return;
    }
    if (!fs.existsSync(baselinePath)) throw new Error('缺少 scripts/dead_exports_baseline.json；请审核后运行 node scripts/check_dead_exports.js --write-baseline。');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const allowed = new Set((baseline.entries || []).map(item => `${item.file}:${item.name}`));
    const current = new Set(entries.map(item => `${item.file}:${item.name}`));
    const added = [...current].filter(item => !allowed.has(item));
    if (entries.length > Number(baseline.total || 0) || added.length) {
        console.error('死导出门禁失败：');
        if (entries.length > Number(baseline.total || 0)) console.error(` - 当前 ${entries.length} 项 > 基线 ${baseline.total}`);
        added.slice(0, 80).forEach(item => console.error(` - 新增无外部引用导出：${item}`));
        process.exit(1);
    }
    console.log(`死导出门禁通过：${entries.length}/${baseline.total} 项，仅允许减少。`);
}

if (require.main === module) main();

module.exports = { collectDeadExports, extractExportNames };
