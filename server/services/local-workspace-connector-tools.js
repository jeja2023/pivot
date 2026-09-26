'use strict';

const WORKSPACE_TOOL_NAMES = Object.freeze([
    'workspace.inspect',
    'workspace.read',
    'workspace.search',
    'workspace.patch',
    'workspace.install',
    'workspace.test',
    'workspace.git_status',
    'workspace.git_diff',
    'workspace.git_worktree',
    'workspace.git_worktree_remove',
    'workspace.git_merge',
    'workspace.git_abort_merge',
    'workspace.git_commit',
    'workspace.git_push',
    'workspace.git_pr'
]);
const SAFE_BRANCH_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._/-]{0,119})$/;
const SAFE_REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_RELATIVE_PATH_RE = /^(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))(?!.*(?:^|[\\/])\.git(?:[\\/]|$))(?![\\/])(?!(?:[A-Za-z]:))[A-Za-z0-9._/ -]{1,240}$/;

function workspaceError(message, code = 'LOCAL_WORKSPACE_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.expose = true;
    return error;
}

function safeRelativePath(value, { allowRoot = false } = {}) {
    const path = String(value || '').trim().replace(/\\/g, '/');
    if (allowRoot && (!path || path === '.')) return '.';
    if (!SAFE_RELATIVE_PATH_RE.test(path)) throw workspaceError('工作区路径必须是当前授权仓库内的相对路径。', 'LOCAL_WORKSPACE_PATH_DENIED', 403);
    return path;
}

function safeBranch(value) {
    const branch = String(value || '').trim();
    if (!SAFE_BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('.') || branch.endsWith('/')) {
        throw workspaceError('Git 分支名称不合法。', 'LOCAL_WORKSPACE_BRANCH_INVALID');
    }
    return branch;
}

function safeWorktreeName(value) {
    const name = String(value || '').trim();
    if (!SAFE_WORKTREE_NAME_RE.test(name) || name === '.' || name === '..') {
        throw workspaceError('Git 工作树名称不合法。', 'LOCAL_WORKSPACE_WORKTREE_NAME_INVALID');
    }
    return name;
}

function normalizeWorkspaceGrant(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const provider = String(source.provider || 'desktop').slice(0, 40);
    return {
        label: String(source.label || '').replace(/[\r\n]/g, ' ').slice(0, 160),
        pathHint: String(source.pathHint || '').replace(/[\r\n]/g, ' ').slice(0, 180),
        provider,
        deviceName: String(source.deviceName || '').slice(0, 120),
        gitProvider: ['github_cli', 'none'].includes(String(source.gitProvider || source.git_provider || 'none'))
            ? String(source.gitProvider || source.git_provider || 'none') : 'none'
    };
}

