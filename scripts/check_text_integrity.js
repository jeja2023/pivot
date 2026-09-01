/* Text integrity guard: UTF-8 replacement and mojibake smoke checks */
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const ignoredDirs = new Set([
    '.git',
    'node_modules',
    'data',
    'logs',
    'uploads',
    'dist',
    'dist-electron',
    'dist-electron-remote',
    'dist-electron-0.0.138',
    'build',
    // 本地临时目录与解包校验副本不属于源码，且会保留历史文件，不参与文本完整性判定。
    '.tmp',
    '.codex-tmp',
    'test-results'
]);
const textExtensions = new Set([
    '.css',
    '.env',
    '.example',
    '.html',
    '.js',
    '.json',
    '.md',
    '.mjs',
    '.svg',
    '.toml',
    '.txt',
    '.yml'
]);

const mojibakeNeedles = [
    '\\u93C5\\u70D8',
    '\\u93C5\\u70D8\\u7051',
    '\\u951B\\u5C' + '8C',
    '\\u7AD4\\u6B04',
    '\\u95AB\\u7487',
    '\\u59AF\\u5A2F',
    '\\u7035\\u787C',
    '\\u9422\\u7528',
    '\\u935A\\u540D',
    '\\u93C1\\u636E',
    '\\u93B4\\u9519',
    '\\u9354\\u52A0',
    '\\u5BEE\\u6167',
    '\\u52D7\\u95EE',
    '\\u20AC\\u2122'
];

const suspiciousPatterns = [
    { name: 'replacement character', pattern: /\uFFFD/ },
    { name: 'common Chinese mojibake', pattern: new RegExp(mojibakeNeedles.join('|')) }
];

// 中文上下文中的孤立 ASCII 问号 ------------------------------------------------
// 落地方案 v1.2 §10.2：原有规则只查 U+FFFD 与特定 mojibake，检不出「中文被替换为半角问号」
// 这一类损坏（例如页码文案被写成「半角问号 + 空格 + 页码 + 空格 + 半角问号」拼接，本应为「第 N 页」）。
// 这里对源码字符串字面量做定向检测，并排除属于代码语法而非文案的问号：
// 模板插值、可选链、空值合并、正则源、SQL 占位符与 URL 查询串。
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css', '.json', '.svg', '.yml', '.toml']);
const CJK_RANGE = /[\u3400-\u9FFF]/;
const CJK_NEAR_QMARK = /[\u3400-\u9FFF]\s*\?|\?\s*[\u3400-\u9FFF]/;
const STANDALONE_QMARK = /^\s+\?\s*$|^\s*\?\s+$/;
const STRING_LITERAL = /'([^'\n]{0,300})'|"([^"\n]{0,300})"|`([^`\n]{0,300})`/g;
const REGEX_SOURCE_HINT = /\(\?/;
const SQL_KEYWORD = /\b(?:select|insert|update|delete|where|values|from|set|join|returning|conflict)\b/i;

/** 剔除属于代码语法而非文案的问号。 */
function stripCodeSyntaxNoise(value) {
    return String(value)
        .replace(/\$\{[^}]*\}/g, '')
        .replace(/\?\./g, '.')
        .replace(/\?\?/g, '');
}

function collectQuestionMarkIssues(text) {
    const issues = [];
    text.split(/\r?\n/).forEach((line, index) => {
        if (line.length > 4000) return;
        let match;
        STRING_LITERAL.lastIndex = 0;
        while ((match = STRING_LITERAL.exec(line))) {
            const literal = match[1] ?? match[2] ?? match[3] ?? '';
            if (!literal.includes('?')) continue;
            if (REGEX_SOURCE_HINT.test(literal) || SQL_KEYWORD.test(literal)) continue;
            const stripped = stripCodeSyntaxNoise(literal);
            // 未闭合的 ${ 说明这是跨行模板字面量的片段，问号来自插值表达式。
            if (stripped.includes('${')) continue;
            if (CJK_RANGE.test(literal) && CJK_NEAR_QMARK.test(stripped)) {
                issues.push({ line: index + 1, rule: 'isolated ASCII question mark in Chinese text', sample: literal.slice(0, 60) });
            } else if (STANDALONE_QMARK.test(stripped)) {
                issues.push({ line: index + 1, rule: 'suspicious standalone ASCII question mark', sample: JSON.stringify(literal) });
            }
        }
    });
    return issues;
}

function isTextFile(filePath) {
    const baseName = path.basename(filePath);
    if (baseName === '.env.example' || baseName === '.gitignore' || baseName === '.dockerignore') return true;
    return textExtensions.has(path.extname(filePath).toLowerCase());
}

function collectFiles(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!ignoredDirs.has(entry.name)) collectFiles(fullPath, files);
        } else if (entry.isFile() && isTextFile(fullPath)) {
            files.push(fullPath);
        }
    }
    return files;
}

function lineForIndex(text, index) {
    return text.slice(0, Math.max(index, 0)).split(/\r?\n/).length;
}

const failures = [];
for (const filePath of collectFiles(rootDir)) {
    const relativePath = path.relative(rootDir, filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    for (const rule of suspiciousPatterns) {
        const match = rule.pattern.exec(text);
        if (match) {
            failures.push({
                file: relativePath,
                line: lineForIndex(text, match.index),
                rule: rule.name,
                sample: match[0]
            });
        }
    }
    if (CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        collectQuestionMarkIssues(text).forEach(issue => failures.push({ file: relativePath, ...issue }));
    }
}

if (failures.length > 0) {
    console.error('文本完整性检查失败，可能存在乱码或非标准编码:');
    failures.slice(0, 40).forEach(item => {
        console.error(`  ${item.file}:${item.line} ${item.rule} (${item.sample})`);
    });
    if (failures.length > 40) console.error(`  ...and ${failures.length - 40} more`);
    process.exit(1);
}

console.log('文本完整性检查通过。');
