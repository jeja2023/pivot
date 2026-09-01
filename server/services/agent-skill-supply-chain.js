/**
 * server/services/agent-skill-supply-chain.js
 * Skill 包供应链校验（对压缩包实际条目执行）
 *
 * 落地方案 v1.2 B7、§5.2 第 3/5 条与阶段 0.7：
 * 原实现只遍历 manifest.files 自报清单，未在清单中申报的文件完全不受检。
 * 本模块改为对解包后的实际条目执行全部检查：
 * 路径安全、符号链接属性、敏感文件黑名单、npm 生命周期钩子、包内脚本、
 * 压缩炸弹比率、清单与实际条目一致性、依赖锁文件与声明一致性。
 */
const path = require('path');
const {
    isSymlinkExternalAttributes,
    normalizeRelativeEntryPath
} = require('./agent-path-safety');

/** 敏感文件黑名单：命中即拒绝，不依赖 manifest 自报。 */
const SENSITIVE_ENTRY_PATTERNS = Object.freeze([
    /(^|\/)\.env(\.|$)/i,
    /(^|\/)\.git(\/|$)/i,
    /(^|\/)\.ssh(\/|$)/i,
    /(^|\/)\.npmrc$/i,
    /(^|\/)\.netrc$/i,
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
    /(^|\/)credentials?(\.json|\.yaml|\.yml)?$/i,
    /(^|\/)secrets?(\.json|\.yaml|\.yml)?$/i,
    /\.(pem|pfx|p12|key|keystore|jks)$/i,
    /(^|\/)\.aws(\/|$)/i,
    /(^|\/)\.kube(\/|$)/i
]);

/** 可执行内容：隔离 Worker 落地前一律拒绝（§5.3 过渡要求）。 */
const EXECUTABLE_ENTRY_PATTERNS = Object.freeze([
    /(^|\/)scripts?\//i,
    /\.(sh|bat|cmd|ps1|exe|dll|so|dylib)$/i
]);

const NPM_LIFECYCLE_HOOKS = Object.freeze([
    'preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'postpublish'
]);

const LOCK_FILES = Object.freeze(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'poetry.lock']);

/** 压缩炸弹阈值：单条目解压/压缩比上限与总解压上限倍数。 */
const MAX_ENTRY_COMPRESSION_RATIO = 200;
const MIN_COMPRESSED_BYTES_FOR_RATIO = 1024;

function toText(data) {
    return Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
}

function checkEntryPaths(entries, errors) {
    const seen = new Set();
    entries.forEach(entry => {
        let safeName;
        try {
            safeName = normalizeRelativeEntryPath(entry.name);
        } catch (error) {
            errors.push(`Skill 包条目路径非法（${entry.name}）：${error.message}`);
            return;
        }
        if (seen.has(safeName)) errors.push(`Skill 包包含重复文件路径：${safeName}`);
        seen.add(safeName);
        if (isSymlinkExternalAttributes(entry.externalFileAttributes)) {
            errors.push(`Skill 包禁止包含符号链接条目：${safeName}`);
        }
        if (SENSITIVE_ENTRY_PATTERNS.some(pattern => pattern.test(safeName))) {
            errors.push(`Skill 包包含敏感文件：${safeName}`);
        }
        if (EXECUTABLE_ENTRY_PATTERNS.some(pattern => pattern.test(safeName))) {
            errors.push(`隔离执行环境未启用前，Skill 包禁止包含可执行内容：${safeName}`);
        }
    });
}

function checkCompressionRatio(entries, errors) {
    entries.forEach(entry => {
        const compressed = Number(entry.compressedSize) || 0;
        const uncompressed = Number(entry.uncompressedSize) || (entry.data ? entry.data.length : 0);
        if (compressed < MIN_COMPRESSED_BYTES_FOR_RATIO) return;
        if (uncompressed / compressed > MAX_ENTRY_COMPRESSION_RATIO) {
            errors.push(`Skill 包条目压缩比异常（疑似压缩炸弹）：${entry.name}`);
        }
    });
}

