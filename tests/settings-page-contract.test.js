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
    const pivotCore = read('client/chat/pivot-core.js');

    assert.match(admin, /let settingsTabLoadSequence = 0/);
    assert.match(admin, /const SETTINGS_OPERATION_TIMEOUT_MS = 35000/);
    assert.match(admin, /function withSettingsTimeout/);
    assert.match(pivotCore, /const SCRIPT_LOAD_TIMEOUT_MS = 15000/);
    assert.match(pivotCore, /加载脚本超时/);
    assert.match(admin, /await loadTabData\(tab\)/);
    assert.match(admin, /settingsTabLoadSequence/);
    assert.match(admin, /ArrowDown.*ArrowRight/);
    assert.match(settings, /async function loadSettings\(\)/);
    assert.match(settings, /globalName: 'loadSettings'/);
    assert.match(settings, /const requestId = \+\+settingsLoadSequence/);
    assert.match(settings, /settings-state-retry/);
    assert.match(settings, /chat_auto_agent_enabled/);
    assert.match(settings, /关闭后用户不能选择聊天 Agent 执行模式/);
    assert.match(settings, /input.type === 'checkbox'/);
    assert.match(shell, /tab-content-global-params/);
    assert.match(shell, /role="tablist"/);
    assert.match(shell, /role="tab" aria-controls="tab-content-models"/);
    assert.match(shell, /id="settings-load-state"[^>]*role="status"/);
    assert.match(styles, /overflow-x: auto/);
    assert.match(styles, /\.admin-content\s*\{[^}]*position:\s*relative/);
    assert.match(styles, /\.settings-state\s*\{[^}]*position:\s*absolute/);
    assert.match(styles, /\.settings-state\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
    assert.match(styles, /\.settings-workspace-view\s+\.memories-tab\s+\.settings-page-head\s*\{[^}]*margin-bottom:\s*8px/);
    assert.match(styles, /\.settings-workspace-view\s+\.memories-table\s+td\s*\{[^}]*height:\s*28px/);
    assert.match(admin, /limit:\s*15/);
    assert.match(read('client/chat/config.js'), /CLIENT_REQUEST_TIMEOUT/);
    assert.match(read('server/services/host-classifier.js'), /PIVOT_DNS_LOOKUP_TIMEOUT_MS/);
});

test('设置 API 不把 app_settings 原始值直接交给浏览器', () => {
    const route = read('server/routes/settings.js');
    assert.match(route, /SENSITIVE_SETTING_KEY_RE/);
    assert.match(route, /settings: getPublicSettings\(\)/);
    assert.match(route, /redacted: true/);
});

test('工具策略卡片具备工具名称与简介全量中文化映射', () => {
    const toolPolicy = read('client/chat/tool-policy.js');
    assert.match(toolPolicy, /'data\.group_summary':\s*'分组汇总数据'/);
    assert.match(toolPolicy, /'format\.extract_json':\s*'提取 JSON'/);
    assert.match(toolPolicy, /'data\.filter_rows':\s*'筛选表格行'/);
    assert.match(toolPolicy, /function toolPolicyToolTitle/);
    assert.match(toolPolicy, /function toolPolicyToolDescription/);
});
