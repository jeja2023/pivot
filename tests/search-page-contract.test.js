const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('全局搜索弹窗具备稳定的请求竞态、错误恢复与无障碍契约', () => {
    const search = read('client/chat/sidebar-search.js');
    const shell = read('client/chat/partials/workspaces/chat-shell.html');
    const sidebar = read('client/chat/sidebar.js');
    const styles = read('client/chat/styles/sessions-prompts.css');

    assert.match(search, /const requestId = \+\+globalSearchRequestId/);
    assert.match(search, /requestId !== globalSearchRequestId \|\| globalSearchType !== 'sessions'/);
    assert.match(search, /if \(!res\.ok\) throw new Error/);
    assert.match(search, /data-global-search-retry/);
    assert.match(search, /agents\/workflows\?\$\{params\.toString\(\)\}/);
    assert.match(shell, /aria-modal="true" aria-labelledby="session-search-title"/);
    assert.match(shell, /id="session-search-modal-clear"/);
    assert.match(shell, /role="status" aria-live="polite"/);
    assert.match(sidebar, /session-search-modal-clear/);
    assert.match(sidebar, /event\.key === 'Enter'/);
    assert.match(styles, /\.session-search-retry/);
    assert.match(styles, /\.session-search-clear/);
});

test('工作流搜索接口支持服务端关键词过滤并返回计数', () => {
    const route = read('server/routes/agents.js');
    const service = read('server/services/agent-workflows.js');

    assert.match(route, /listAgentWorkflows\(req\.user, \{ query: req\.query\.query \}\)/);
    assert.match(route, /res\.json\(\{ data, total: data\.length \}\)/);
    assert.match(service, /const searchText = String\(options\.query \|\| ''\)\.trim\(\)\.toLowerCase\(\)/);
    assert.match(service, /\.includes\(searchText\)/);
    assert.match(read('server/repositories/agent-workflows.js'), /searchPattern = searchText\.replace/);
});

test('对话视图搜索弹窗隐藏任务与工作流，仅个人工作台作为全局搜索展示全量选项卡', () => {
    const search = read('client/chat/sidebar-search.js');
    const styles = read('client/chat/styles/sessions-prompts.css');
    const sidebar = read('client/chat/sidebar.js');
    const personal = read('client/chat/personal-workbench.js');

    assert.match(search, /globalSearchScope/);
    assert.match(search, /search-scope-sessions/);
    assert.match(search, /search-scope-global/);
    assert.match(styles, /\.session-search-modal\.search-scope-sessions \.global-search-types/);
    assert.match(sidebar, /scope:\s*isPersonal \? 'global' : 'sessions'/);
    assert.match(personal, /scope:\s*'global'/);
});
