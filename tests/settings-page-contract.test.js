const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('设置页具备加载失败恢复、请求竞态和键盘导航契约', () => {
    const admin = read('client/chat/admin.js');
    const settings = read('client/chat/admin-settings.js');
    const shell = read('client/chat/partials/settings/shell-start.html');
    const styles = read('client/chat/styles/admin/admin-layout.css');

    assert.match(admin, /let settingsTabLoadSequence = 0/);
    assert.match(admin, /await loadTabData\(tab\)/);
    assert.match(admin, /settingsTabLoadSequence/);
    assert.match(admin, /ArrowDown.*ArrowRight/);
    assert.match(settings, /async function loadSettings\(\)/);
    assert.match(settings, /globalName: 'loadSettings'/);
    assert.match(settings, /const requestId = \+\+settingsLoadSequence/);
    assert.match(settings, /settings-state-retry/);
    assert.match(shell, /role="tablist"/);
    assert.match(shell, /role="tab" aria-controls="tab-content-models"/);
    assert.match(shell, /id="settings-load-state"[^>]*role="status"/);
    assert.match(styles, /overflow-x: auto/);
    assert.match(styles, /\.settings-state/);
});

test('设置 API 不把 app_settings 原始值直接交给浏览器', () => {
    const route = read('server/routes/settings.js');
    assert.match(route, /SENSITIVE_SETTING_KEY_RE/);
    assert.match(route, /settings: getPublicSettings\(\)/);
    assert.match(route, /redacted: true/);
});
