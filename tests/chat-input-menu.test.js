const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeAttachmentRelativePath } = require('../server/routes/attachments');
const { filterChatMcpToolsByAllowlist } = require('../server/services/chat-context-assembler');
const { buildChatRequestState } = require('../server/services/chat-preflight');

test('文件夹附件路径保留安全目录层级并移除路径穿越段', () => {
    assert.equal(
        normalizeAttachmentRelativePath('项目资料/合同/正文.pdf', '正文.pdf'),
        '项目资料/合同/正文.pdf'
    );
    assert.equal(
        normalizeAttachmentRelativePath('../../机密/正文.pdf', '正文.pdf'),
        '机密/正文.pdf'
    );
    assert.equal(
        normalizeAttachmentRelativePath('单文件.pdf', '单文件.pdf'),
        '单文件.pdf'
    );
});

test('聊天工具白名单只匹配权限过滤后的完整工具 ID', () => {
    const tools = [
        { fullName: 'mcp.12.db.list_tables', name: 'db.list_tables' },
        { fullName: 'mcp.23.db.list_tables', name: 'db.list_tables' },
        { fullName: 'mcp.12.db.run_readonly_query', name: 'db.run_readonly_query' }
    ];
    assert.deepEqual(
        filterChatMcpToolsByAllowlist(tools, ['mcp.12.db.list_tables']),
        [tools[0]]
    );
    assert.deepEqual(filterChatMcpToolsByAllowlist(tools, ['db.list_tables']), []);
    assert.equal(filterChatMcpToolsByAllowlist(tools, null), tools);
});

test('聊天请求工具白名单会去重、清理空值并限制数量', () => {
    const allowlist = Array.from({ length: 310 }, (_, index) => 'mcp.1.tool_' + index);
    allowlist.unshift('', ' mcp.1.keep ', 'mcp.1.keep');
    const state = buildChatRequestState({
        body: {
            content: '测试工具筛选',
            mcpEnabled: true,
            mcpConfirmed: true,
            mcpToolAllowlist: allowlist
        },
        user: { id: 7 }
    });
    assert.equal(state.mcpEnabled, true);
    assert.equal(state.mcpToolAllowlist[0], 'mcp.1.keep');
    assert.equal(state.mcpToolAllowlist.length, 300);
});

test('工具授权续跑指定原始消息，并继续使用经过清理的路由覆盖', () => {
    const state = buildChatRequestState({
        body: {
            content: '',
            regenerate: true,
            regenerateMessageId: '42',
            routeOverrides: { tools: ['mcp.7.db.run_readonly_query', 'invalid.tool'] }
        },
        user: { id: 7 }
    });
    assert.equal(state.regenerate, true);
    assert.equal(state.regenerateMessageId, 42);
    assert.deepEqual(state.routeOverrides.tools, ['mcp.7.db.run_readonly_query']);
});

test('聊天输入框默认使用智能自适应，并将资料和工具控制收敛到 @ 与授权流程', () => {
    const shell = fs.readFileSync(path.resolve(__dirname, '../client/chat/partials/workspaces/chat-shell.html'), 'utf8');
    const workspace = fs.readFileSync(path.resolve(__dirname, '../client/chat/app-workspaces.js'), 'utf8');
    const autoRoute = fs.readFileSync(path.resolve(__dirname, '../client/chat/chat-auto-route.js'), 'utf8');
    const main = fs.readFileSync(path.resolve(__dirname, '../client/chat/app/main.js'), 'utf8');

    assert.match(shell, /placeholder="输入消息… 需要指定资料或工具时可输入 @"/);
    assert.match(shell, /id="chat-route-mention-menu"/);
    assert.match(shell, /id="chat-route-override-state" hidden/);
    assert.match(shell, /id="upload-file-choice"/);
    assert.match(shell, /id="upload-folder-choice"/);
    assert.doesNotMatch(shell, /id="chat-auto-route-enabled"/);
    assert.doesNotMatch(shell, /id="chat-rag-enabled"/);
    assert.doesNotMatch(shell, /id="chat-mcp-enabled"/);
    assert.doesNotMatch(shell, /id="chat-rag-subpanel"/);
    assert.doesNotMatch(shell, /id="chat-mcp-subpanel"/);
    assert.match(autoRoute, /const getAutoRouteEnabled = \(\) => true/);
    assert.match(autoRoute, /const enableMcpFromRouteTrace = async/);
    assert.doesNotMatch(autoRoute, /请重新发送这条消息/);
    assert.match(autoRoute, /MENTION_PAGE_SIZE = 6/);
    assert.match(autoRoute, /chat-route-mention-scope/);
    assert.match(autoRoute, /chat-route-mention-result-summary/);
    assert.match(autoRoute, /chat-route-mention-pager/);
    assert.match(autoRoute, /已显示 \$\{start \+ 1\}–\$\{start \+ candidates\.length\} \/ \$\{total\}/);
    assert.match(autoRoute, /mentionScope !== 'tool'/);
    assert.match(autoRoute, /allowlist\.has\(item\.fullName\)/);
    assert.doesNotMatch(autoRoute, /pivot_chat_auto_route_enabled/);
    assert.match(main, /function canSelectChatAttachment\(\)/);
    assert.equal(workspace.includes("if (getChatMcpToolMode() === 'auto') return null;"), true);
    assert.match(workspace, /window\.Pivot\.exposeModule\('chat\.inputMenu'/);
});

test('聊天输入框支持拖放和粘贴文件并复用附件队列', () => {
    const shell = fs.readFileSync(path.resolve(__dirname, '../client/chat/partials/workspaces/chat-shell.html'), 'utf8');
    const attachments = fs.readFileSync(path.resolve(__dirname, '../client/chat/engine-attachments.js'), 'utf8');

    assert.doesNotMatch(shell, /可将文件拖入输入框或直接粘贴文件/);
    assert.equal(attachments.includes("chatInputWrapper?.addEventListener('drop'"), true);
    assert.equal(attachments.includes("getElementById('user-input')?.addEventListener('paste'"), true);
    assert.equal(attachments.includes('await queueChatAttachmentFiles(files'), true);
    assert.match(attachments, /collectDroppedEntryFiles/);
});

test('聊天 Agent 详情会懒加载任务模块并展示安全的执行判断摘要', () => {
    const engine = fs.readFileSync(path.resolve(__dirname, '../client/chat/engine.js'), 'utf8');
    const sessions = fs.readFileSync(path.resolve(__dirname, '../client/chat/engine-sessions.js'), 'utf8');
    const styles = fs.readFileSync(path.resolve(__dirname, '../client/chat/styles/base/chat-shell.css'), 'utf8');
    assert.match(engine, /async function openChatAgentRunDetail\(runId\)/);
    assert.match(engine, /await window\.Pivot\.legacy\.ensureWorkspaceScripts\('agent'\)/);
    assert.match(engine, /addButton\('详情',[\s\S]*openChatAgentRunDetail\(runId\)/);
    assert.match(engine, /当前判断：\$\{thought\.slice\(0, 120\)\}/);
    assert.match(sessions, /window\.Pivot\.legacy\.chatAgentProgressText\?\.\(detail, status\)/);
    assert.match(styles, /\.chat-agent-controls button\s*\{[\s\S]*height:\s*26px;[\s\S]*font-size:\s*0\.7rem;/);
});
