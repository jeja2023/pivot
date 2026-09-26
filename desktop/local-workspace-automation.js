'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
    isLocalWorkspaceConnectorTool,
    normalizeWorkspaceGrant,
    normalizeWorkspaceTask,
    workspaceError
} = require('../server/services/local-workspace-connector-tools');
const { runCapabilityWorker } = require('../server/services/agent-capability-worker');

const MAX_READ_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SAFE_TEXT_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.html', '.java', '.js', '.json', '.jsx', '.md', '.mjs', '.php', '.py', '.rb', '.rs', '.sh', '.sql', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml']);

function workspaceAutomationError(message, code = 'LOCAL_WORKSPACE_EXECUTION_FAILED', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function nativeRealpath(target) {
    return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(target) : fs.realpathSync(target);
}

function isPathWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertPathWithinWorkspace(root, target) {
    if (!isPathWithin(root, target)) {
        throw workspaceAutomationError('工作区路径越界。', 'LOCAL_WORKSPACE_PATH_DENIED', 403);
    }
    return target;
}

function resolveWorkspace(grant = {}) {
    const root = String(grant.path || '').trim();
    if (!root) throw workspaceAutomationError('当前设备没有授权本机代码工作区。', 'LOCAL_WORKSPACE_GRANT_REQUIRED', 403);
    const requested = path.resolve(root);
    let stat;
    try { stat = fs.statSync(requested); } catch (_) { throw workspaceAutomationError('授权的代码工作区不存在或不可访问。', 'LOCAL_WORKSPACE_ROOT_UNAVAILABLE', 404); }
    if (!stat.isDirectory()) throw workspaceAutomationError('代码工作区授权必须指向目录。', 'LOCAL_WORKSPACE_ROOT_INVALID');
    let resolved;
    try { resolved = nativeRealpath(requested); } catch (_) { throw workspaceAutomationError('授权的代码工作区无法解析物理路径。', 'LOCAL_WORKSPACE_ROOT_UNAVAILABLE', 404); }
    const git = path.join(resolved, '.git');
    if (!fs.existsSync(git)) throw workspaceAutomationError('授权目录不是 Git 工作区。', 'LOCAL_WORKSPACE_NOT_GIT_REPOSITORY', 409);
    return resolved;
}

function resolvePath(root, relative = '.', { forWrite = false } = {}) {
    const target = path.resolve(root, relative);
    assertPathWithinWorkspace(root, target);

    if (!forWrite) {
        let resolved;
        try { resolved = nativeRealpath(target); } catch (_) { throw workspaceAutomationError('工作区中没有指定文件或目录。', 'LOCAL_WORKSPACE_FILE_NOT_FOUND', 404); }
        return assertPathWithinWorkspace(root, resolved);
    }

    // 先解析最近的已存在父目录，拒绝越出授权物理工作区的符号链接或 Windows 目录联接。
    let existing = target;
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) throw workspaceAutomationError('工作区路径无法解析。', 'LOCAL_WORKSPACE_PATH_DENIED', 403);
        existing = parent;
    }
    let resolvedExisting;
    try { resolvedExisting = nativeRealpath(existing); } catch (_) { throw workspaceAutomationError('工作区路径无法解析。', 'LOCAL_WORKSPACE_PATH_DENIED', 403); }
    assertPathWithinWorkspace(root, resolvedExisting);
    return path.join(resolvedExisting, path.relative(existing, target));
}

function ensureTextFile(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (!SAFE_TEXT_EXTENSIONS.has(extension)) throw workspaceAutomationError('当前工作区仅允许读取或修改受支持的文本代码文件。', 'LOCAL_WORKSPACE_FILE_TYPE_DENIED', 403);
}

