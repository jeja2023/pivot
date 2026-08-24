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

test('npm audit 的对象型 fixAvailable 同样表示已有修复', () => {
    const exceptions = buildExceptions({
        patterns: [/GHSA-demo/i],
        reason: '临时豁免',
        expiresOn: shiftDate(30)
    });
    const fixAvailable = { name: 'demo-pkg', version: '2.0.0', isSemVerMajor: true };
    const { failures, accepted } = classifyAuditFindings(buildAuditResult({ fixAvailable }), exceptions);
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
            electron: { name: 'electron', severity: 'high', via: ['extract-zip'] },
            'extract-zip': {
                name: 'extract-zip',
                severity: 'high',
                via: [{ source: 1, name: 'extract-zip', title: '路径穿越', severity: 'high' }]
            },
            'electron-builder': { name: 'electron-builder', severity: 'high', via: [] }
        }
    };
    const selected = selectAuditPackages(audit, ['electron']);
    assert.deepEqual(Object.keys(selected.vulnerabilities), ['electron', 'extract-zip']);
    assert.equal(classifyAuditFindings(selected).failures.length, 1);
});

test('缺失传递依赖详情时字符串 via 不能静默放行', () => {
    const audit = {
        vulnerabilities: {
            electron: { name: 'electron', severity: 'high', via: ['missing-transitive'] }
        }
    };
    assert.match(classifyAuditFindings(audit).failures[0], /missing-transitive/);
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
