const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const baselinePath = path.join(__dirname, 'raw_sql_baseline.json');
const writeBaseline = process.argv.includes('--write-baseline');

function walk(dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath, files);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
    }
    return files;
}

function rel(filePath) {
    return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

function countRawSqlCalls(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    // PostgreSQL 化后请求路径不会走 db.prepare；检查生产代码中直接写入
    // query/queryOne/execute 的 SQL 字面量，避免门禁只统计测试夹具和死代码。
    return (text.match(/\b(?:[A-Za-z_$][\w$]*\.)?(?:queryOne|query|execute)\s*\(\s*(?:`|['"])/g) || []).length;
}

function collectRawSqlCounts() {
    const files = ['server']
        .map(item => path.join(rootDir, item))
        .flatMap(dir => walk(dir))
        .sort((a, b) => rel(a).localeCompare(rel(b)));
    return files
        .map(file => ({ file: rel(file), count: countRawSqlCalls(file) }))
        .filter(item => item.count > 0);
}

function summarize(entries) {
    return {
        version: 1,
        description: 'Production baseline for direct query/queryOne/execute SQL literals. New request-path SQL must be reviewed, preferably placed behind a repository boundary.',
        total: entries.reduce((sum, item) => sum + item.count, 0),
        entries
    };
}

if (writeBaseline) {
    const baseline = summarize(collectRawSqlCounts());
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log(`Raw SQL baseline written: ${baseline.total} production SQL literal call(s) in ${baseline.entries.length} file(s).`);
    process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
    console.error('新增 raw SQL 检查失败：缺少 scripts/raw_sql_baseline.json。请审核后运行 node scripts/check_no_new_raw_sql.js --write-baseline。');
    process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const allowed = new Map((baseline.entries || []).map(item => [item.file, Number(item.count || 0)]));
const current = summarize(collectRawSqlCounts());
const failures = [];

current.entries.forEach(item => {
    const max = allowed.get(item.file) || 0;
    if (item.count > max) failures.push(`${item.file}: 直接 SQL 字面量 ${item.count} > baseline ${max}`);
});

if (current.total > Number(baseline.total || 0)) {
    failures.push(`总数 ${current.total} > baseline ${baseline.total || 0}`);
}

if (failures.length) {
    console.error(`新增 raw SQL 检查失败：${failures.length} 项超出基线。`);
    failures.slice(0, 80).forEach(item => console.error(` - ${item}`));
    process.exit(1);
} else {
    console.log(`新增 raw SQL 检查通过：${current.total}/${baseline.total || 0} 个生产直接 SQL 字面量，未超出基线。`);
}