function runProcess(command, args, { cwd, timeoutMs = 30000, env = process.env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [], stderr = [];
        let outputBytes = 0;
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve(result);
        };
        const append = (list, chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            outputBytes += buffer.length;
            if (outputBytes > MAX_OUTPUT_BYTES) {
                child.kill('SIGKILL');
                return finish(workspaceAutomationError('工作区命令输出超过安全上限。', 'LOCAL_WORKSPACE_OUTPUT_LIMIT', 413));
            }
            list.push(buffer);
        };
        child.stdout.on('data', chunk => append(stdout, chunk));
        child.stderr.on('data', chunk => append(stderr, chunk));
        child.on('error', error => finish(workspaceAutomationError(`工作区命令启动失败：${error.message}`, 'LOCAL_WORKSPACE_COMMAND_FAILED', 502)));
        child.on('close', (code, signal) => finish(null, { code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(workspaceAutomationError('工作区命令执行超时。', 'LOCAL_WORKSPACE_TIMEOUT', 504));
        }, Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000));
    });
}

function safeGitEnvironment(env = process.env) {
    const next = { ...env };
    [
        'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_DIR', 'GIT_WORK_TREE',
        'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES',
        'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_CONFIG_COUNT'
    ].forEach(key => delete next[key]);
    Object.keys(next).filter(key => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)).forEach(key => delete next[key]);
    next.GIT_CONFIG_NOSYSTEM = '1';
    next.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    next.GIT_OPTIONAL_LOCKS = '0';
    return next;
}

async function runGit(root, args, options = {}) {
    const safeArgs = [
        '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never',
        '-c', 'core.sshCommand=ssh', '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false', ...args
    ];
    const result = await runProcess('git', safeArgs, { cwd: root, ...options, env: safeGitEnvironment(options.env || process.env) });
    if (result.code !== 0) throw workspaceAutomationError(result.stderr || `Git 命令失败（退出码 ${result.code}）。`, 'LOCAL_WORKSPACE_GIT_FAILED', 502);
    return result.stdout;
}

function assertSafeGitRemote(remoteUrl) {
    const value = String(remoteUrl || '').trim();
    const isHttps = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/~:-]+(?:\.git)?\/?$/i.test(value);
    const isSsh = /^(?:ssh:\/\/)?(?:git@)?[A-Za-z0-9.-]+(?::\d+)?[:/][A-Za-z0-9._/~:-]+(?:\.git)?\/?$/i.test(value);
    if (!isHttps && !isSsh) throw workspaceAutomationError('Git 远程必须是受支持的 HTTPS 或 SSH 仓库地址。', 'LOCAL_WORKSPACE_REMOTE_DENIED', 403);
    return value;
}

async function safeRemoteUrl(root, remote) {
    return assertSafeGitRemote((await runGit(root, ['remote', 'get-url', remote])).trim());
}

