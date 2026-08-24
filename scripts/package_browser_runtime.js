const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outputRoot = path.join(root, 'artifacts', 'agent-browser-pack');
const outputChromium = path.join(outputRoot, 'chromium');

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
    fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify({
        name: 'chromium',
        platform: process.platform,
        arch: process.arch,
        executable: path.relative(outputRoot, path.join(outputChromium, path.basename(executable))),
        source: 'playwright',
        packagedAt: new Date().toISOString()
    }, null, 2) + '\n', 'utf8');
    console.log(`已打包离线 Chromium：${path.relative(root, outputRoot)}`);
}

main();
