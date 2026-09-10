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
    assert.match(settings, /settingsLoadController\?\.abort\(\)/);
    assert.match(settings, /globalName: 'cancelSettingsLoad'/);
    assert.match(settings, /timeoutMs: 30000/);
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
    assert.match(styles, /\.settings-page-head\s*\{[^}]*margin-bottom:\s*14px/);
    assert.match(styles, /\.settings-workspace-view\s+\.memories-table\s+td\s*\{[^}]*height:\s*28px/);
    assert.match(admin, /limit:\s*15/);
    assert.match(read('client/chat/config.js'), /CLIENT_REQUEST_TIMEOUT/);
    assert.match(read('server/services/host-classifier.js'), /PIVOT_DNS_LOOKUP_TIMEOUT_MS/);
    const monitor = read('client/chat/stats-monitor.js');
    const statsRoute = read('server/routes/admin-stats.js');
    assert.match(monitor, /opsSummaryLoadPromise/);
    assert.match(monitor, /monitorSummaryLoadPromise/);
    assert.doesNotMatch(monitor, /const \[summaryRes, trendRes, monitorRes\]/);
    assert.match(statsRoute, /monitorSummaryInFlight/);
    assert.match(statsRoute, /opsSummaryInFlight/);
    assert.match(statsRoute, /trendInFlight/);
    assert.match(statsRoute, /tokenUsageAggregateSubquery/);
    assert.match(statsRoute, /modelEndpoints/);
    assert.match(statsRoute, /getCachedDatabaseSize\(\)/);
    assert.match(read('server/services/admin-stats-cache.js'), /DATABASE_SIZE_TTL_MS/);
});
test('系统监控固定在设置画布内，只有慢查询与异常告警列表允许内部滚动', () => {
    const monitorCss = read('client/chat/styles/stats-monitor/stats-system-monitor.css');
    const scale = read('client/chat/workspace-settings-scale.js');
    const monitor = read('client/chat/stats-monitor.js');

    assert.match(monitorCss, /\.admin-content\.is-monitor-tab-active\s*\{[^}]*overflow:\s*hidden !important/);
    assert.match(monitorCss, /\.monitor-panel-observability \.monitor-list\s*\{[^}]*overflow-y:\s*auto/);
    assert.doesNotMatch(monitorCss, /\.monitor-panel-gpu \.monitor-list,\s*\.settings-workspace-view #tab-content-monitor \.monitor-panel-observability/);
    assert.match(monitorCss, /grid-template-rows:\s*minmax\(250px, 1fr\) minmax\(0, 1fr\)/);
    assert.match(scale, /const MONITOR_MIN_CANVAS_HEIGHT = 780/);
    assert.match(scale, /availableHeight \/ MONITOR_MIN_CANVAS_HEIGHT/);
    assert.match(monitor, /const visibleModels = models\.slice\(0, 6\)/);
    assert.match(monitor, /const healthChecks = allHealthChecks\.slice\(0, 8\)/);
    assert.match(monitor, /const displayTime = match \? `\$\{match\[2\]\} \$\{match\[3\]\}` : fullStr/);
    assert.doesNotMatch(monitor, /const isToday = fullStr\.startsWith/);
});

test('后台调度轮询具备防重入保护', () => {
    const schedules = read('server/services/agent-schedules.js');
    assert.match(schedules, /let running = false/);
    assert.match(schedules, /if \(running\) return/);
    assert.match(schedules, /Promise\.allSettled/);
});

test('设置 API 不把 app_settings 原始值直接交给浏览器', () => {
    const route = read('server/routes/settings.js');
    assert.match(route, /SENSITIVE_SETTING_KEY_RE/);
    assert.match(route, /private\|signing\|keyring/);
    assert.match(route, /settings: getPublicSettings\(\)/);
    assert.match(route, /redacted: true/);
    assert.match(route, /\/settings\/skill-signing/);
    assert.match(route, /isSuperAdmin\(req\.user\)/);
    const signingConfig = read('server/services/agent-skill-signing-configuration.js');
    assert.match(signingConfig, /encryptSecret\(serializeKeyring/);
    assert.match(signingConfig, /getOrganizationSigningPublicKey/);
    assert.doesNotMatch(signingConfig, /res\.json\([^\n]*privateKey/);
});

test('审计日志读取不会等待整个异步写入队列', () => {
    const route = read('server/routes/admin-users.js');
    assert.doesNotMatch(route, /const \{ flushAllWrites \} = require\('\.\.\/services\/db-write-queue'\)/);
    assert.doesNotMatch(route, /await flushAllWrites\(\)/);
});

test('工具策略卡片具备工具名称与简介全量中文化映射', () => {
    const toolPolicy = read('client/chat/tool-policy.js');
    assert.match(toolPolicy, /'data\.group_summary':\s*'分组汇总数据'/);
    assert.match(toolPolicy, /'format\.extract_json':\s*'提取 JSON'/);
    assert.match(toolPolicy, /'data\.filter_rows':\s*'筛选表格行'/);
    assert.match(toolPolicy, /function toolPolicyToolTitle/);
    assert.match(toolPolicy, /function toolPolicyToolDescription/);
});

test('长期记忆表格移除独立来源列并将来源按钮移入操作列，来源弹窗关闭按钮靠右', () => {
    const html = read('client/chat/partials/settings/memories.html');
    const js = read('client/chat/admin-settings-memory.js');
    const css = read('client/chat/styles/admin/admin-layout.css');

    assert.doesNotMatch(html, /<th[^>]*>来源<\/th>/);
    assert.doesNotMatch(html, /<col class="memory-col-source">/);
    assert.match(js, /const colspan = 8/);
    assert.match(js, /<div class="memory-action-buttons">[\s\S]*?data-memory-action="source"[\s\S]*?data-memory-action="edit"/);
    assert.match(css, /\.memory-modal-header[\s\S]*?display:\s*flex;/);
    assert.match(css, /\.memory-source-close[\s\S]*?margin-left:\s*auto;/);
});

test('分页控件统一使用直接绑定的工作区组件，避免依赖全局点击委托', () => {
    const ui = read('client/chat/ui.js');
    const settings = read('client/chat/admin-settings-memory.js');
    const toolPolicy = read('client/chat/tool-policy.js');

    assert.match(ui, /function renderWorkspacePagination/);
    assert.match(ui, /button\.addEventListener\('click'/);
    assert.match(ui, /dataset\.workspacePaginationPage/);
    assert.match(ui, /Math\.min\(Math\.max/);
    assert.match(settings, /renderWorkspacePagination\?\.\(container/);
    assert.match(toolPolicy, /renderWorkspacePagination\?\.\(container/);
    assert.doesNotMatch(settings, /data-pagination-tab|data-pagination-page/);
    assert.doesNotMatch(toolPolicy, /data-pagination-tab|data-pagination-page/);
});

test('工具策略设置项与面板对齐为仅系统管理员专享契约', () => {
    const shell = read('client/chat/partials/settings/shell-start.html');
    const toolPolicyHtml = read('client/chat/partials/settings/tool-policy.html');
    const admin = read('client/chat/admin.js');
    const toolPolicyJs = read('client/chat/tool-policy.js');
    const mcpWorkbench = read('client/chat/mcp-workbench-main.js');

    const tabMatch = shell.match(/<button id="tab-tool-policy"[^>]*class="([^"]+)"/);
    assert.ok(tabMatch);
    const tabClasses = tabMatch[1].split(/\s+/);
    assert.ok(tabClasses.includes('super-admin-only'));
    assert.ok(!tabClasses.includes('admin-only'));

    const contentMatch = toolPolicyHtml.match(/<section id="tab-content-tool-policy"[^>]*class="([^"]+)"/);
    assert.ok(contentMatch);
    const contentClasses = contentMatch[1].split(/\s+/);
    assert.ok(contentClasses.includes('super-admin-only'));
    assert.ok(!contentClasses.includes('admin-only'));

    assert.match(admin, /const SUPER_ADMIN_ONLY_SETTINGS_TABS = new Set\(\['tool-policy'\]\)/);
    assert.match(admin, /SUPER_ADMIN_ONLY_SETTINGS_TABS\.has\(target\) && !isSuperAdminUser\(\)/);
    assert.match(toolPolicyJs, /if \(!isSuperAdminUser\(\)\) return;/);
    assert.match(mcpWorkbench, /isSuperAdminUser\(\) \? '<button[^>]*data-mcp-open-tool-policy/);
});

test('API 接入与全局权限选择器严格隔离，杜绝跨面板解冻非活跃 Tab', () => {
    const authJs = read('client/chat/auth.js');
    const adminJs = read('client/chat/admin.js');

    // loadApiKeys 必须作用于 #tab-content-keys 容器内，不能全局选择 .super-admin-only
    assert.match(authJs, /const\s+keysTab\s*=\s*document\.getElementById\(['"]tab-content-keys['"]\)/);
    assert.match(authJs, /keysTab\?\.querySelectorAll\(['"]\.super-admin-only['"]\)/);
    assert.doesNotMatch(authJs, /document\.querySelectorAll\s*\(\s*['"]\.super-admin-only['"]\s*\)/);

    // openAdmin 的 admin-only 与 super-admin-only 必须排除 .admin-tab-content 面板
    assert.match(adminJs, /\.admin-only:not\(\.admin-tab-content\)/);
    assert.match(adminJs, /\.super-admin-only:not\(\.admin-tab-content\)/);
});