function githubRepositoryFromRemote(remoteUrl) {
    const value = String(remoteUrl || '').trim().replace(/\.git\/?$/i, '');
    const https = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(value);
    const ssh = /^(?:ssh:\/\/)?git@github\.com(?::\d+)?[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(value);
    const match = https || ssh;
    if (!match) throw workspaceAutomationError('GitHub Pull Request 仅支持已授权的 github.com HTTPS 或 SSH 远程。', 'LOCAL_WORKSPACE_PR_REMOTE_DENIED', 403);
    return `${match[1]}/${match[2]}`;
}

async function confirm(confirmAction, details) {
    if (typeof confirmAction !== 'function') throw workspaceAutomationError('本机工作区操作缺少用户确认通道。', 'LOCAL_WORKSPACE_CONFIRMATION_UNAVAILABLE', 409);
    if (await confirmAction(details) !== true) throw workspaceAutomationError('用户取消了本机工作区操作。', 'LOCAL_WORKSPACE_USER_CANCELLED', 409);
}

async function workspaceSummary(root) {
    const branch = (await runGit(root, ['branch', '--show-current'])).trim();
    const status = (await runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'])).split(/\r?\n/).filter(Boolean).slice(0, 200);
    return { rootHint: path.basename(root), branch, changedFiles: status, dirty: status.length > 0 };
}

function managedWorktreeNames(grant = {}) {
    const entries = grant?.managedWorktrees && typeof grant.managedWorktrees === 'object' ? grant.managedWorktrees : {};
    return new Set(Object.keys(entries).filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== '.' && name !== '..'));
}

function resolveManagedWorktree(root, grant, name) {
    if (!managedWorktreeNames(grant).has(name)) {
        throw workspaceAutomationError('指定工作树不是由 Pivot 在当前授权工作区创建。', 'LOCAL_WORKSPACE_WORKTREE_NOT_MANAGED', 403);
    }
    const managedRoot = resolvePath(root, '.pivot-worktrees');
    const target = resolvePath(root, path.posix.join('.pivot-worktrees', name));
    if (target === managedRoot || !isPathWithin(managedRoot, target) || !fs.existsSync(path.join(target, '.git'))) {
        throw workspaceAutomationError('指定的受控 Git 工作树不可用。', 'LOCAL_WORKSPACE_WORKTREE_NOT_FOUND', 404);
    }
    return target;
}

function prepareManagedWorktreeRoot(root) {
    const candidate = resolvePath(root, '.pivot-worktrees', { forWrite: true });
    fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
    return resolvePath(root, '.pivot-worktrees');
}

function workspaceWorkerDefinition(env = process.env) {
    const image = String(env.PIVOT_AGENT_WORKSPACE_WORKER_IMAGE || '').trim();
    if (!image) return null;
    const command = String(env.PIVOT_AGENT_WORKSPACE_WORKER_COMMAND || 'pivot-workspace-runner')
        .split(',').map(item => item.trim()).filter(Boolean).slice(0, 8);
    return {
        image,
        command,
        limits: {
            cpu: Number(env.PIVOT_AGENT_WORKSPACE_WORKER_CPU || 1),
            memoryMb: Number(env.PIVOT_AGENT_WORKSPACE_WORKER_MEMORY_MB || 1024),
            timeoutMs: 120000,
            maxOutputBytes: Number(env.PIVOT_AGENT_WORKSPACE_WORKER_MAX_OUTPUT_BYTES || MAX_OUTPUT_BYTES)
        }
    };
}

async function runWorkspaceTest(root, task, options = {}) {
    const definitions = {
        npm_test: ['npm', ['test']],
        npm_run: ['npm', ['run', ...task.args]],
        node_test: [process.execPath, ['--test', ...task.args]],
        python_pytest: [process.platform === 'win32' ? 'python' : 'python3', ['-m', 'pytest', ...task.args]]
    };
    const [command, args] = definitions[task.command] || [];
    if (!command) throw workspaceAutomationError('未登记的受控测试命令。', 'LOCAL_WORKSPACE_TEST_COMMAND_DENIED', 403);
    const worker = options.workerDefinition;
    if (!worker) throw workspaceAutomationError('运行代码测试需要已认证的隔离 Capability Worker。', 'LOCAL_WORKSPACE_WORKER_REQUIRED', 503);
    return await runCapabilityWorker(worker, { version: 1, action: 'workspace_test', command, args, timeoutMs: 120000 }, {
        env: options.env || process.env,
        workspaceMount: { source: root, target: '/workspace', readOnly: true }
    });
}

async function installWorkspaceDependencies(root, task, options = {}) {
    const commands = {
        npm_ci: ['npm', ['ci']],
        npm_install: ['npm', ['install', '--ignore-scripts']],
        pip_requirements: [process.platform === 'win32' ? 'python' : 'python3', ['-m', 'pip', 'install', '--requirement', 'requirements.txt']]
    };
    const [command, args] = commands[task.command] || [];
    if (!command) throw workspaceAutomationError('未登记的受控依赖安装命令。', 'LOCAL_WORKSPACE_INSTALL_COMMAND_DENIED', 403);
    const worker = options.workerDefinition;
    if (!worker) throw workspaceAutomationError('安装依赖需要已认证的隔离 Capability Worker。', 'LOCAL_WORKSPACE_WORKER_REQUIRED', 503);
    return await runCapabilityWorker(worker, { version: 1, action: 'workspace_install', command, args, timeoutMs: 120000 }, {
        env: options.env || process.env,
        workspaceMount: { source: root, target: '/workspace', readOnly: false }
    });
}

async function runLocalWorkspaceTask({ toolName, input, grant, confirmAction, workerDefinition, env, onManagedWorktreeCreated, onManagedWorktreeRemoved } = {}) {
    if (!isLocalWorkspaceConnectorTool(toolName)) throw workspaceAutomationError('不支持的本机代码工作区任务。', 'LOCAL_WORKSPACE_TOOL_INVALID');
    const primaryRoot = resolveWorkspace(grant);
    const task = normalizeWorkspaceTask(toolName, input, normalizeWorkspaceGrant(grant));
    const root = task.worktreeName ? resolveManagedWorktree(primaryRoot, grant, task.worktreeName) : primaryRoot;
    if (task.action === 'workspace.inspect') return { action: task.action, ...await workspaceSummary(root), worktreeName: task.worktreeName || null };
    if (task.action === 'workspace.read') {
        const file = resolvePath(root, task.path); ensureTextFile(file);
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat?.isFile()) throw workspaceAutomationError('工作区中没有指定文件。', 'LOCAL_WORKSPACE_FILE_NOT_FOUND', 404);
        if (stat.size > task.maxBytes || stat.size > MAX_READ_BYTES) throw workspaceAutomationError('文件超过安全读取上限。', 'LOCAL_WORKSPACE_FILE_TOO_LARGE', 413);
        const content = fs.readFileSync(file, 'utf8');
        return { action: task.action, path: task.path, content, digest: sha256(content), bytes: stat.size };
    }
    if (task.action === 'workspace.search') {
        const searchRoot = resolvePath(root, task.path);
        const searchPath = path.relative(root, searchRoot) || '.';
        let result;
        try {
            result = await runProcess('rg', ['--no-heading', '--line-number', '--glob', '!node_modules/**', '--glob', '!.git/**', '--regexp', task.query, '--', searchPath], { cwd: root, timeoutMs: 30000 });
        } catch (error) {
            if (String(error?.message || '').includes('ENOENT')) {
                const gitArgs = [
                    '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
                    '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never',
                    'grep', '--no-color', '-n', '-I', '--untracked', '--exclude-standard', '-e', task.query, '--', searchPath
                ];
                result = await runProcess('git', gitArgs, { cwd: root, timeoutMs: 30000, env: safeGitEnvironment(env || process.env) });
            } else {
                throw error;
            }
        }
        if (![0, 1].includes(result.code)) throw workspaceAutomationError(result.stderr || '代码搜索失败。', 'LOCAL_WORKSPACE_SEARCH_FAILED', 502);
        return { action: task.action, query: task.query, matches: result.stdout.split(/\r?\n/).filter(Boolean).slice(0, task.limit), truncated: result.stdout.split(/\r?\n/).filter(Boolean).length > task.limit };
    }
    if (task.action === 'workspace.patch') {
        const prepared = task.changes.map(change => {
            const file = resolvePath(root, change.path, { forWrite: true });
            ensureTextFile(file);
            const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
            if (change.expectedDigest && sha256(current) !== change.expectedDigest) {
                throw workspaceAutomationError(`文件 ${change.path} 已变化，拒绝覆盖。`, 'LOCAL_WORKSPACE_DIGEST_MISMATCH', 409);
            }
            return { ...change, currentDigest: sha256(current) };
        });
        await confirm(confirmAction, { kind: 'workspace_patch', title: '确认修改本机代码', message: `将修改 ${task.changes.length} 个授权工作区文件。`, workspace: path.basename(root), files: task.changes.map(change => change.path) });
        const changed = [];
        for (const change of prepared) {
            const file = resolvePath(root, change.path, { forWrite: true }); ensureTextFile(file);
            const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
            if (sha256(current) !== change.currentDigest) throw workspaceAutomationError(`文件 ${change.path} 已变化，拒绝覆盖。`, 'LOCAL_WORKSPACE_DIGEST_MISMATCH', 409);
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            fs.writeFileSync(file, change.content, { encoding: 'utf8', mode: 0o600 });
            changed.push({ path: change.path, digest: sha256(change.content), bytes: Buffer.byteLength(change.content, 'utf8') });
        }
        return { action: task.action, changed, workspace: await workspaceSummary(root), worktreeName: task.worktreeName || null };
    }
    if (task.action === 'workspace.install') {
        await confirm(confirmAction, { kind: 'workspace_install', title: '确认安装隔离依赖', message: `将在认证隔离 Worker 中运行 ${task.command}。`, workspace: path.basename(root) });
        return { action: task.action, result: await installWorkspaceDependencies(root, task, { workerDefinition: workerDefinition || workspaceWorkerDefinition(env || process.env), env }) };
    }
    if (task.action === 'workspace.test') {
        await confirm(confirmAction, { kind: 'workspace_test', title: '确认运行隔离代码测试', message: `将在认证隔离 Worker 中运行 ${task.command}。`, workspace: path.basename(root) });
        return { action: task.action, result: await runWorkspaceTest(root, task, { workerDefinition: workerDefinition || workspaceWorkerDefinition(env || process.env), env }) };
    }
    if (task.action === 'workspace.git_status') return { action: task.action, ...await workspaceSummary(root), worktreeName: task.worktreeName || null };
    if (task.action === 'workspace.git_diff') return { action: task.action, diff: await runGit(root, task.base ? ['diff', '--no-ext-diff', `${task.base}...HEAD`] : ['diff', '--no-ext-diff']), workspace: await workspaceSummary(root), worktreeName: task.worktreeName || null };
    if (task.action === 'workspace.git_worktree') {
        const managedRoot = prepareManagedWorktreeRoot(primaryRoot);
        if (typeof onManagedWorktreeCreated !== 'function') throw workspaceAutomationError('本机工作树登记通道不可用。', 'LOCAL_WORKSPACE_WORKTREE_REGISTRY_UNAVAILABLE', 409);
        await confirm(confirmAction, { kind: 'git_worktree', title: '确认创建隔离 Git 工作树', message: `将创建分支 ${task.branch} 的隔离工作树。`, workspace: path.basename(root) });
        const target = resolvePath(primaryRoot, path.posix.join('.pivot-worktrees', task.name), { forWrite: true });
        if (!isPathWithin(managedRoot, target) || target === managedRoot) throw workspaceAutomationError('Git 工作树路径越界。', 'LOCAL_WORKSPACE_PATH_DENIED', 403);
        if (fs.existsSync(target)) throw workspaceAutomationError('目标 Git 工作树目录已存在。', 'LOCAL_WORKSPACE_WORKTREE_EXISTS', 409);
        await runGit(primaryRoot, ['worktree', 'add', '-b', task.branch, target]);
        try {
            await onManagedWorktreeCreated({ name: task.name, branch: task.branch, pathHint: path.relative(primaryRoot, target) });
        } catch (error) {
            try { await runGit(primaryRoot, ['worktree', 'remove', '--force', target]); } catch (_) {}
            throw error;
        }
        return { action: task.action, branch: task.branch, worktreeName: task.name, worktreeHint: path.relative(primaryRoot, target) };
    }
    if (task.action === 'workspace.git_worktree_remove') {
        const target = resolveManagedWorktree(primaryRoot, grant, task.name);
        if (!fs.existsSync(target)) throw workspaceAutomationError('指定的受控 Git 工作树不存在。', 'LOCAL_WORKSPACE_WORKTREE_NOT_FOUND', 404);
        if (typeof onManagedWorktreeRemoved !== 'function') throw workspaceAutomationError('本机工作树登记通道不可用。', 'LOCAL_WORKSPACE_WORKTREE_REGISTRY_UNAVAILABLE', 409);
        await confirm(confirmAction, { kind: 'git_worktree_remove', title: '确认移除隔离 Git 工作树', message: `将移除工作树 ${task.name}，主工作区不会删除。`, workspace: path.basename(primaryRoot) });
        await runGit(primaryRoot, ['worktree', 'remove', '--force', target]);
        try {
            await onManagedWorktreeRemoved({ name: task.name });
        } catch (error) {
            throw workspaceAutomationError(`工作树已移除，但本机登记清理失败：${error.message}`, 'LOCAL_WORKSPACE_WORKTREE_REGISTRY_FAILED', 502);
        }
        return { action: task.action, name: task.name, removed: true };
    }
    if (task.action === 'workspace.git_merge') {
        await confirm(confirmAction, { kind: 'git_merge', title: '确认合并 Git 分支', message: `将分支 ${task.branch} 合并到当前工作区。发生冲突时不会自动覆盖。`, workspace: path.basename(root) });
        try {
            const output = await runGit(root, ['merge', '--no-commit', '--no-ff', task.branch]);
            return { action: task.action, merged: true, output };
        } catch (error) {
            let conflicts = [];
            try { conflicts = (await runGit(root, ['diff', '--no-ext-diff', '--name-only', '--diff-filter=U'])).split(/\r?\n/).filter(Boolean).slice(0, 200); } catch (_) {}
            if (conflicts.length) return { action: task.action, merged: false, conflicts, requiresResolution: true };
            throw error;
        }
    }
    if (task.action === 'workspace.git_abort_merge') {
        await confirm(confirmAction, { kind: 'git_abort_merge', title: '确认中止 Git 合并', message: '将撤销当前尚未提交的合并状态。', workspace: path.basename(root) });
        try { await runGit(root, ['merge', '--abort']); }
        catch (error) { throw workspaceAutomationError('当前没有可中止的 Git 合并。', 'LOCAL_WORKSPACE_MERGE_NOT_ACTIVE', 409); }
        return { action: task.action, aborted: true };
    }
    if (task.action === 'workspace.git_commit') {
        await confirm(confirmAction, { kind: 'git_commit', title: '确认提交 Git 变更', message: `将提交 ${task.paths.length} 个已列出文件：${task.message}`, workspace: path.basename(root), files: task.paths });
        await runGit(root, ['add', '--', ...task.paths]);
        const commit = await runGit(root, ['commit', '--only', '--no-verify', '-m', task.message, '--', ...task.paths]);
        return { action: task.action, paths: task.paths, commit };
    }
    if (task.action === 'workspace.git_push') {
        await confirm(confirmAction, { kind: 'git_push', title: '确认推送 Git 分支', message: `将向远程 ${task.remote} 推送当前分支。`, workspace: path.basename(root) });
        const remoteUrl = await safeRemoteUrl(root, task.remote);
        return { action: task.action, remoteUrl, output: await runGit(root, ['push', '--no-verify', remoteUrl, 'HEAD']) };
    }
    if (task.action === 'workspace.git_pr') {
        await confirm(confirmAction, { kind: 'git_pr', title: '确认创建 Pull Request', message: `将创建面向 ${task.base} 的 Pull Request：${task.title}`, workspace: path.basename(root) });
        const remoteUrl = await safeRemoteUrl(root, 'origin');
        const repository = githubRepositoryFromRemote(remoteUrl);
        const head = (await runGit(root, ['branch', '--show-current'])).trim();
        if (!head) throw workspaceAutomationError('当前 Git 工作区没有可创建 Pull Request 的分支。', 'LOCAL_WORKSPACE_PR_BRANCH_REQUIRED', 409);
        const output = await runProcess('gh', ['pr', 'create', '--repo', repository, '--head', head, '--base', task.base, '--title', task.title, '--body', task.body], { cwd: root, timeoutMs: 120000, env: safeGitEnvironment() });
        if (output.code !== 0) throw workspaceAutomationError(output.stderr || '创建 Pull Request 失败。', 'LOCAL_WORKSPACE_PR_FAILED', 502);
        return { action: task.action, remoteUrl, url: output.stdout.trim() };
    }
    throw workspaceError('未实现的本机代码工作区操作。', 'LOCAL_WORKSPACE_TOOL_INVALID');
}

module.exports = { MAX_READ_BYTES, SAFE_TEXT_EXTENSIONS, installWorkspaceDependencies, resolvePath, resolveWorkspace, runLocalWorkspaceTask, runWorkspaceTest, workspaceAutomationError, workspaceSummary, workspaceWorkerDefinition };
