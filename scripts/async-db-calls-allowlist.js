const fs = require('fs');
const path = require('path');

const entries = JSON.parse(fs.readFileSync(path.join(__dirname, 'async_db_calls_allowlist.json'), 'utf8'));
const signatures = new Set(entries.map(item => `${item.file}|${item.callee}|${item.code}`));

function isAllowedFinding(finding = {}) {
    const file = String(finding.file || '').replace(/\\/g, '/');
    return signatures.has(`${file}|${finding.callee || ''}|${finding.code || ''}`);
}

module.exports = { isAllowedFinding };
