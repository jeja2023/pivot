'use strict';

const MAX_VBA_SOURCE_BYTES = 2 * 1024 * 1024;
const HIGH_RISK_VBA_PATTERNS = Object.freeze([
    { code: 'VBA_SHELL', pattern: /\b(?:shell|wscript\.shell|createobject\s*\(\s*['"]wscript\.shell)/i, message: '检测到系统命令或 Shell 调用。' },
    { code: 'VBA_NETWORK', pattern: /\b(?:winhttp|xmlhttp|urldownloadtofile|internetexplorer\.application)/i, message: '检测到网络请求或下载调用。' },
    { code: 'VBA_FILESYSTEM', pattern: /\b(?:scripting\.filesystemobject|kill\s+|rmdir\s+|filesystemobject)/i, message: '检测到高风险文件系统调用。' },
    { code: 'VBA_AUTOEXEC', pattern: /\b(?:auto_open|auto_close|workbook_open|document_open|presentation_open)\b/i, message: '检测到自动执行入口。' }
]);

function scanVbaSource(buffer, filename = '') {
    const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'utf8');
    if (source.length > MAX_VBA_SOURCE_BYTES) return { allowed: false, code: 'VBA_TOO_LARGE', warnings: ['宏源文件超过 2MB 限制。'], filename };
    const text = source.toString('utf8');
    const findings = HIGH_RISK_VBA_PATTERNS.filter(item => item.pattern.test(text)).map(item => ({ code: item.code, message: item.message }));
    return { allowed: findings.length === 0, code: findings.length ? 'VBA_RISK_DETECTED' : '', warnings: findings.map(item => item.message), findings, filename: String(filename || '').slice(0, 240) };
}

function isVbaFilename(filename) { return /\.(?:bas|vba)$/i.test(String(filename || '')); }

module.exports = { isVbaFilename, scanVbaSource };
