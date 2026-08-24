const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SUPPORTED_LINUX_ARCHES = new Set(['x64', 'arm64']);

function resolveBuildTarget(rawArgs = [], runtime = process) {
    const args = rawArgs.map(String);
    if (args.includes('--loong64')) {
        const error = new Error('LoongArch64 暂无受支持的 Electron、DuckDB、Sharp 与 Playwright 运行时，禁止生成不可运行的正式安装包。');
        error.code = 'DESKTOP_ARCH_UNSUPPORTED';
        throw error;
    }
    const linux = args.some(arg => arg === 'deb' || arg.toLowerCase() === 'appimage' || arg === '--linux' || arg.startsWith('-c.linux'));
    const arch = args.includes('--arm64') ? 'arm64' : (args.includes('--x64') ? 'x64' : runtime.arch);
    const target = args.some(arg => arg.toLowerCase() === 'appimage') ? 'AppImage' : (linux ? 'deb' : (args.includes('--dir') ? 'dir' : 'nsis'));
    return {
        platform: linux ? 'linux' : 'win32',
        arch,
        target,
        key: linux ? `linux-${arch === 'x64' ? 'amd64' : arch}` : `windows-${arch}`
    };
}

function assertBuildHost(target, runtime = process) {
    if (target.platform !== 'linux') return target;
    if (!SUPPORTED_LINUX_ARCHES.has(target.arch)) {
        throw new Error(`不支持的 Linux 客户端架构：${target.arch}`);
    }
    if (runtime.platform !== 'linux') {
        throw new Error('Linux/UOS 客户端必须在 Linux 构建机或目标架构 Linux 容器中打包，避免混入 Windows 原生模块。');
    }
    if (runtime.arch !== target.arch) {
        throw new Error(`目标架构为 ${target.arch}，当前构建进程为 ${runtime.arch}；请使用目标架构原生机或 QEMU 容器。`);
    }
    return target;
}

function assertLinuxPackageMetadata(pkg, rootDir) {
    if (!pkg?.author?.name || !pkg?.author?.email) throw new Error('Linux .deb 构建必须配置 package.json author.name 与 author.email。');
    if (!pkg.homepage) throw new Error('Linux .deb 构建必须配置 package.json homepage。');
    if (!pkg.license) throw new Error('Linux .deb 构建必须配置 package.json license。');
    const icon = String(pkg.build?.linux?.icon || '');
    if (!/\.png$/i.test(icon)) throw new Error('Linux 客户端图标必须使用 PNG。');
    if (!fs.existsSync(path.resolve(rootDir, icon))) throw new Error(`Linux 客户端图标不存在：${icon}`);
}

function assertRuntimeManifest(manifestPath, target, options = {}) {
    if (!fs.existsSync(manifestPath)) throw new Error(`桌面运行包清单不存在：${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.platform !== target.platform || manifest.arch !== target.arch) {
        throw new Error(`运行包架构不匹配：${manifestPath} 为 ${manifest.platform}/${manifest.arch}，目标为 ${target.platform}/${target.arch}`);
    }
    if (options.requireBundled === true && manifest.bundled !== true) {
        throw new Error(`运行包未完整内置：${manifestPath}`);
    }
    if (manifest.executable) {
        const executablePath = path.resolve(path.dirname(manifestPath), manifest.executable);
        if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
            throw new Error(`运行包可执行文件不存在：${executablePath}`);
        }
    }
    return manifest;
}

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseChecksumManifest(text) {
    const entries = new Map();
    String(text || '').split(/\r?\n/).filter(Boolean).forEach(line => {
        const match = line.match(/^([a-f0-9]{64})  (.+)$/i);
        if (!match) throw new Error(`无法解析 SHA256 清单行：${line}`);
        entries.set(match[2], match[1].toLowerCase());
    });
    return entries;
}

function formatChecksumManifest(entries) {
    return `${Array.from(entries.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, digest]) => `${digest}  ${name}`)
        .join('\n')}\n`;
}

function rebuildCombinedChecksumManifest(downloadsDir) {
    const combined = new Map();
    const manifests = fs.readdirSync(downloadsDir)
        .filter(name => /^SHA256SUMS-.+\.txt$/.test(name))
        .sort();
    manifests.forEach(name => {
        const entries = parseChecksumManifest(fs.readFileSync(path.join(downloadsDir, name), 'utf8'));
        entries.forEach((digest, fileName) => combined.set(fileName, digest));
    });
    fs.writeFileSync(path.join(downloadsDir, 'SHA256SUMS.txt'), formatChecksumManifest(combined), 'utf8');
    return { manifest: 'SHA256SUMS.txt', entries: combined.size };
}

function writePlatformChecksumManifest(downloadsDir, fileNames, target) {
    fs.mkdirSync(downloadsDir, { recursive: true });
    const manifestName = `SHA256SUMS-${target.key}.txt`;
    const manifestPath = path.join(downloadsDir, manifestName);
    const entries = fs.existsSync(manifestPath)
        ? parseChecksumManifest(fs.readFileSync(manifestPath, 'utf8'))
        : new Map();
    Array.from(new Set(fileNames)).forEach(fileName => {
        const safeName = path.basename(fileName);
        const filePath = path.join(downloadsDir, safeName);
        if (!fs.existsSync(filePath)) throw new Error(`待校验发布文件不存在：${filePath}`);
        entries.set(safeName, hashFile(filePath));
    });
    fs.writeFileSync(manifestPath, formatChecksumManifest(entries), 'utf8');
    rebuildCombinedChecksumManifest(downloadsDir);
    return { manifestName, entries };
}

module.exports = {
    SUPPORTED_LINUX_ARCHES,
    assertBuildHost,
    assertLinuxPackageMetadata,
    assertRuntimeManifest,
    formatChecksumManifest,
    parseChecksumManifest,
    rebuildCombinedChecksumManifest,
    resolveBuildTarget,
    writePlatformChecksumManifest
};
