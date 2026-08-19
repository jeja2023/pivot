const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const clientRoot = path.join(root, 'client', 'chat');
const reportOnly = String(process.env.PIVOT_SAFE_HTML_REPORT_ONLY || '').toLowerCase() === 'true';
const allowedImplementationFiles = new Set(['client/chat/safe-html.js']);

function walk(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'vendor' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath, files);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
    }
    return files;
}

function lineNumberAt(text, index) {
    let line = 1;
    for (let i = 0; i < index; i += 1) {
        if (text.charCodeAt(i) === 10) line += 1;
    }
    return line;
}

function lineTextAt(text, index) {
    const start = text.lastIndexOf('\n', index) + 1;
    const end = text.indexOf('\n', index);
    return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 180);
}

function findUnsafeHtmlSinks(file, rel) {
    const text = fs.readFileSync(file, 'utf8');
    const findings = [];
    const patterns = [
        /\.innerHTML\s*(?:=|\+=)/g,
        /\[['\"]innerHTML['\"]\]\s*(?:=|\+=)/g,
        /\.insertAdjacentHTML\s*\(/g,
        /\.createContextualFragment\s*\(/g,
        /\bdocument\.write(?:ln)?\s*\(/g,
        /\.srcdoc\s*=/g,
        /\[['\"]srcdoc['\"]\]\s*=/g
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text))) {
            if (allowedImplementationFiles.has(rel)) continue;
            findings.push({
                file: rel,
                line: lineNumberAt(text, match.index),
                text: lineTextAt(text, match.index)
            });
        }
    }
    return findings;
}

const findings = [];
for (const file of walk(clientRoot)) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    findings.push(...findUnsafeHtmlSinks(file, rel));
}

if (findings.length === 0) {
    console.log('安全 HTML 扫描通过：未发现 PivotSafeHtml 外部的裸 HTML 注入风险。');
    process.exit(0);
}

console.error(`安全 HTML 扫描失败：发现 ${findings.length} 处未受保护的 HTML 赋值。`);
findings.slice(0, 30).forEach(item => {
    console.error(` - ${item.file}:${item.line} ${item.text}`);
});
if (findings.length > 30) console.error(` - ... ${findings.length - 30} more`);
console.error('请使用 PivotSafeHtml.setHtml(element, html) 或 DOM 构建器。');
if (!reportOnly) process.exit(1);
