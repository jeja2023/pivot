'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    localWorkspaceToolDefinitions,
    normalizeWorkspaceTask
} = require('../server/services/local-workspace-connector-tools');
const { normalizeToolContract } = require('../server/services/agent-contracts');
const { evaluateToolPolicy } = require('../server/services/agent-policy');
const { resolveRegisteredToolCapabilities } = require('../server/services/agent-tool-capabilities');
const {
    resolveWorkspace,
    runLocalWorkspaceTask
} = require('../desktop/local-workspace-automation');
const { clearWorkspaceSemanticIndexCache } = require('../desktop/workspace-semantic-index');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-workspace-'));
    const git = (args) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
    };
    git(['init']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Pivot Test']);
    fs.writeFileSync(path.join(root, 'sample.js'), 'export const value = 1;\nexport const doubled = value * 2;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'sample.py'), 'def double(value: int) -> int:\n    return value * 2\n\nresult = double(3)\n', 'utf8');
    git(['add', 'sample.js', 'sample.py']);
    git(['commit', '-m', 'initial']);
    return root;
}

test('code workspace contract accepts only bounded relative paths, managed worktree names, and registered test commands', () => {
    const names = localWorkspaceToolDefinitions().map(tool => tool.name);
    assert.deepEqual(names, ['workspace.inspect', 'workspace.read', 'workspace.search', 'workspace.symbols', 'workspace.definition', 'workspace.references', 'workspace.patch', 'workspace.restore_snapshot', 'workspace.install', 'workspace.test', 'workspace.git_status', 'workspace.git_diff', 'workspace.git_worktree', 'workspace.git_worktree_remove', 'workspace.git_merge', 'workspace.git_abort_merge', 'workspace.git_commit', 'workspace.git_push', 'workspace.git_pr']);
    assert.throws(
        () => normalizeWorkspaceTask('workspace.read', { path: '../secret.txt' }),
        error => error.code === 'LOCAL_WORKSPACE_PATH_DENIED'
    );
    assert.throws(
        () => normalizeWorkspaceTask('workspace.test', { command: 'shell' }),
        error => error.code === 'LOCAL_WORKSPACE_TEST_COMMAND_DENIED'
    );
    assert.throws(
        () => normalizeWorkspaceTask('workspace.git_pr', { title: 'x' }, { gitProvider: 'none' }),
        error => error.code === 'LOCAL_WORKSPACE_PR_NOT_AUTHORIZED'
    );
    assert.throws(
        () => normalizeWorkspaceTask('workspace.git_push', { remote: '--upload-pack' }),
        error => error.code === 'LOCAL_WORKSPACE_REMOTE_INVALID'
    );
    assert.throws(
        () => normalizeWorkspaceTask('workspace.git_worktree_remove', { name: '..' }),
        error => error.code === 'LOCAL_WORKSPACE_WORKTREE_NAME_INVALID'
    );
    assert.throws(
        () => normalizeWorkspaceTask('workspace.restore_snapshot', { archiveDigest: 'a'.repeat(64), restoreHandle: 'wrong', targetName: 'restore-one' }),
        error => error.code === 'LOCAL_WORKSPACE_RECOVERY_HANDLE_INVALID'
    );
});

test('workspace delivery and native desktop tools require Agent approval before queueing a device task', () => {
    const patch = normalizeToolContract({ name: 'mcp.0.workspace.patch', source: 'mcp', risk: 'high', requiresApproval: true, side_effect: true });
    const desktop = normalizeToolContract({ name: 'mcp.0.desktop.click', source: 'mcp', risk: 'high', requiresApproval: true, side_effect: true });
    const run = { tool_policy: 'all', approval_policy: 'safe_mcp_auto' };
    assert.equal(patch.approval_required, true);
    assert.equal(desktop.approval_required, true);
    assert.equal(evaluateToolPolicy({ run, tool: patch, input: {}, user: { id: 1 } }).decision, 'require_approval');
    assert.equal(evaluateToolPolicy({ run, tool: desktop, input: {}, user: { id: 1 } }).decision, 'require_approval');
    assert.deepEqual(resolveRegisteredToolCapabilities('mcp.0.workspace.git_pr', 'mcp'), ['code.git_delivery']);
    assert.deepEqual(resolveRegisteredToolCapabilities('mcp.0.workspace.restore_snapshot', 'mcp'), ['filesystem.write_workspace']);
    assert.deepEqual(resolveRegisteredToolCapabilities('mcp.0.workspace.read', 'mcp'), ['filesystem.read_workspace']);
    assert.deepEqual(resolveRegisteredToolCapabilities('mcp.0.desktop.click', 'mcp'), ['desktop.control']);
});

test('desktop workspace automation reads, searches, patches, commits, and fails closed for tests without a worker', async () => {
    const root = createWorkspace();
    const semanticCacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-semantic-cache-'));
    const previousSemanticCacheRoot = process.env.PIVOT_AGENT_SEMANTIC_CACHE_ROOT;
    process.env.PIVOT_AGENT_SEMANTIC_CACHE_ROOT = semanticCacheRoot;
    const grant = { path: root, label: 'Fixture', gitProvider: 'github_cli', managedWorktrees: {} };
    const confirmed = [];
    const confirmAction = async detail => { confirmed.push(detail.kind); return true; };
    const onManagedWorktreeCreated = async record => { grant.managedWorktrees[record.name] = record; };
    const onManagedWorktreeRemoved = async record => { delete grant.managedWorktrees[record.name]; };
    try {
        assert.equal(resolveWorkspace(grant), root);
        const inspect = await runLocalWorkspaceTask({ toolName: 'workspace.inspect', input: {}, grant, confirmAction });
        assert.equal(inspect.branch, 'master');
        assert.match(inspect.revision, /^[a-f0-9]{64}$/);
        const read = await runLocalWorkspaceTask({ toolName: 'workspace.read', input: { path: 'sample.js' }, grant, confirmAction });
        assert.match(read.content, /value = 1/);
        const search = await runLocalWorkspaceTask({ toolName: 'workspace.search', input: { query: 'value' }, grant, confirmAction });
        assert.ok(search.matches.some(line => /sample\.js/.test(line)));
        const symbols = await runLocalWorkspaceTask({ toolName: 'workspace.symbols', input: { query: 'value' }, grant, confirmAction });
        assert.equal(symbols.symbols[0].name, 'value');
        assert.equal(symbols.symbols[0].kind, 'variable');
        assert.ok(Number(symbols.index?.changedFiles || 0) >= 1);
        const definition = await runLocalWorkspaceTask({ toolName: 'workspace.definition', input: { path: 'sample.js', line: 2, column: 24 }, grant, confirmAction });
        assert.equal(definition.definitions[0].path, 'sample.js');
        assert.equal(definition.definitions[0].line, 1);
        const references = await runLocalWorkspaceTask({ toolName: 'workspace.references', input: { path: 'sample.js', line: 2, column: 24 }, grant, confirmAction });
        assert.ok(references.references.length >= 2);
        const pythonSymbols = await runLocalWorkspaceTask({ toolName: 'workspace.symbols', input: { query: 'double', language: 'python' }, grant, confirmAction });
        assert.ok(pythonSymbols.symbols.some(symbol => symbol.name === 'double' && symbol.path === 'sample.py'), JSON.stringify(pythonSymbols));
        assert.ok(Number(pythonSymbols.index?.reusedFiles || 0) >= 1, JSON.stringify(pythonSymbols));
        clearWorkspaceSemanticIndexCache(root);
        const reusedPython = await runLocalWorkspaceTask({ toolName: 'workspace.symbols', input: { query: 'double', language: 'python' }, grant, confirmAction });
        assert.ok(reusedPython.symbols.some(symbol => symbol.name === 'double' && symbol.path === 'sample.py'));
        assert.ok(Number(reusedPython.index?.reusedFiles || 0) >= 1);
        fs.appendFileSync(path.join(root, 'sample.py'), '\ndef refreshed_python() -> int:\n    return double(4)\n', 'utf8');
        const refreshedPython = await runLocalWorkspaceTask({ toolName: 'workspace.symbols', input: { query: 'refreshed_python', language: 'python' }, grant, confirmAction });
        assert.equal(refreshedPython.symbols[0].name, 'refreshed_python');
        assert.ok(Number(refreshedPython.index?.changedFiles || 0) >= 1);
        const pythonDefinition = await runLocalWorkspaceTask({ toolName: 'workspace.definition', input: { path: 'sample.py', line: 4, column: 10 }, grant, confirmAction });
        assert.equal(pythonDefinition.language, 'python');
        assert.equal(pythonDefinition.definitions[0].path, 'sample.py');
        assert.equal(pythonDefinition.definitions[0].line, 1);
        const pythonReferences = await runLocalWorkspaceTask({ toolName: 'workspace.references', input: { path: 'sample.py', line: 4, column: 10 }, grant, confirmAction });
        assert.equal(pythonReferences.language, 'python');
        assert.ok(pythonReferences.references.length >= 2);
        const flagLikeSearch = await runLocalWorkspaceTask({ toolName: 'workspace.search', input: { query: '--pre=definitely-not-a-preprocessor' }, grant, confirmAction });
        assert.deepEqual(flagLikeSearch.matches, []);
        const patched = await runLocalWorkspaceTask({
            toolName: 'workspace.patch',
            input: { changes: [{ path: 'sample.js', content: 'export const value = 2;\nexport function refreshed() { return value; }\n', expectedDigest: read.digest }] },
            grant, confirmAction
        });
        assert.equal(patched.changed[0].path, 'sample.js');
        assert.match(patched.workspace.revision, /^[a-f0-9]{64}$/);
        const refreshed = await runLocalWorkspaceTask({ toolName: 'workspace.symbols', input: { query: 'refreshed', language: 'typescript' }, grant, confirmAction });
        assert.equal(refreshed.symbols[0].name, 'refreshed');
        assert.ok(Number(refreshed.index?.changedFiles || 0) >= 1);
        clearWorkspaceSemanticIndexCache(root);
        const reused = await runLocalWorkspaceTask({ toolName: 'workspace.symbols', input: { query: 'refreshed', language: 'typescript' }, grant, confirmAction });
        assert.equal(reused.symbols[0].name, 'refreshed');
        assert.ok(Number(reused.index?.reusedFiles || 0) >= 1);
        await assert.rejects(
            () => runLocalWorkspaceTask({ toolName: 'workspace.patch', input: { changes: [{ path: 'sample.js', content: 'x', expectedDigest: read.digest }] }, grant, confirmAction }),
            error => error.code === 'LOCAL_WORKSPACE_DIGEST_MISMATCH'
        );
        const committed = await runLocalWorkspaceTask({ toolName: 'workspace.git_commit', input: { message: 'change value', paths: ['sample.js'] }, grant, confirmAction });
        assert.match(committed.commit, /change value/);
        assert.match(committed.workspace.revision, /^[a-f0-9]{64}$/);
        const worktree = await runLocalWorkspaceTask({ toolName: 'workspace.git_worktree', input: { branch: 'codex/isolated-test', name: 'isolated-test' }, grant, confirmAction, onManagedWorktreeCreated });
        assert.equal(worktree.branch, 'codex/isolated-test');
        assert.equal(worktree.workspace.branch, 'codex/isolated-test', '返回的状态必须来自新建工作树而非主工作区');
        assert.equal(fs.existsSync(path.join(root, worktree.worktreeHint)), true);
        const worktreeRead = await runLocalWorkspaceTask({ toolName: 'workspace.read', input: { worktreeName: 'isolated-test', path: 'sample.js' }, grant, confirmAction });
        assert.match(worktreeRead.content, /value = 2/);
        const removed = await runLocalWorkspaceTask({ toolName: 'workspace.git_worktree_remove', input: { name: 'isolated-test' }, grant, confirmAction, onManagedWorktreeRemoved });
        assert.equal(removed.removed, true);
        assert.equal(fs.existsSync(path.join(root, worktree.worktreeHint)), false);
        const git = args => {
            const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
            assert.equal(result.status, 0, result.stderr);
        };
        git(['checkout', '-b', 'codex/merge-source']);
        fs.writeFileSync(path.join(root, 'merge-note.txt'), 'isolated change\n', 'utf8');
        git(['add', 'merge-note.txt']);
        git(['commit', '-m', 'merge source']);
        git(['checkout', inspect.branch]);
        const merged = await runLocalWorkspaceTask({ toolName: 'workspace.git_merge', input: { branch: 'codex/merge-source' }, grant, confirmAction });
        assert.equal(merged.merged, true);
        const aborted = await runLocalWorkspaceTask({ toolName: 'workspace.git_abort_merge', input: {}, grant, confirmAction });
        assert.equal(aborted.aborted, true);
        await assert.rejects(
            () => runLocalWorkspaceTask({ toolName: 'workspace.test', input: { command: 'npm_test' }, grant, confirmAction }),
            error => error.code === 'LOCAL_WORKSPACE_WORKER_REQUIRED'
        );
        await assert.rejects(
            () => runLocalWorkspaceTask({ toolName: 'workspace.install', input: { command: 'npm_ci' }, grant, confirmAction }),
            error => error.code === 'LOCAL_WORKSPACE_WORKER_REQUIRED'
        );
        assert.deepEqual(confirmed, ['workspace_patch', 'git_commit', 'git_worktree', 'git_worktree_remove', 'git_merge', 'git_abort_merge', 'workspace_test', 'workspace_install']);
    } finally {
        clearWorkspaceSemanticIndexCache(root);
        if (previousSemanticCacheRoot === undefined) delete process.env.PIVOT_AGENT_SEMANTIC_CACHE_ROOT;
        else process.env.PIVOT_AGENT_SEMANTIC_CACHE_ROOT = previousSemanticCacheRoot;
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(semanticCacheRoot, { recursive: true, force: true });
    }
});

test('workspace tools reject symbolic-link and junction escapes before reading, searching, or patching', async t => {
    const root = createWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-workspace-outside-'));
    const link = path.join(root, 'linked');
    const grant = { path: root, label: 'Fixture' };
    try {
        fs.writeFileSync(path.join(outside, 'escape.js'), 'export const escaped = true;\n', 'utf8');
        try {
            fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            t.skip(`当前测试环境无法创建目录链接：${error.code || error.message}`);
            return;
        }
        await assert.rejects(
            () => runLocalWorkspaceTask({ toolName: 'workspace.read', input: { path: 'linked/escape.js' }, grant, confirmAction: async () => true }),
            error => error.code === 'LOCAL_WORKSPACE_PATH_DENIED'
        );
        await assert.rejects(
            () => runLocalWorkspaceTask({ toolName: 'workspace.search', input: { path: 'linked', query: 'escaped' }, grant, confirmAction: async () => true }),
            error => error.code === 'LOCAL_WORKSPACE_PATH_DENIED'
        );
        await assert.rejects(
            () => runLocalWorkspaceTask({ toolName: 'workspace.patch', input: { changes: [{ path: 'linked/escape.js', content: 'changed\n' }] }, grant, confirmAction: async () => true }),
            error => error.code === 'LOCAL_WORKSPACE_PATH_DENIED'
        );
        await assert.rejects(
            () => runLocalWorkspaceTask({ toolName: 'workspace.definition', input: { path: 'linked/escape.js', line: 1, column: 14 }, grant, confirmAction: async () => true }),
            error => error.code === 'LOCAL_WORKSPACE_SEMANTIC_QUERY_FAILED'
        );
        await assert.rejects(
            () => runLocalWorkspaceTask({ toolName: 'workspace.symbols', input: { path: 'linked', language: 'javascript', query: 'escaped' }, grant, confirmAction: async () => true }),
            error => error.code === 'LOCAL_WORKSPACE_SEMANTIC_INDEX_FAILED'
        );
        assert.equal(fs.readFileSync(path.join(outside, 'escape.js'), 'utf8'), 'export const escaped = true;\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
