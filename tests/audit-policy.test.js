// 依赖审计门禁回归测试
// 门禁负责拦截 high/critical 漏洞，其豁免机制必须保证「临时豁免不会沉淀成永久放行」，
// 因此对到期失效、登记不完整和上游已有修复三类情况做断言。
const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAuditInvocation, classifyAuditFindings, selectAuditPackages } = require('../scripts/check_audit_policy');

// 构造一份最小可用的 npm audit JSON 结果。
function buildAuditResult({ name = 'demo-pkg', severity = 'high', fixAvailable = false, title = '示例高危漏洞', url = 'https://example.test/GHSA-demo' } = {}) {
    return {
        vulnerabilities: {
            [name]: {
                name,
                severity,
                fixAvailable,
                via: [{ source: 1, name, title, url, severity }]
            }
        }
    };
}

function buildExceptions(entry, name = 'demo-pkg') {
    return new Map([[name, entry]]);
}

// 复查日期取相对当天的偏移，避免测试随时间推移失效。
function shiftDate(days) {
    const target = new Date(Date.now() + days * 86400000);
    return target.toISOString().slice(0, 10);
}

test('未登记豁免的高危漏洞会被门禁拦截', () => {
    const { failures, accepted } = classifyAuditFindings(buildAuditResult(), new Map());
    assert.equal(accepted.length, 0);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /示例高危漏洞/);
});

test('登记完整且未到复查日期的豁免会被接受', () => {
    const exceptions = buildExceptions({
        patterns: [/GHSA-demo/i],
        reason: '上游尚未发布修复版本',
        expiresOn: shiftDate(30)
    });
    const { failures, accepted } = classifyAuditFindings(buildAuditResult(), exceptions);
    assert.equal(failures.length, 0);
    assert.equal(accepted.length, 1);
    assert.match(accepted[0], /上游尚未发布修复版本/);
});

test('豁免超过复查日期后自动失效并让门禁转红', () => {
    const exceptions = buildExceptions({
        patterns: [/GHSA-demo/i],
        reason: '上游尚未发布修复版本',
        expiresOn: shiftDate(-1)
    });
    const { failures, accepted } = classifyAuditFindings(buildAuditResult(), exceptions);
    assert.equal(accepted.length, 0);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /到期/);
});

test('豁免缺少理由或复查日期时不生效', () => {
    const missingReason = buildExceptions({ patterns: [/GHSA-demo/i], expiresOn: shiftDate(30) });
    assert.match(classifyAuditFindings(buildAuditResult(), missingReason).failures[0], /缺少理由或复查日期/);

    const missingExpiry = buildExceptions({ patterns: [/GHSA-demo/i], reason: '上游暂无修复' });
    assert.match(classifyAuditFindings(buildAuditResult(), missingExpiry).failures[0], /缺少理由或复查日期/);
});

test('复查日期无法解析时按失效处理', () => {
    const exceptions = buildExceptions({
        patterns: [/GHSA-demo/i],
        reason: '上游暂无修复',
        expiresOn: '不是日期'
    });
    assert.match(classifyAuditFindings(buildAuditResult(), exceptions).failures[0], /无法解析/);
});

test('上游已有修复版本时不接受豁免', () => {
    const exceptions = buildExceptions({
        patterns: [/GHSA-demo/i],
        reason: '上游尚未发布修复版本',
        expiresOn: shiftDate(30)
    });
    const { failures, accepted } = classifyAuditFindings(buildAuditResult({ fixAvailable: true }), exceptions);
    assert.equal(accepted.length, 0);
    assert.match(failures[0], /已有修复版本/);
});

test('中低危漏洞不进入门禁拦截范围', () => {
    const { failures, accepted } = classifyAuditFindings(buildAuditResult({ severity: 'moderate' }), new Map());
    assert.equal(failures.length, 0);
    assert.equal(accepted.length, 0);
});
test('packaged desktop runtime audit includes Electron without build-only tooling', () => {
    const audit = {
        vulnerabilities: {
            electron: { name: 'electron', severity: 'high', via: [] },
            'electron-builder': { name: 'electron-builder', severity: 'high', via: [] }
        }
    };
    const selected = selectAuditPackages(audit, ['electron']);
    assert.deepEqual(Object.keys(selected.vulnerabilities), ['electron']);
});

test('npm audit uses a platform-safe invocation', () => {
    const args = ['audit', '--omit=dev', '--json'];
    assert.deepEqual(buildAuditInvocation(args, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }), {
        command: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', 'npm.cmd', ...args]
    });
    assert.deepEqual(buildAuditInvocation(args, 'linux', {}), {
        command: 'npm',
        args
    });
});
