const { spawnSync } = require('child_process');

const allowed = new Map([
    ['form-data', [
        /GHSA-hmw2-7cc7-3qxx/i,
        /unsafe random function|multipart/i
    ]],
    ['multer', [
        /GHSA-72gw-mp4g-v24j/i,
        /GHSA-3p4h-7m6x-2hcm/i,
        /denial of service|DoS/i
    ]]
]);

function runAudit() {
    const result = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'], {
        encoding: 'utf8',
        shell: process.platform === 'win32'
    });
    const output = result.stdout || result.stderr || '{}';
    try {
        return JSON.parse(output);
    } catch (error) {
        console.error(output);
        throw new Error(`Unable to parse npm audit JSON: ${error.message}`);
    }
}

function advisoryText(item) {
    if (!item || typeof item !== 'object') return String(item || '');
    return [item.source, item.name, item.title, item.url, item.severity, item.range].filter(Boolean).join(' ');
}

function isAllowed(packageName, advisory) {
    const patterns = allowed.get(packageName);
    if (!patterns) return false;
    const text = advisoryText(advisory);
    return patterns.some(pattern => pattern.test(text));
}

const audit = runAudit();
const vulnerabilities = audit.vulnerabilities || {};
const failures = [];
const accepted = [];

for (const [name, vuln] of Object.entries(vulnerabilities)) {
    if (!['high', 'critical'].includes(String(vuln.severity || '').toLowerCase())) continue;
    const advisories = Array.isArray(vuln.via) && vuln.via.length > 0 ? vuln.via : [vuln];
    for (const advisory of advisories) {
        if (typeof advisory === 'string') continue;
        if (isAllowed(name, advisory) && vuln.fixAvailable !== true) {
            accepted.push(`${name}: ${advisory.title || advisory.url || advisory.source || 'accepted advisory'}`);
        } else {
            failures.push(`${name}: ${advisory.title || advisory.url || advisory.source || 'unaccepted advisory'}`);
        }
    }
}

if (accepted.length > 0) {
    console.log('Accepted temporary audit exceptions:');
    accepted.forEach(item => console.log(` - ${item}`));
}

if (failures.length > 0) {
    console.error('Unaccepted high/critical npm audit findings:');
    failures.forEach(item => console.error(` - ${item}`));
    process.exit(1);
}

console.log('npm audit policy passed.');
