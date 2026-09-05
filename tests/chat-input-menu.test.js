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

test('聊天工具面板默认由模型自动选择并把知识库状态放进二级面板', () => {
    const shell = fs.readFileSync(path.resolve(__dirname, '../client/chat/partials/workspaces/chat-shell.html'), 'utf8');
    const workspace = fs.readFileSync(path.resolve(__dirname, '../client/chat/app-workspaces.js'), 'utf8');

    assert.match(shell, /id="chat-mcp-mode-auto"[^>]+value="auto" checked/);
    assert.match(shell, /模型自动选择/);
    assert.doesNotMatch(shell, /id="chat-mcp-all-tools"[^>]+checked/);
    assert.match(shell, /id="chat-rag-subpanel"[\s\S]*id="chat-rag-readiness"/);
    assert.match(shell, /id="chat-mcp-tool-summary"[^>]+aria-live="polite"/);
    assert.equal(workspace.includes("if (getChatMcpToolMode() === 'auto') return null;"), true);
    assert.match(workspace, /已选择 \${allowlist\.length} \/ \${total} 个工具/);
    assert.match(workspace, /visibleItems = items\.filter\(item => !\['rag', 'mcp'\]\.includes\(item\.tool\)\)/);
    assert.match(workspace, /function positionChatToolSubpanel\(target\)/);
    assert.match(workspace, /viewportHeight - viewportMargin - panelRect\.height/);
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