function normalizeWorkspaceTask(toolName, input = {}, grant = {}) {
    const name = String(toolName || '').trim();
    if (!WORKSPACE_TOOL_NAMES.includes(name)) throw workspaceError('不支持的本机代码工作区工具。', 'LOCAL_WORKSPACE_TOOL_INVALID');
    const task = { action: name, path: safeRelativePath(input.path || input.filePath || input.file_path || '.', { allowRoot: true }) };
    if (input.worktreeName || input.worktree_name) task.worktreeName = safeWorktreeName(input.worktreeName || input.worktree_name);
    if (name === 'workspace.read') task.maxBytes = Math.min(Math.max(Number.parseInt(input.maxBytes || input.max_bytes, 10) || 262144, 1), 524288);
    if (name === 'workspace.search') {
        const query = String(input.query || '').trim();
        if (!query || query.length > 500) throw workspaceError('代码搜索需要 1 至 500 个字符的查询词。', 'LOCAL_WORKSPACE_QUERY_REQUIRED');
        task.query = query;
        task.limit = Math.min(Math.max(Number.parseInt(input.limit, 10) || 50, 1), 200);
    }
    if (name === 'workspace.patch') {
        const changes = Array.isArray(input.changes) ? input.changes.slice(0, 32) : [];
        if (!changes.length) throw workspaceError('代码修改需要至少一个文件变更。', 'LOCAL_WORKSPACE_CHANGES_REQUIRED');
        task.changes = changes.map(change => {
            const content = String(change?.content ?? '');
            if (Buffer.byteLength(content, 'utf8') > 512 * 1024) throw workspaceError('单个文件修改不能超过 512KB。', 'LOCAL_WORKSPACE_FILE_TOO_LARGE', 413);
            return {
                path: safeRelativePath(change?.path),
                content,
                expectedDigest: String(change?.expectedDigest || change?.expected_digest || '').trim().slice(0, 128)
            };
        });
    }
    if (name === 'workspace.install') {
        const command = String(input.command || '').trim();
        if (!['npm_ci', 'npm_install', 'pip_requirements'].includes(command)) {
            throw workspaceError('依赖安装命令必须是 npm_ci、npm_install 或 pip_requirements。', 'LOCAL_WORKSPACE_INSTALL_COMMAND_DENIED', 403);
        }
        task.command = command;
    }
    if (name === 'workspace.test') {
        const command = String(input.command || '').trim();
        if (!command || !['npm_test', 'npm_run', 'node_test', 'python_pytest'].includes(command)) {
            throw workspaceError('测试命令必须是已登记的 npm_test、npm_run、node_test 或 python_pytest。', 'LOCAL_WORKSPACE_TEST_COMMAND_DENIED', 403);
        }
        task.command = command;
        task.args = Array.isArray(input.args) ? input.args.slice(0, 12).map(value => String(value || '').slice(0, 240)) : [];
    }
    if (name === 'workspace.git_diff') task.base = input.base ? safeBranch(input.base) : '';
    if (name === 'workspace.git_worktree') {
        task.branch = safeBranch(input.branch);
        task.name = safeWorktreeName(input.name || task.branch.replace(/[^A-Za-z0-9._-]/g, '-'));
        delete task.worktreeName;
    }
    if (name === 'workspace.git_worktree_remove') {
        if (!input.name) throw workspaceError('移除 Git 工作树需要名称。', 'LOCAL_WORKSPACE_WORKTREE_NAME_REQUIRED');
        task.name = safeWorktreeName(input.name);
        delete task.worktreeName;
    }
    if (name === 'workspace.git_merge') task.branch = safeBranch(input.branch);
    if (name === 'workspace.git_commit') {
        task.message = String(input.message || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 240);
        if (!task.message) throw workspaceError('提交需要明确的 commit message。', 'LOCAL_WORKSPACE_COMMIT_MESSAGE_REQUIRED');
        const paths = Array.isArray(input.paths) ? input.paths.slice(0, 32).map(path => safeRelativePath(path)) : [];
        if (!paths.length) throw workspaceError('提交必须明确列出本次要提交的工作区文件。', 'LOCAL_WORKSPACE_COMMIT_PATHS_REQUIRED');
        task.paths = [...new Set(paths)];
    }
    if (name === 'workspace.git_push') {
        task.remote = String(input.remote || 'origin').trim();
        if (!SAFE_REMOTE_RE.test(task.remote)) throw workspaceError('Git 远程名称不合法。', 'LOCAL_WORKSPACE_REMOTE_INVALID');
    }
    if (name === 'workspace.git_pr') {
        if (normalizeWorkspaceGrant(grant).gitProvider !== 'github_cli') throw workspaceError('当前工作区未授权 GitHub CLI Pull Request 交付。', 'LOCAL_WORKSPACE_PR_NOT_AUTHORIZED', 403);
        task.title = String(input.title || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 240);
        task.body = String(input.body || '').trim().slice(0, 12000);
        task.base = safeBranch(input.base || 'main');
        if (!task.title) throw workspaceError('创建 Pull Request 需要标题。', 'LOCAL_WORKSPACE_PR_TITLE_REQUIRED');
    }
    return task;
}

