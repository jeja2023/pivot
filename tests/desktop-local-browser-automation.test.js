const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { profileDirectory, resolveGrantedBrowser } = require('../desktop/local-browser-automation');

test('桌面本机浏览器仅解析已授权可执行文件并将 Profile 限制在专属根目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-local-browser-'));
    const executable = path.join(root, process.platform === 'win32' ? 'msedge.exe' : 'firefox');
    fs.writeFileSync(executable, 'fixture');
    try {
        const browser = resolveGrantedBrowser({
            browsers: [{ id: 'firefox-test', label: 'Firefox', engine: 'firefox', executablePath: executable }]
        }, 'firefox-test');
        assert.equal(browser.executablePath, path.resolve(executable));
        const profile = profileDirectory(path.join(root, 'profiles'), browser.id);
        assert.equal(profile.startsWith(path.join(root, 'profiles')), true);
        assert.equal(fs.existsSync(profile), true);
        assert.throws(
            () => resolveGrantedBrowser({ browsers: [] }, 'firefox-test'),
            error => error.code === 'LOCAL_BROWSER_NOT_AUTHORIZED'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
