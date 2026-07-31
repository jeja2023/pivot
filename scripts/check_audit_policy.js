const { spawnSync } = require('child_process');

// 依赖审计豁免清单。
// 只登记「上游确认暂时无法修复」的 high/critical 问题，且必须同时写明豁免理由和复查日期。
// 复查日期一过豁免自动失效、门禁转红，避免临时豁免沉淀成永久放行。
// 登记格式：
//     ['包名', {
//         patterns: [/GHSA-xxxx-xxxx-xxxx/i, /关键字/i],
//         reason: '上游尚未发布修复版本，已通过 xxx 缓解',
//         expiresOn: '2026-09-30' // 复查日期，过期后该豁免自动失效
//     }]
// 当前无需豁免：axios、js-yaml、sharp 与 body-parser 的历史告警已通过依赖升级清零。
const allowed = new Map([]);

function runAudit({ omitDev = false } = {}) {
    // Windows 下直接调用 npm.cmd，避免使用 shell 选项传参触发 DEP0190 安全弃用告警。
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['audit'];
    if (omitDev) args.push('--omit=dev');
    args.push('--audit-level=high', '--json');
    const result = spawnSync(npmCommand, args, {
        encoding: 'utf8'
    });
    const output = result.stdout || result.stderr || '{}';
    try {
        return JSON.parse(output);
    } catch (error) {
        console.error(output);
        throw new Error(`无法解析 npm audit 的 JSON 输出：${error.message}`);
    }
}

function selectAuditPackages(auditResult, packageNames) {
    const names = new Set(packageNames || []);
    const vulnerabilities = Object.fromEntries(
        Object.entries(auditResult?.vulnerabilities || {}).filter(([name]) => names.has(name))
    );
    return { ...auditResult, vulnerabilities };
}

function advisoryText(item) {
    if (!item || typeof item !== 'object') return String(item || '');
    return [item.source, item.name, item.title, item.url, item.severity, item.range].filter(Boolean).join(' ');
}

// 校验豁免登记本身是否完整、是否已过复查日期；返回值用于区分「有效豁免」和「豁免已失效」。
function evaluateException(packageName, advisory, exceptions = allowed) {
    const entry = exceptions.get(packageName);
    if (!entry) return { matched: false };

    const patterns = Array.isArray(entry.patterns) ? entry.patterns : [];
    const text = advisoryText(advisory);
    if (!patterns.some(pattern => pattern.test(text))) return { matched: false };

    if (!entry.reason || !entry.expiresOn) {
        return { matched: true, valid: false, note: '豁免登记缺少理由或复查日期' };
    }

    const expiresAt = Date.parse(`${entry.expiresOn}T23:59:59`);
    if (!Number.isFinite(expiresAt)) {
        return { matched: true, valid: false, note: `豁免复查日期无法解析：${entry.expiresOn}` };
    }
    if (Date.now() > expiresAt) {
        return { matched: true, valid: false, note: `豁免已于 ${entry.expiresOn} 到期，请重新评估或修复` };
    }

    return { matched: true, valid: true, note: `${entry.reason}（复查日期 ${entry.expiresOn}）` };
}

// 按审计结果分流为「已接受豁免」和「必须处理」两类，供命令行执行和回归测试共用。
function classifyAuditFindings(auditResult, exceptions = allowed) {
    const vulnerabilities = (auditResult && auditResult.vulnerabilities) || {};
    const failures = [];
    const accepted = [];

    for (const [name, vuln] of Object.entries(vulnerabilities)) {
        if (!['high', 'critical'].includes(String(vuln.severity || '').toLowerCase())) continue;
        const advisories = Array.isArray(vuln.via) && vuln.via.length > 0 ? vuln.via : [vuln];
        for (const advisory of advisories) {
            if (typeof advisory === 'string') continue;
            const title = advisory.title || advisory.url || advisory.source || '未命名告警';
            const exception = evaluateException(name, advisory, exceptions);

            // 上游已经提供修复版本时不接受任何豁免，必须直接升级。
            if (exception.matched && exception.valid && vuln.fixAvailable !== true) {
                accepted.push(`${name}: ${title} —— ${exception.note}`);
                continue;
            }
            if (exception.matched && !exception.valid) {
                failures.push(`${name}: ${title} —— ${exception.note}`);
                continue;
            }
            if (exception.matched && vuln.fixAvailable === true) {
                failures.push(`${name}: ${title} —— 上游已有修复版本，不接受豁免，请直接升级`);
                continue;
            }
            failures.push(`${name}: ${title}`);
        }
    }

    return { accepted, failures };
}

function main() {
    const production = classifyAuditFindings(runAudit({ omitDev: true }));
    const desktopRuntimeAudit = selectAuditPackages(runAudit(), ['electron']);
    const desktopRuntime = classifyAuditFindings(desktopRuntimeAudit);
    const accepted = [
        ...production.accepted.map(item => `[production] ${item}`),
        ...desktopRuntime.accepted.map(item => `[desktop-runtime] ${item}`)
    ];
    const failures = [
        ...production.failures.map(item => `[production] ${item}`),
        ...desktopRuntime.failures.map(item => `[desktop-runtime] ${item}`)
    ];

    if (accepted.length > 0) {
        console.log('已接受的临时依赖审计豁免：');
        accepted.forEach(item => console.log(` - ${item}`));
    }

    if (failures.length > 0) {
        console.error('存在未豁免的 high/critical 依赖审计问题：');
        failures.forEach(item => console.error(` - ${item}`));
        console.error('请升级对应依赖；确认上游暂时无法修复时，在 scripts/check_audit_policy.js 的豁免清单中登记理由与复查日期。');
        process.exit(1);
    }

    console.log('依赖审计策略检查通过。');
}

if (require.main === module) main();

module.exports = {
    classifyAuditFindings,
    evaluateException,
    selectAuditPackages
};