function localWorkspaceToolDefinitions() {
    const worktreeName = { worktreeName: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' } };
    return [
        ['workspace.inspect', '查看代码工作区', '读取已授权 Git 仓库或 Pivot 创建工作树的分支、状态和摘要。', { type: 'object', properties: worktreeName }],
        ['workspace.read', '读取代码文件', '读取当前授权工作区中的指定文本文件。', { type: 'object', properties: { path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: 524288 }, ...worktreeName } }],
        ['workspace.search', '搜索代码', '在当前授权工作区内搜索文件名和文本，不执行代码。', { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 }, ...worktreeName }, required: ['query'] }],
        ['workspace.patch', '修改代码', '按带摘要校验的完整文件内容修改授权工作区；桌面端每次会要求确认。', { type: 'object', properties: { changes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object' } }, ...worktreeName }, required: ['changes'] }],
        ['workspace.install', '安装隔离依赖', '仅在认证隔离 Worker 中安装当前授权工作区声明的依赖；不会在桌面主机直接运行包管理器。', { type: 'object', properties: { command: { type: 'string', enum: ['npm_ci', 'npm_install', 'pip_requirements'] }, ...worktreeName }, required: ['command'] }],
        ['workspace.test', '运行受控测试', '在强制隔离 Worker 中运行已登记的测试命令；未配置 Worker 时拒绝执行。', { type: 'object', properties: { command: { type: 'string', enum: ['npm_test', 'npm_run', 'node_test', 'python_pytest'] }, args: { type: 'array', items: { type: 'string' } }, ...worktreeName }, required: ['command'] }],
        ['workspace.git_status', '查看 Git 状态', '查看分支、改动和未跟踪文件。', { type: 'object', properties: worktreeName }],
        ['workspace.git_diff', '查看 Git 差异', '读取当前分支或指定基线的差异。', { type: 'object', properties: { base: { type: 'string' }, ...worktreeName } }],
        ['workspace.git_worktree', '创建隔离 Git 工作树', '在授权仓库内创建分支绑定的隔离工作树。', { type: 'object', properties: { branch: { type: 'string' }, name: { type: 'string' } }, required: ['branch'] }],
        ['workspace.git_worktree_remove', '移除隔离 Git 工作树', '移除 Pivot 创建的隔离 Git 工作树；不会删除主工作区。', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }],
        ['workspace.git_merge', '合并 Git 分支', '将指定分支合并到当前工作区；发生冲突时只报告冲突文件，不自动覆盖。', { type: 'object', properties: { branch: { type: 'string' }, ...worktreeName }, required: ['branch'] }],
        ['workspace.git_abort_merge', '中止 Git 合并', '中止当前尚未提交的 Git 合并，恢复合并前工作区状态。', { type: 'object', properties: worktreeName }],
        ['workspace.git_commit', '提交 Git 变更', '仅提交明确列出的已审核工作区文件；桌面端会要求确认。', { type: 'object', properties: { message: { type: 'string' }, paths: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } }, ...worktreeName }, required: ['message', 'paths'] }],
        ['workspace.git_push', '推送 Git 分支', '将当前分支推送到已配置远程；桌面端会要求确认。', { type: 'object', properties: { remote: { type: 'string' }, ...worktreeName } }],
        ['workspace.git_pr', '创建 GitHub Pull Request', '通过已授权的 GitHub CLI 创建 Pull Request；桌面端会要求确认。', { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, base: { type: 'string' }, ...worktreeName }, required: ['title'] }]
    ].map(([name, title, description, inputSchema]) => ({ name, title, description, inputSchema }));
}

function isLocalWorkspaceConnectorTool(name) { return WORKSPACE_TOOL_NAMES.includes(String(name || '').trim()); }

module.exports = { isLocalWorkspaceConnectorTool, localWorkspaceToolDefinitions, normalizeWorkspaceGrant, normalizeWorkspaceTask, safeRelativePath, workspaceError };
