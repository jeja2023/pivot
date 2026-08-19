const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const failures = [];

function exists(relativePath) {
    return fs.existsSync(path.join(rootDir, relativePath));
}

function assert(condition, message) {
    if (!condition) failures.push(message);
}

const entryPath = path.join(rootDir, 'server', 'index.js');
const entryLines = exists('server/index.js')
    ? fs.readFileSync(entryPath, 'utf8').split(/\r?\n/).length
    : Number.POSITIVE_INFINITY;

assert(exists('server/app.js'), 'server/app.js is required for Express app assembly');
assert(exists('server/bootstrap.js'), 'server/bootstrap.js is required for process/background lifecycle');
assert(exists('server/server.js'), 'server/server.js is required for HTTP lifecycle');
assert(entryLines <= 120, 'server/index.js must remain a thin startup entry (found ' + entryLines + ' lines)');
assert(!exists('client/Pivot-Setup.exe'), 'desktop installer must not be stored under client/');
assert(exists('artifacts/release') || !exists('client/Pivot-Setup.exe'), 'release artifacts should use artifacts/release when present');

[
    'docs/design/DESIGN.md',
    'docs/design/工具库数据接入与本机能力设计方案.md',
    'docs/design/文档处理底座与OCR_PDF工具应用分阶段开发方案.md',
    'docs/reports/项目汇报.md',
    'docs/standards/打包与推送说明.md',
    'scripts/bat/打包成安装包.bat',
    'scripts/bat/推送至GitHub.bat'
].forEach(relativePath => assert(exists(relativePath), relativePath + ' is missing after repository organization'));

if (failures.length) {
    console.error('架构边界检查失败:');
    failures.forEach(message => console.error(' - ' + message));
    process.exit(1);
}

console.log('架构边界检查通过。');
