const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const clientRoot = path.join(root, 'client', 'chat');
const baselinePath = path.join(__dirname, 'window_globals_baseline.json');
const writeBaseline = process.argv.includes('--write-baseline');
const reportOnly = String(process.env.PIVOT_WINDOW_GLOBALS_REPORT_ONLY || '').toLowerCase() === 'true';

function walk(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'vendor' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath, files);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
    }
    return files;
}

function stripCommentsAndStrings(text) {
    let out = '';
    let state = 'code';
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        const next = text[i + 1];
        if (state === 'code') {
            if (ch === '/' && next === '/') {
                state = 'lineComment';
                out += '  ';
                i += 1;
                continue;
            }
            if (ch === '/' && next === '*') {
                state = 'blockComment';
                out += '  ';
                i += 1;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                state = 'string';
                quote = ch;
                out += ' ';
                continue;
            }
            out += ch;
            continue;
        }
        if (state === 'lineComment') {
            if (ch === '\n') {
                state = 'code';
                out += '\n';
            } else {
                out += ' ';
            }
            continue;
        }
        if (state === 'blockComment') {
            if (ch === '*' && next === '/') {
                state = 'code';
                out += '  ';
                i += 1;
            } else {
                out += ch === '\n' ? '\n' : ' ';
            }
            continue;
        }
        if (state === 'string') {
            if (ch === '\\') {
                out += ' ';
                if (next) {
                    out += next === '\n' ? '\n' : ' ';
                    i += 1;
                }
                continue;
            }
            if (ch === quote) {
                state = 'code';
                quote = '';
                out += ' ';
            } else {
                out += ch === '\n' ? '\n' : ' ';
            }
        }
    }
    return out;
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

function findAssignments(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const text = stripCommentsAndStrings(raw);
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const findings = [];
    const pattern = /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g;
    let match;
    while ((match = pattern.exec(text))) {
        findings.push({
            file: rel,
            global: match[1],
            line: lineNumberAt(text, match.index),
            text: lineTextAt(raw, match.index)
        });
    }
    return findings;
}

function summarize(findings) {
    const byKey = new Map();
    for (const item of findings) {
        const key = `${item.file}#${item.global}`;
        const entry = byKey.get(key) || { file: item.file, global: item.global, count: 0, lines: [] };
        entry.count += 1;
        entry.lines.push(item.line);
        byKey.set(key, entry);
    }
    return Array.from(byKey.values()).sort((a, b) => a.file.localeCompare(b.file) || a.global.localeCompare(b.global));
}

function loadBaseline() {
    if (!fs.existsSync(baselinePath)) return null;
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}

const findings = walk(clientRoot).flatMap(findAssignments);
const summary = summarize(findings);

if (writeBaseline) {
    const data = {
        version: 1,
        description: 'Baseline for legacy client/chat window.* assignments. New entries must use window.Pivot.modules.* via Pivot.exposeModule instead.',
        generatedAt: new Date().toISOString(),
        total: findings.length,
        entries: summary
    };
    fs.writeFileSync(baselinePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log(`Window globals baseline written: ${findings.length} assignment(s), ${summary.length} file/global bucket(s).`);
    process.exit(0);
}

const baseline = loadBaseline();
if (!baseline) {
    console.error('Window globals scan failed: missing scripts/window_globals_baseline.json. Run node scripts/check_window_globals_usage.js --write-baseline after reviewing the legacy baseline.');
    process.exit(1);
}

const allowed = new Map((baseline.entries || []).map(item => [`${item.file}#${item.global}`, item.count]));
const violations = [];
for (const item of summary) {
    const key = `${item.file}#${item.global}`;
    const max = allowed.get(key) || 0;
    if (item.count > max) violations.push({ ...item, allowed: max });
}

if (violations.length === 0 && findings.length <= Number(baseline.total || 0)) {
    console.log(`Window globals scan passed: ${findings.length}/${baseline.total} legacy assignment(s), no new window.* exposure.`);
    process.exit(0);
}

console.error(`Window globals scan failed: ${violations.length} new or expanded window.* exposure bucket(s).`);
violations.slice(0, 30).forEach(item => {
    console.error(` - ${item.file}: window.${item.global} count ${item.count} > baseline ${item.allowed}; lines ${item.lines.join(', ')}`);
});
if (findings.length > Number(baseline.total || 0)) {
    console.error(` - Total assignments ${findings.length} > baseline ${baseline.total}.`);
}
console.error('Expose new APIs through window.Pivot.exposeModule(name, api, aliases) and read them via window.Pivot.modules.* where possible.');
if (!reportOnly) process.exit(1);
