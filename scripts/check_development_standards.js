/* Pivot 开发规范自动检查脚本 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn');

const rootDir = path.resolve(__dirname, '..');
const stagedMode = process.argv.includes('--staged');
const changedMode = process.argv.includes('--changed');
const GENERATED_FILES = new Set([
    'client/chat/chat.bundle.css'
]);

const failures = [];

function rel(filePath) {
    return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

function addFailure(message) {
    failures.push(message);
}

function readUtf8(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}


function walk(dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath, files);
        else if (entry.isFile()) files.push(fullPath);
    }
    return files;
}

function assertDocumentIncludes(relativePath, requiredSnippets) {
    const fullPath = path.join(rootDir, relativePath);
    if (!fs.existsSync(fullPath)) {
        addFailure(`缺少必需文档：${relativePath}`);
        return;
    }
    const text = readUtf8(fullPath);
    requiredSnippets.forEach(snippet => {
        if (!text.includes(snippet)) addFailure(`${relativePath} 缺少规范片段：${snippet}`);
    });
}

function checkRequiredDocuments() {
    assertDocumentIncludes('开发规范.md', [
        '前端 UI 统一规范',
        '文件拆分与大文件治理',
        '文档处理、OCR 与 PDF 专项规范',
        '注释、命名、提示与日志',
        '提交前检查清单'
    ]);
    assertDocumentIncludes('docs/design/DESIGN.md', [
        '产品定位',
        '信息架构',
        '交互原则',
        '视觉与组件'
    ]);
}

function checkPackageScripts() {
    const packagePath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(packagePath)) {
        addFailure('缺少 package.json，无法校验脚本门禁。');
        return;
    }
    const pkg = JSON.parse(readUtf8(packagePath));
    const scripts = pkg.scripts || {};
    if (!String(scripts['check:standards'] || '').includes('check_development_standards.js')) {
        addFailure('package.json 缺少 check:standards，或未接入 scripts/check_development_standards.js。');
    }
    if (!String(scripts['check:no-new-raw-sql'] || '').includes('check_no_new_raw_sql.js')) {
        addFailure('package.json 缺少 check:no-new-raw-sql，或未接入 scripts/check_no_new_raw_sql.js。');
    }
    if (!String(scripts.check || '').includes('check:standards')) {
        addFailure('package.json 的 check 脚本必须包含 npm run check:standards。');
    }
    if (!String(scripts['hooks:install'] || '').includes('install_git_hooks.js')) {
        addFailure('package.json 缺少 hooks:install，或未接入 scripts/install_git_hooks.js。');
    }
}

function checkGitHookFiles() {
    const hookPath = path.join(rootDir, '.githooks', 'pre-commit');
    if (!fs.existsSync(hookPath)) {
        addFailure('缺少 .githooks/pre-commit，提交门禁未固化到仓库。');
        return;
    }
    const hook = readUtf8(hookPath);
    if (!hook.includes('check_development_standards.js --staged')) {
        addFailure('.githooks/pre-commit 必须运行 staged 开发规范检查。');
    }
    if (!hook.includes('check:text')) {
        addFailure('.githooks/pre-commit 必须运行文本完整性检查 npm run check:text。');
    }
    if (!hook.includes('check_no_new_raw_sql.js')) {
        addFailure('.githooks/pre-commit 必须运行新增 raw SQL 检查 scripts/check_no_new_raw_sql.js。');
    }
}

function checkNoRuntimePublicCdn() {
    const roots = ['client', 'server'].map(item => path.join(rootDir, item));
    const runtimeFiles = roots.flatMap(dir => walk(dir))
        .filter(file => /\.(html|js|css)$/i.test(file));
    const cdnPattern = /https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack\.dev)\b/i;
    runtimeFiles.forEach(file => {
        const text = readUtf8(file);
        const match = text.match(cdnPattern);
        if (match) addFailure(`${rel(file)} 引用了公共 CDN：${match[0]}。运行时代码必须使用本地 vendor 或项目内资源。`);
    });
}

function withTempOutput(callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-standards-'));
    const outputPath = path.join(dir, 'git-output.txt');
    try {
        callback(outputPath);
        return fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    } finally {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (_) {
            // 临时目录清理失败不影响规范判断。
        }
    }
}

function runGitDiff(args) {
    return withTempOutput(outputPath => {
        execFileSync('git', ['diff', `--output=${outputPath}`, ...args], {
            cwd: rootDir,
            stdio: 'inherit'
        });
    });
}

function getStagedFiles() {
    try {
        const output = runGitDiff(['--cached', '--name-only', '--diff-filter=ACMR']);
        return output.split(/\r?\n/).map(item => item.trim()).filter(Boolean).map(item => item.replace(/\\/g, '/'));
    } catch (error) {
        addFailure(`无法读取暂存区文件：${error.message}`);
        return [];
    }
}

function buildBaseRefCandidates(baseRef) {
    const normalized = String(baseRef || '').trim();
    if (!normalized) return [];
    if (normalized.startsWith('origin/') || normalized.startsWith('refs/')) return [normalized];
    return [`origin/${normalized}`, normalized];
}

function resolveChangedDiffArgs(
    env = process.env,
    resolveMergeBase = ref => execFileSync('git', ['merge-base', 'HEAD', ref], { cwd: rootDir, encoding: 'utf8' }).trim(),
    hasWorkingTreeChanges = () => Boolean(execFileSync(
        'git', ['diff', 'HEAD', '--name-only', '--diff-filter=ACMR'], { cwd: rootDir, encoding: 'utf8' }
    ).trim())
) {
    const baseRef = String(env.PIVOT_STANDARDS_BASE_REF || env.GITHUB_BASE_REF || '').trim();
    if (!baseRef) return hasWorkingTreeChanges() ? ['HEAD'] : ['HEAD^', 'HEAD'];
    for (const candidate of buildBaseRefCandidates(baseRef)) {
        try {
            const mergeBase = String(resolveMergeBase(candidate) || '').trim();
            if (mergeBase) return [mergeBase, 'HEAD'];
        } catch (_error) {
            // 候选引用不存在时继续尝试本地或远端同名引用。
        }
    }
    throw new Error(`无法解析目标分支 ${baseRef} 与 HEAD 的共同基线`);
}

function getChangedFiles(diffArgs) {
    try {
        const output = runGitDiff([...diffArgs, '--name-only', '--diff-filter=ACMR']);
        return output.split(/\r?\n/).map(item => item.trim()).filter(Boolean).map(item => item.replace(/\\/g, '/'));
    } catch (error) {
        addFailure(`无法读取提交变更文件：${error.message}`);
        return [];
    }
}

function getUntrackedFiles() {
    try {
        const output = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
            cwd: rootDir,
            encoding: 'utf8'
        });
        return output.split(/\r?\n/).map(item => item.trim()).filter(Boolean).map(item => item.replace(/\\/g, '/'));
    } catch (error) {
        addFailure(`无法读取未跟踪文件：${error.message}`);
        return [];
    }
}

function parseAddedLines(file, diffArgs = ['--cached']) {
    let diff = '';
    try {
        diff = runGitDiff([...diffArgs, '--unified=0', '--', file]);
    } catch (error) {
        addFailure(`无法读取暂存区 diff：${file}，${error.message}`);
        return [];
    }
    const added = [];
    let nextLine = 0;
    diff.split(/\r?\n/).forEach(line => {
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            nextLine = Number(hunk[1]);
            return;
        }
        if (!nextLine) return;
        if (line.startsWith('+++')) return;
        if (line.startsWith('+')) {
            added.push({ line: nextLine, text: line.slice(1) });
            nextLine += 1;
            return;
        }
        if (!line.startsWith('-')) nextLine += 1;
    });
    return added;
}

function isFrontendFile(file) {
    return file.startsWith('client/') && /\.(html|js|css)$/i.test(file);
}

function isBackendRouteFile(file) {
    return file.startsWith('server/routes/') && file.endsWith('.js');
}

function isSkippableGeneratedFile(file) {
    return GENERATED_FILES.has(file) ||
        file.includes('/vendor/') ||
        file.endsWith('package-lock.json');
}

function hasClass(line, className) {
    return new RegExp(`class=["'][^"']*\\b${className}\\b`).test(line);
}

function hasCjk(text) {
    return /[\u3400-\u9fff]/.test(text);
}

function hasLatinWord(text) {
    return /[A-Za-z]{3,}/.test(text);
}

function isAllowedTechnicalLiteral(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    if (/^(API|URL|URI|HTTP|HTTPS|JSON|HTML|CSS|JS|SQL|PDF|OCR|ID|UUID|JWT|MCP|CSV|TXT|DOCX|GET|POST|PUT|PATCH|DELETE|ERROR|WARN|WARNING|INFO|SUCCESS|DEBUG|TRACE)$/i.test(text)) return true;
    if (/^[-_.:/\\@?#&=%\w]+$/.test(text) && /[-_.:/\\@?#&=%]/.test(text)) return true;
    return false;
}

function isEnglishOnlyHumanText(value) {
    const text = String(value || '')
        .replace(/&[a-z]+;|&#\d+;/gi, '')
        .replace(/\$\{[^}]+\}/g, '')
        .trim();
    if (!text || hasCjk(text) || !hasLatinWord(text)) return false;
    return !isAllowedTechnicalLiteral(text);
}

function extractMessageStringLiterals(line) {
    const source = String(line || '');
    const messageCall = source.match(/\b(?:console\.(?:log|error|warn|info)|logger\.(?:trace|debug|info|warn|error|fatal)|showToast|toast|notify|alert|confirm|prompt)\s*\(|new\s+Error\s*\(|res(?:\.status\([^)]*\))?\.json\s*\(/);
    if (!messageCall) return [];
    try {
        const expression = acorn.parseExpressionAt(source, messageCall.index, { ecmaVersion: 'latest' });
        const literals = [];
        const collect = (node, inspectObjects = false) => {
            if (!node || typeof node !== 'object') return;
            if (node.type === 'Literal') {
                if (typeof node.value === 'string') literals.push(node.value);
                return;
            }
            if (node.type === 'TemplateLiteral') {
                literals.push(node.quasis.map(item => item.value.cooked || item.value.raw || '').join('${...}'));
                return;
            }
            // 嵌套函数参数通常是编码、路径或错误码，不属于当前日志的人类文案。
            if (node.type === 'CallExpression' || node.type === 'NewExpression') return;
            if (node.type === 'ObjectExpression' && !inspectObjects) return;
            Object.entries(node).forEach(([key, value]) => {
                if (['start', 'end', 'loc', 'callee', 'key'].includes(key)) return;
                if (Array.isArray(value)) value.forEach(item => collect(item, inspectObjects));
                else collect(value, inspectObjects);
            });
        };
        const isJsonResponse = expression.type === 'CallExpression'
            && expression.callee?.type === 'MemberExpression'
            && expression.callee.property?.name === 'json';
        (expression.arguments || []).forEach(argument => collect(argument, isJsonResponse));
        return literals;
    } catch (_error) {
        return [];
    }
}

function extractHumanComment(line) {
    const trimmed = line.trim();
    if (/eslint|stylelint|prettier|istanbul|sourceMappingURL|@ts-|<reference|\bglobal\b/i.test(trimmed)) return '';
    if (trimmed.startsWith('//')) return trimmed.slice(2).trim();
    if (trimmed.startsWith('/*')) return trimmed.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim();
    if (trimmed.startsWith('*')) return trimmed.replace(/^\*+/, '').replace(/\*+\/$/, '').trim();
    if (trimmed.startsWith('<!--')) return trimmed.replace(/^<!--/, '').replace(/-->$/, '').trim();
    return '';
}

function checkChineseHumanTextAddedLine(file, item) {
    const text = item.text;
    const location = `${file}:${item.line}`;
    const comment = extractHumanComment(text);
    if (isEnglishOnlyHumanText(comment)) {
        addFailure(`${location} 新增英文注释。注释必须使用中文，必要英文技术名词需放在中文语境中。`);
    }

    const messageLiterals = extractMessageStringLiterals(text);
    if (messageLiterals.length) {
        messageLiterals.forEach(value => {
            if (isEnglishOnlyHumanText(value)) {
                addFailure(`${location} 新增英文日志或错误提示：${value.slice(0, 80)}。请改为中文。`);
            }
        });
    }

    if (isFrontendFile(file)) {
        const attrPattern = /\b(?:placeholder|title|aria-label|alt)=["']([^"']+)["']/gi;
        let attrMatch;
        while ((attrMatch = attrPattern.exec(text))) {
            if (isEnglishOnlyHumanText(attrMatch[1])) {
                addFailure(`${location} 新增英文界面提示：${attrMatch[1].slice(0, 80)}。请改为中文。`);
            }
        }
        const htmlTextPattern = />\s*([^<>{}]+?)\s*</g;
        let htmlMatch;
        while ((htmlMatch = htmlTextPattern.exec(text))) {
            if (isEnglishOnlyHumanText(htmlMatch[1])) {
                addFailure(`${location} 新增英文界面文案：${htmlMatch[1].slice(0, 80)}。请改为中文。`);
            }
        }
    }
}

function checkFrontendAddedLine(file, item) {
    const text = item.text;
    const location = `${file}:${item.line}`;
    const publicCdnPattern = /https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack\.dev)\b/i;
    if (publicCdnPattern.test(text)) {
        addFailure(`${location} 新增公共 CDN 引用。请改为 client/common/vendor/ 本地资源。`);
    }
    if (/\sstyle=/.test(text)) {
        addFailure(`${location} 新增内联 style。请抽到全局或模块 CSS，并复用主题变量。`);
    }
    if (/(^|[^\w-])#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(text) && !text.includes('var(')) {
        addFailure(`${location} 新增硬编码颜色。请使用全局 CSS 变量或既有样式类。`);
    }
    if (/<button\b/i.test(text) && !/(btn-primary|btn-secondary|btn-danger|btn-danger-outline|workspace-modal-close)/.test(text)) {
        addFailure(`${location} 新增 button 未使用全局按钮类。`);
    }
    if (/<(?:select|textarea)\b/i.test(text) && !hasClass(text, 'form-input')) {
        addFailure(`${location} 新增表单控件未使用 form-input。`);
    }
    if (/<input\b/i.test(text) && !/\btype=["']?(?:checkbox|radio|hidden|file)\b/i.test(text) && !hasClass(text, 'form-input')) {
        addFailure(`${location} 新增 input 未使用 form-input。`);
    }
    if (/<table\b/i.test(text) && !hasClass(text, 'data-table')) {
        addFailure(`${location} 新增 table 未使用 data-table。`);
    }
    if (/\.btn-(?!primary\b|secondary\b|danger\b|danger-outline\b)[A-Za-z0-9_-]+/.test(text) && !file.includes('client/common/styles/')) {
        addFailure(`${location} 新增私有按钮样式。请复用全局按钮语义类。`);
    }
}

function checkBackendRouteAddedLine(file, item) {
    const text = item.text;
    const location = `${file}:${item.line}`;
    const heavyRoutePatterns = [
        /\bdb\.prepare\s*\(/,
        /\bfs\.(?:readFileSync|writeFileSync|createReadStream|createWriteStream)\b/,
        /\b(?:exec|spawn|execFile)\s*\(/,
        /\bextractDocumentText\s*\(/,
        /\brenderPdfPages\s*\(/
    ];
    if (heavyRoutePatterns.some(pattern => pattern.test(text))) {
        addFailure(`${location} 路由层新增了重业务逻辑或底层文件处理。请下沉到 server/services/ 后由路由调用。`);
    }
}

function checkChanges(files, diffArgs) {
    files.filter(file => !isSkippableGeneratedFile(file)).forEach(file => {
        const addedLines = parseAddedLines(file, diffArgs);
        addedLines.forEach(item => {
            if (/\.(js|css|html)$/i.test(file)) checkChineseHumanTextAddedLine(file, item);
            if (isFrontendFile(file)) checkFrontendAddedLine(file, item);
            if (isBackendRouteFile(file)) checkBackendRouteAddedLine(file, item);
        });
    });
}

function checkUntrackedChanges(files) {
    files.filter(file => !isSkippableGeneratedFile(file)).forEach(file => {
        const fullPath = path.join(rootDir, file);
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return;
        readUtf8(fullPath).split(/\r?\n/).forEach((text, index) => {
            const item = { line: index + 1, text };
            if (/\.(js|css|html)$/i.test(file)) checkChineseHumanTextAddedLine(file, item);
            if (isFrontendFile(file)) checkFrontendAddedLine(file, item);
            if (isBackendRouteFile(file)) checkBackendRouteAddedLine(file, item);
        });
    });
}

function checkStagedChanges() {
    checkChanges(getStagedFiles(), ['--cached']);
}

function checkCommittedChanges() {
    try {
        const diffArgs = resolveChangedDiffArgs();
        checkChanges(getChangedFiles(diffArgs), diffArgs);
        if (diffArgs.length === 1 && diffArgs[0] === 'HEAD') checkUntrackedChanges(getUntrackedFiles());
    } catch (error) {
        addFailure(`无法确定提交增量范围：${error.message}`);
    }
}

function main() {
    checkRequiredDocuments();
    checkPackageScripts();
    checkGitHookFiles();
    checkNoRuntimePublicCdn();
    if (stagedMode) checkStagedChanges();
    if (changedMode) checkCommittedChanges();

    if (failures.length === 0) {
        console.log(stagedMode || changedMode
            ? `开发规范检查通过：基础门禁和${stagedMode ? '暂存区' : '提交'}增量均符合要求。`
            : '开发规范检查通过：基础门禁已固化。');
        return;
    }

    console.error(`开发规范检查失败：${failures.length} 项问题。`);
    failures.slice(0, 40).forEach(message => console.error(` - ${message}`));
    if (failures.length > 40) console.error(` - 还有 ${failures.length - 40} 项未显示`);
    process.exit(1);
}

if (require.main === module) main();

module.exports = {
    buildBaseRefCandidates,
    extractMessageStringLiterals,
    isSkippableGeneratedFile,
    resolveChangedDiffArgs
};
