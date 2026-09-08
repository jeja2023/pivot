const fs = require('fs');
const path = require('path');
const expectedPlatform = String(process.argv[2] || '');
const expectedArch = String(process.argv[3] || '');

if (expectedPlatform && process.platform !== expectedPlatform) {
    throw new Error(`Electron 运行平台不匹配：${process.platform} != ${expectedPlatform}`);
}
if (expectedArch && process.arch !== expectedArch) {
    throw new Error(`Electron 运行架构不匹配：${process.arch} != ${expectedArch}`);
}

let sqliteDriver = '';
try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.prepare('SELECT 1').get();
    db.close();
    sqliteDriver = 'node:sqlite';
} catch (_) {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('SELECT 1').get();
    db.close();
    sqliteDriver = 'better-sqlite3';
}

async function verifyBrowserRuntime() {
    const manifestPath = path.resolve(__dirname, '..', 'artifacts', 'agent-browser-pack', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
        throw new Error(`Chromium 运行包与构建目标不匹配：${manifest.platform}/${manifest.arch}`);
    }
    const executablePath = path.resolve(path.dirname(manifestPath), manifest.executable);
    if (!fs.existsSync(executablePath)) throw new Error(`Chromium 可执行文件不存在：${executablePath}`);
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        const page = await browser.newPage();
        await page.goto('data:text/html,<title>Pivot browser runtime</title>');
        if (await page.title() !== 'Pivot browser runtime') throw new Error('Chromium 页面启动自检失败。');
    } finally {
        await browser.close();
    }
    return executablePath;
}

async function main() {
    require('@duckdb/node-api');
    const sharp = require('sharp');
    if (!sharp?.versions?.vips) throw new Error('Sharp/libvips 未正确加载。');
    require('unzipper');
    const verifyBrowser = String(process.env.PIVOT_VERIFY_DESKTOP_BROWSER_RUNTIME || '').toLowerCase() === 'true';
    const chromium = verifyBrowser ? await verifyBrowserRuntime() : null;
    console.log(JSON.stringify({
        ok: true,
        platform: process.platform,
        arch: process.arch,
        sqlite: sqliteDriver,
        sharp: sharp.versions.sharp,
        vips: sharp.versions.vips,
        chromium,
        browserRuntimeVerified: verifyBrowser
    }));
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
