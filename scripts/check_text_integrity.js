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
    'build'
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
}

if (failures.length > 0) {
    console.error('Text integrity check failed. Possible encoding/mojibake issues:');
    failures.slice(0, 40).forEach(item => {
        console.error(`  ${item.file}:${item.line} ${item.rule} (${item.sample})`);
    });
    if (failures.length > 40) console.error(`  ...and ${failures.length - 40} more`);
    process.exit(1);
}

console.log('Text integrity check passed.');
