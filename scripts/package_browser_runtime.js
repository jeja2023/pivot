const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'artifacts', 'agent-browser-pack');
const outputChromium = path.join(outputRoot, 'chromium');
const DEFAULT_BROWSER_LOCALES = new Set(['en-US', 'zh-CN']);

function resolveExecutable() {
    if (process.env.PIVOT_CHROMIUM_PATH && fs.existsSync(process.env.PIVOT_CHROMIUM_PATH)) return path.resolve(process.env.PIVOT_CHROMIUM_PATH);
    let chromium;
    try { ({ chromium } = require('playwright')); } catch (error) {
        throw new Error(`无法加载 Playwright Chromium：${error.message}`);
    }
    const executable = chromium.executablePath();
    if (!executable || !fs.existsSync(executable)) throw new Error(`找不到 Playwright Chromium：${executable || '<empty>'}`);
    return path.resolve(executable);
}

function copyDir(source, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isDirectory()) copyDir(from, to);
        else fs.copyFileSync(from, to);
    }
}

function configuredBrowserLocales(value = process.env.PIVOT_CHROMIUM_LOCALES) {
    const locales = String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(item => /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(item));
    return new Set(locales.length ? locales : DEFAULT_BROWSER_LOCALES);
}

function pruneChromiumRuntime(browserRoot, { platform = process.platform, locales = configuredBrowserLocales() } = {}) {
    const removed = [];
    const remove = relativePath => {
        const target = path.join(browserRoot, relativePath);
        if (!fs.existsSync(target)) return;
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(relativePath);
    };
    if (platform === 'win32') {
        // Playwright 的 zip 内包含 Chromium 安装、提权、PWA 和通知辅助程序；
        // Agent 仅以 chrome.exe 的无界面自动化模式启动，不会调用它们。
        [
            'setup.exe',
            'elevated_tracing_service.exe',
            'elevation_service.exe',
            'chrome_proxy.exe',
            'chrome_pwa_launcher.exe',
            'notification_helper.exe',
            // Agent 浏览器不启用 WebGPU；移除 D3D shader 编译器可避免把
            // 与无头自动化无关的 25MB DLL 放进本地运行时包。
            'dxcompiler.dll',
            'dxil.dll'
        ].forEach(remove);
    }
    const localesDir = path.join(browserRoot, 'locales');
    if (fs.existsSync(localesDir)) {
        for (const entry of fs.readdirSync(localesDir)) {
            if (!entry.endsWith('.pak')) continue;
            if (!locales.has(entry.slice(0, -4))) remove(path.join('locales', entry));
        }
    }
    return removed;
}

function main() {
    const executable = resolveExecutable();
    if (process.platform === 'linux' && !['x64', 'arm64'].includes(process.arch)) {
        throw new Error(`Playwright Chromium 暂不支持当前 Linux 架构：${process.arch}`);
    }
    const browserRoot = path.dirname(executable);
    if (process.argv.includes('--dry-run')) {
        console.log(JSON.stringify({ executable, browserRoot, outputRoot }, null, 2));
        return;
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    copyDir(browserRoot, outputChromium);
    const removed = pruneChromiumRuntime(outputChromium);
    fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify({
        name: 'chromium',
        platform: process.platform,
        arch: process.arch,
        executable: path.relative(outputRoot, path.join(outputChromium, path.basename(executable))),
        source: 'playwright',
        packagedAt: new Date().toISOString(),
        locales: [...configuredBrowserLocales()].sort(),
        pruned: removed
    }, null, 2) + '\n', 'utf8');
    console.log(`已打包离线 Chromium：${path.relative(root, outputRoot)}（已裁剪 ${removed.length} 项）`);
}

if (require.main === module) main();

module.exports = { configuredBrowserLocales, pruneChromiumRuntime, resolveExecutable };
