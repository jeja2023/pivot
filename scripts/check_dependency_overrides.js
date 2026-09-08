const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const policyPath = path.join(__dirname, 'dependency_overrides_policy.json');

function validateDependencyOverrides(pkg, policy, now = Date.now()) {
    const failures = [];
    const overrides = pkg?.overrides || {};
    const entries = policy && typeof policy === 'object' ? policy : {};
    for (const [name, spec] of Object.entries(overrides)) {
        const rule = entries[name];
        if (!rule?.reason || !rule?.scope || !rule?.expiresOn) {
            failures.push(`${name} 缺少 reason、scope 或 expiresOn 治理登记`);
            continue;
        }
        if (!/^(?:\^|~|>=|<=|>|<|\*|latest$)/.test(String(spec || '').trim())) {
            failures.push(`${name} 使用精确锁定 ${spec}；请使用可接收补丁版本的范围`);
        }
        const expiresAt = Date.parse(`${rule.expiresOn}T23:59:59Z`);
        if (!Number.isFinite(expiresAt) || now > expiresAt) {
            failures.push(`${name} 的复查日期 ${rule.expiresOn || '缺失'} 已失效或无法解析`);
        }
    }
    for (const name of Object.keys(entries)) {
        if (!Object.prototype.hasOwnProperty.call(overrides, name)) {
            failures.push(`${name} 存在过期治理登记，但 package.json 已无对应 overrides`);
        }
    }
    return failures;
}

function main() {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    const failures = validateDependencyOverrides(pkg, policy);
    if (failures.length) {
        console.error('依赖 overrides 治理检查失败：');
        failures.forEach(item => console.error(` - ${item}`));
        process.exit(1);
    }
    console.log(`依赖 overrides 治理检查通过：${Object.keys(pkg.overrides || {}).length} 项均有有效复查登记。`);
}

if (require.main === module) main();

module.exports = { validateDependencyOverrides };
