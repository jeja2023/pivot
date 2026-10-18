const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const baselinePath = path.join(__dirname, 'raw_sql_baseline.json');
const reviewPath = path.join(__dirname, 'raw_sql_review.json');
const writeBaseline = process.argv.includes('--write-baseline');
const isMigration = file => file.startsWith('server/db/migrations/');

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
    console.log(`直接 SQL 基线已写入：${baseline.total} 个生产 SQL 字面量调用，分布于 ${baseline.entries.length} 个文件。`);
    process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
    console.error('新增 raw SQL 检查失败：缺少 scripts/raw_sql_baseline.json。请审核后运行 node scripts/check_no_new_raw_sql.js --write-baseline。');
    process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const allowed = new Map((baseline.entries || []).map(item => [item.file, Number(item.count || 0)]));
if (!fs.existsSync(reviewPath)) {
    console.error('新增 raw SQL 检查失败：缺少 scripts/raw_sql_review.json。服务层新增直接 SQL 必须有文件级审核记录。');
    process.exit(1);
}
const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
const reviewed = new Map((review.entries || []).map(item => [item.file, item]));
const current = summarize(collectRawSqlCounts());
const failures = [];

current.entries.forEach(item => {
    if (isMigration(item.file)) return;
    const max = allowed.get(item.file) || 0;
    if (item.count > max) {
        const entry = reviewed.get(item.file);
        if (!entry || Number(entry.count) < item.count || !String(entry.rationale || '').trim() || !String(entry.verification || review.verification || '').trim()) {
            failures.push(`${item.file}: 直接 SQL 字面量 ${item.count} > baseline ${max}，且缺少完整审核记录`);
        }
    }
});

const currentRequestTotal = current.entries.filter(item => !isMigration(item.file)).reduce((sum, item) => sum + item.count, 0);
const baselineRequestTotal = (baseline.entries || []).filter(item => !isMigration(item.file)).reduce((sum, item) => sum + Number(item.count || 0), 0);
const reviewedAdditionalTotal = [...reviewed.values()].reduce((sum, item) => {
    const baselineCount = allowed.get(item.file) || 0;
    return sum + Math.max(0, Number(item.count || 0) - baselineCount);
}, 0);
if (currentRequestTotal > baselineRequestTotal + reviewedAdditionalTotal) {
    failures.push(`请求路径总数 ${currentRequestTotal} > 基线 ${baselineRequestTotal} + 已审核增量 ${reviewedAdditionalTotal}`);
}
for (const entry of reviewed.values()) {
    const currentEntry = current.entries.find(item => item.file === entry.file);
    if (!currentEntry || currentEntry.count !== Number(entry.count)) {
        failures.push(`${entry.file}: SQL 审核记录与当前计数不一致，必须重新审核`);
    }
}

if (failures.length) {
    console.error(`新增 raw SQL 检查失败：${failures.length} 项超出基线。`);
    failures.slice(0, 80).forEach(item => console.error(` - ${item}`));
    process.exit(1);
} else {
    console.log(`新增 raw SQL 检查通过：请求路径 ${currentRequestTotal}/${baselineRequestTotal} + 已审核增量 ${reviewedAdditionalTotal}；迁移 SQL 由迁移门禁负责。`);
}
