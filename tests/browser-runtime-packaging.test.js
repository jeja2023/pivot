const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pruneChromiumRuntime } = require('../scripts/package_browser_runtime');

test('Chromium runtime pack removes installer helpers and keeps configured locales', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-browser-pack-'));
    try {
        const locales = path.join(root, 'locales');
        fs.mkdirSync(locales, { recursive: true });
        ['chrome.exe', 'setup.exe', 'elevation_service.exe', 'chrome_proxy.exe', 'notification_helper.exe', 'dxcompiler.dll', 'dxil.dll'].forEach(name => fs.writeFileSync(path.join(root, name), 'x'));
        ['en-US.pak', 'zh-CN.pak', 'fr.pak'].forEach(name => fs.writeFileSync(path.join(locales, name), 'x'));
        pruneChromiumRuntime(root, { platform: 'win32', locales: new Set(['en-US', 'zh-CN']) });
        assert.equal(fs.existsSync(path.join(root, 'chrome.exe')), true);
        assert.equal(fs.existsSync(path.join(root, 'setup.exe')), false);
        assert.equal(fs.existsSync(path.join(root, 'elevation_service.exe')), false);
        assert.equal(fs.existsSync(path.join(root, 'chrome_proxy.exe')), false);
        assert.equal(fs.existsSync(path.join(root, 'dxcompiler.dll')), false);
        assert.equal(fs.existsSync(path.join(root, 'dxil.dll')), false);
        assert.equal(fs.existsSync(path.join(locales, 'en-US.pak')), true);
        assert.equal(fs.existsSync(path.join(locales, 'zh-CN.pak')), true);
        assert.equal(fs.existsSync(path.join(locales, 'fr.pak')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
