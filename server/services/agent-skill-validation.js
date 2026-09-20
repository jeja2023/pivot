'use strict';

const fs = require('fs');
const path = require('path');
const { createWorkspaceJail, runSandboxedProcess } = require('./agent-sandbox');
const { scanSkillPackageEntries } = require('./agent-skill-supply-chain');
const { capabilitiesCoverTool } = require('./agent-capability-registry');
const { isRegisteredToolName, resolveRegisteredToolCapabilities } = require('./agent-tool-capabilities');

const MAX_SCANNED_PACKAGE_FILES = 256;
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

function scanInstalledPackage(packageRoot, manifest) {
    const root = String(packageRoot || '').trim();
    if (!root || !fs.existsSync(root)) return scanSkillPackageEntries([], manifest);
    const entries = [];
    const walk = (directory, prefix = '') => {
        if (entries.length >= MAX_SCANNED_PACKAGE_FILES) return;
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entries.length >= MAX_SCANNED_PACKAGE_FILES) return;
            const absolute = path.join(directory, item.name); const relative = prefix ? `${prefix}/${item.name}` : item.name;
            if (item.isSymbolicLink()) { entries.push({ name: relative, data: Buffer.alloc(0), externalFileAttributes: 0xA1FF0000 }); continue; }
            if (item.isDirectory()) { walk(absolute, relative); continue; }
            if (!item.isFile()) continue;
            const stat = fs.statSync(absolute); const data = stat.size <= MAX_SCANNED_FILE_BYTES ? fs.readFileSync(absolute) : Buffer.alloc(0);
            entries.push({ name: relative, data, compressedSize: stat.size, uncompressedSize: stat.size, externalFileAttributes: 0 });
        }
    };
    walk(root); return scanSkillPackageEntries(entries, manifest);
}

function runDeclarativeSkillChecks(checked) {
    const errors = []; const toolAssertions = [];
    checked.tools.forEach(name => {
        if (!isRegisteredToolName(name)) { errors.push(`技能声明的工具未在平台登记：${name}`); toolAssertions.push({ tool: name, registered: false, covered: false }); return; }
        const required = resolveRegisteredToolCapabilities(name); const covered = capabilitiesCoverTool(checked.capabilities, required);
        if (!covered) errors.push(`技能声明的能力未覆盖工具 ${name} 所需能力（${required.join('、')}）。`);
        toolAssertions.push({ tool: name, registered: true, covered, requiredCapabilities: required });
    });
    const manifest = checked.manifest || {};
    ['inputs', 'outputs'].forEach(field => { if (manifest[field] !== undefined && (!manifest[field] || typeof manifest[field] !== 'object' || Array.isArray(manifest[field]))) errors.push(`manifest.${field} 必须是对象。`); });
    if (Array.isArray(manifest.tests) || Array.isArray(manifest.regressionTests)) errors.push('manifest.tests 中的可执行脚本已被禁止，请改用平台声明式验证。');
    return { passed: errors.length === 0, mode: 'platform-declarative', scriptsExecuted: false, skipReason: '隔离执行环境未启用，包内脚本一律不执行（落地方案 v1.2 阶段 0.9）。', toolAssertions, errors };
}

async function sandboxValidateSkill({ version, packageRoot = '', user, options = {} }) {
    const root = packageRoot && fs.existsSync(packageRoot) ? packageRoot : path.dirname(__filename);
    const jail = createWorkspaceJail(options.workspaceRoot || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-release-sandbox'), `skill-${version.id}`);
    const staged = jail.resolve('package'); fs.mkdirSync(staged, { recursive: true, mode: 0o700 }); fs.cpSync(root, staged, { recursive: true, force: false, errorOnExist: false });
    const staticScript = ['const fs=require("fs");', 'const p=process.argv[1];', 'if(!fs.existsSync(p)) process.exit(2);', 'const s=fs.statSync(p);', 'if(!s.isDirectory()) process.exit(3);', 'process.stdout.write(JSON.stringify({ok:true,files:fs.readdirSync(p).length}));'].join('');
    const result = await runSandboxedProcess(process.execPath, ['-e', staticScript, staged], { jail, strictIsolation: options.strictIsolation ?? (process.env.PIVOT_AGENT_STRICT_ISOLATION === '1' || process.env.PIVOT_AGENT_STRICT_ISOLATION === 'true'), networkDisabled: true, timeoutMs: Math.min(Math.max(Number(options.timeoutMs) || 30000, 1000), 120000), inheritEnv: false, user });
    return { passed: result.code === 0, mode: 'isolated-static-sandbox', sideEffects: false, packageScriptsExecuted: false, result: { code: result.code, stdout: result.stdout.slice(0, 4000), stderr: result.stderr.slice(0, 4000), isolation: result.isolation } };
}

module.exports = { runDeclarativeSkillChecks, sandboxValidateSkill, scanInstalledPackage };
