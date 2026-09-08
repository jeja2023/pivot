const fs = require('fs');
const path = require('path');

const entries = JSON.parse(fs.readFileSync(path.join(__dirname, 'async_db_calls_allowlist.json'), 'utf8'));
const signatures = new Set(entries.map(item => `${item.file}|${item.callee}|${item.code}`));
const root = path.resolve(__dirname, '..');

function isAllowedFinding(finding = {}) {
    const file = String(finding.file || '').replace(/\\/g, '/');
    return signatures.has(`${file}|${finding.callee || ''}|${finding.code || ''}`);
}

function validateAllowlist(targetFiles = []) {
    const targets = new Set(targetFiles.map(file => String(file).replace(/\\/g, '/')));
    const failures = [];
    const seen = new Set();
    for (const entry of entries) {
        const signature = `${entry.file}|${entry.callee}|${entry.code}`;
        if (seen.has(signature)) failures.push(`重复白名单签名：${signature}`);
        seen.add(signature);
        if (!targets.has(entry.file)) {
            failures.push(`白名单条目不在当前扫描范围：${entry.file}`);
            continue;
        }
        const absolute = path.join(root, entry.file);
        if (!fs.existsSync(absolute)) {
            failures.push(`白名单条目文件不存在：${entry.file}`);
            continue;
        }
        if (!fs.readFileSync(absolute, 'utf8').includes(entry.code)) {
            failures.push(`白名单源码签名已失效：${entry.file} :: ${entry.code}`);
        }
    }
    return failures;
}

module.exports = { isAllowedFinding, validateAllowlist };
