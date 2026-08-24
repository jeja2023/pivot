const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'governance_baseline.json'), 'utf8'));
const reportOnly = process.argv.includes('--report');
const productionRoots = ['server', 'client', 'desktop'];
const ignoredPrefixes = ['client/common/vendor/'];

function walk(relativeDir, files = []) {
    const absoluteDir = path.join(root, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const relative = path.posix.join(relativeDir.replace(/\\/g, '/'), entry.name);
        if (ignoredPrefixes.some(prefix => relative.startsWith(prefix))) continue;
        if (entry.isDirectory()) walk(relative, files);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
    }
    return files;
}

function lineCount(file) {
    return fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).length;
}

function walkTests(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walkTests(target, files);
        else if (entry.isFile() && /\.(?:spec|test)\.js$/.test(entry.name)) files.push(target);
    }
    return files;
}

function countE2eTests() {
    return walkTests(path.join(root, 'tests', 'e2e')).reduce((total, file) => {
        const text = fs.readFileSync(file, 'utf8');
        return total + (text.match(/\btest\s*\(/g) || []).length;
    }, 0);
}

const files = productionRoots.flatMap(dir => walk(dir));
const metrics = files.map(file => ({ file, lines: lineCount(file) }));
const largeFiles = metrics.filter(item => item.lines > baseline.largeFileThreshold).sort((a, b) => b.lines - a.lines);
const failures = [];
for (const item of largeFiles) {
    const allowed = Number(baseline.files[item.file] || 0);
    if (!allowed) failures.push(`${item.file} 新增为 ${item.lines} 行大文件`);
    else if (item.lines > allowed) failures.push(`${item.file} 从基线 ${allowed} 行增长到 ${item.lines} 行`);
}
for (const [file, allowed] of Object.entries(baseline.files)) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const current = lineCount(file);
    if (current > allowed) failures.push(`${file} 从基线 ${allowed} 行增长到 ${current} 行`);
}

const report = {
    productionJavaScriptFiles: metrics.length,
    largeFileThreshold: baseline.largeFileThreshold,
    largeProductionFiles: largeFiles,
    legacyWindowGlobalBudget: baseline.legacyWindowGlobalBudget,
    e2eTests: countE2eTests()
};

if (reportOnly) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}
if (failures.length) {
    console.error('架构治理指标检查失败：');
    [...new Set(failures)].forEach(item => console.error(` - ${item}`));
    console.error('存量大文件只允许缩小；新增职责必须放入独立模块。');
    process.exit(1);
}
console.log(`架构治理指标通过：${metrics.length} 个生产 JS，${largeFiles.length} 个存量大文件未增长，E2E ${report.e2eTests} 项。`);
