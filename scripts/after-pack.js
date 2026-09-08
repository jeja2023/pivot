const fs = require('fs');
const path = require('path');

function targetPrebuildNames(platform, arch) {
    if (platform === 'linux') return new Set([`linux-${arch}.node`, `linuxmusl-${arch}.node`]);
    if (platform === 'win32') return new Set([`win32-${arch}.node`]);
    if (platform === 'darwin') return new Set([`darwin-${arch}.node`]);
    throw new Error(`不支持裁剪 better-sqlite3 原生包的平台：${platform}`);
}

function normalizeArch(value) {
    if (typeof value === 'string' && value) return value;
    return ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' })[Number(value)] || '';
}

function assertInside(parent, target) {
    const relative = path.relative(parent, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`拒绝处理包输出目录之外的路径：${target}`);
}

async function afterPack(context) {
    const appOutDir = path.resolve(context.appOutDir);
    const platform = context.electronPlatformName || context.packager?.platform?.nodeName;
    const arch = normalizeArch(context.arch);
    const packageRoot = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
    assertInside(appOutDir, packageRoot);
    const prebuilds = path.join(packageRoot, 'prebuilds');
    const wanted = targetPrebuildNames(platform, arch);
    if (!fs.existsSync(prebuilds)) throw new Error(`better-sqlite3 预编译目录不存在：${prebuilds}`);

    const present = fs.readdirSync(prebuilds).filter(name => name.endsWith('.node'));
    for (const name of wanted) {
        if (!present.includes(name)) throw new Error(`缺少目标平台 better-sqlite3 原生模块：${name}`);
    }
    for (const name of present) {
        if (!wanted.has(name)) fs.rmSync(path.join(prebuilds, name), { force: true });
    }
    for (const name of ['deps', 'src', 'binding.gyp']) {
        const target = path.join(packageRoot, name);
        assertInside(packageRoot, target);
        fs.rmSync(target, { recursive: true, force: true });
    }
    console.log(`[afterPack] 已裁剪 better-sqlite3：${platform}/${arch}，保留 ${[...wanted].join(', ')}`);
}

module.exports = afterPack;
module.exports.targetPrebuildNames = targetPrebuildNames;
module.exports.normalizeArch = normalizeArch;
