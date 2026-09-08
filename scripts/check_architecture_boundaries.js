const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const failures = [];

function walkJavaScript(dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walkJavaScript(target, files);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
    return files;
}

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

// 分层规则：服务层不能反向依赖 HTTP 路由；所有 Express Router 必须位于
// server/routes 下，避免再次出现游离路由绕过统一的应用装配与门禁。
const serviceFiles = walkJavaScript(path.join(rootDir, 'server', 'services'));
for (const file of serviceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (/require\(['"][^'"]*routes\//.test(source)) {
        failures.push(`${path.relative(rootDir, file)} 服务层不得反向依赖 server/routes`);
    }
}
for (const file of walkJavaScript(path.join(rootDir, 'server'))) {
    const relative = path.relative(path.join(rootDir, 'server'), file).replace(/\\/g, '/');
    if (!relative.startsWith('routes/') && /express\.Router\s*\(/.test(fs.readFileSync(file, 'utf8'))) {
        failures.push(`server/${relative} 在 routes 目录外创建 Express Router`);
    }
}
const ragCompatibilityFacade = path.join(rootDir, 'server', 'rag.js');
assert(fs.existsSync(ragCompatibilityFacade) && /module\.exports\s*=\s*require\(['"]\.\/routes\/rag['"]\)/.test(fs.readFileSync(ragCompatibilityFacade, 'utf8')),
    'server/rag.js 必须仅作为 server/routes/rag.js 的兼容门面');

const documentIrPath = path.join(rootDir, 'server', 'services', 'document-ir.js');
const agentSkillSigningPath = path.join(rootDir, 'server', 'services', 'agent-skill-signing.js');
const canonicalJsonPath = path.join(rootDir, 'server', 'services', 'canonical-json.js');
assert(exists('server/services/canonical-json.js'), 'server/services/canonical-json.js 是跨域摘要工具的唯一来源');
assert(!/require\(['"]\.\/agent-skills['"]\)/.test(fs.readFileSync(documentIrPath, 'utf8')),
    'document-ir 不得顶层依赖 agent-skills；应依赖 canonical-json');
assert(!/require\(['"]\.\/agent-skills['"]\)/.test(fs.readFileSync(agentSkillSigningPath, 'utf8')),
    'agent-skill-signing 不得顶层依赖 agent-skills；应依赖 canonical-json');
assert(/module\.exports\s*=\s*\{\s*canonicalJson\s*\}/.test(fs.readFileSync(canonicalJsonPath, 'utf8')),
    'canonical-json 必须导出稳定序列化函数');

const bootstrapPath = path.join(rootDir, 'server', 'bootstrap.js');
const bootstrapSource = fs.readFileSync(bootstrapPath, 'utf8');
assert(/runs:\s*\{\s*recoverAgentRuns,\s*startAgentRecoveryRunner\s*\}/.test(bootstrapSource),
    '后台恢复服务必须从 agent-runtime.runs 领域 API 获取能力');
assert(/schedules:\s*\{\s*startAgentScheduleRunner\s*\}/.test(bootstrapSource),
    '后台计划调度必须从 agent-runtime.schedules 领域 API 获取能力');

const agentRuntimePath = path.join(rootDir, 'server', 'services', 'agent-runtime', 'index.js');
const agentRuntimeExportSource = fs.readFileSync(agentRuntimePath, 'utf8').slice(
    fs.readFileSync(agentRuntimePath, 'utf8').lastIndexOf('module.exports')
);
assert(/module\.exports\s*=\s*\{\s*artifacts,\s*goals,\s*monitoring,\s*notifications,\s*runs,\s*schedules,\s*templates,\s*triggers,\s*workflows\s*\}/s.test(agentRuntimeExportSource),
    'agent-runtime 只能导出具名领域对象，禁止恢复无边界平铺 API');

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