function checkPackageJsonHooks(entries, errors) {
    entries
        .filter(entry => /(^|\/)package\.json$/i.test(entry.name))
        .forEach(entry => {
            let parsed;
            try {
                parsed = JSON.parse(toText(entry.data));
            } catch (error) {
                errors.push(`Skill 包 ${entry.name} 解析失败：${error.message}`);
                return;
            }
            const scripts = parsed?.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
            const hooks = NPM_LIFECYCLE_HOOKS.filter(hook => scripts[hook]);
            if (hooks.length) errors.push(`Skill 包禁止声明 npm 生命周期脚本：${entry.name} 中的 ${hooks.join('、')}`);
        });
}

function checkManifestFileConsistency(entries, manifest, errors) {
    const declared = Array.isArray(manifest?.files) ? manifest.files.map(item => String(item || '').replace(/\\/g, '/')) : [];
    if (!declared.length) return;
    const actual = new Set(entries.map(entry => entry.name));
    declared.forEach(file => {
        if (!actual.has(file)) errors.push(`manifest.files 声明的文件在包中不存在：${file}`);
    });
    const declaredSet = new Set(declared);
    entries
        .filter(entry => !declaredSet.has(entry.name))
        .filter(entry => !['SKILL.yaml', 'SKILL.yml', 'SKILL.json', 'SKILL.md', 'SKILL.sig', 'package.sig', 'INSTRUCTIONS.md', 'instructions.md'].includes(entry.name))
        .forEach(entry => errors.push(`包中存在未在 manifest.files 申报的文件：${entry.name}`));
}

/**
 * 依赖锁文件校验。
 * 现状只判断锁文件是否存在；此处补充锁文件内容与 manifest.dependencies 的一致性（§5.2 第 5 条）。
 */
function checkDependencyLock(entries, manifest, errors) {
    const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
    const names = Object.keys(dependencies);
    names.forEach(name => {
        if (!/^[a-zA-Z0-9._@/-]{1,120}$/.test(name)) errors.push(`依赖名称非法：${name}`);
    });
    if (!names.length) return { lockFiles: [], dependencies };
    const lockEntries = entries.filter(entry => LOCK_FILES.includes(path.posix.basename(entry.name)));
    if (!lockEntries.length) {
        errors.push('Skill 声明依赖但未提供锁定文件。');
        return { lockFiles: [], dependencies };
    }
    const lockText = lockEntries.map(entry => toText(entry.data)).join('\n');
    names.forEach(name => {
        if (!lockText.includes(name)) errors.push(`依赖 ${name} 未出现在锁定文件中，锁文件与声明不一致。`);
    });
    return { lockFiles: lockEntries.map(entry => entry.name), dependencies };
}

/**
 * 对实际条目执行完整供应链校验。
 * @param {Array} entries [{ name, data, compressedSize, uncompressedSize, externalFileAttributes }]
 */
function scanSkillPackageEntries(entries = [], manifest = {}) {
    const errors = [];
    const safeEntries = Array.isArray(entries) ? entries : [];
    checkEntryPaths(safeEntries, errors);
    checkCompressionRatio(safeEntries, errors);
    checkPackageJsonHooks(safeEntries, errors);
    checkManifestFileConsistency(safeEntries, manifest, errors);
    const lock = checkDependencyLock(safeEntries, manifest, errors);
    return {
        passed: errors.length === 0,
        errors,
        scannedEntries: safeEntries.length,
        lockFiles: lock.lockFiles,
        dependencies: lock.dependencies,
        scope: 'actual-entries'
    };
}

/**
 * 兼容入口：只有 manifest 而没有条目数据（例如历史版本记录只存了 package_path）时，
 * 明确返回「未扫描实际条目」，让发布门禁把它当作未通过而不是静默通过。
 */
function supplyChainNotScanned(reason = '缺少压缩包实际条目，无法执行供应链扫描。') {
    return { passed: false, errors: [reason], scannedEntries: 0, lockFiles: [], dependencies: {}, scope: 'not-scanned' };
}

module.exports = {
    EXECUTABLE_ENTRY_PATTERNS,
    LOCK_FILES,
    MAX_ENTRY_COMPRESSION_RATIO,
    NPM_LIFECYCLE_HOOKS,
    SENSITIVE_ENTRY_PATTERNS,
    scanSkillPackageEntries,
    supplyChainNotScanned
};
