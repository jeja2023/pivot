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
    fs.writeFileSync(path.join(root, 'sample.js'), 'export const value = 1;\n', 'utf8');
    git(['add', 'sample.js']);
    git(['commit', '-m', 'initial']);
    return root;
}

test('code workspace contract accepts only bounded relative paths, managed worktree names, and registered test commands', () => {
    const names = localWorkspaceToolDefinitions().map(tool => tool.name);
    assert.deepEqual(names, ['workspace.inspect', 'workspace.read', 'workspace.search', 'workspace.patch', 'workspace.install', 'workspace.test', 'workspace.git_status', 'workspace.git_diff', 'workspace.git_worktree', 'workspace.git_worktree_remove', 'workspace.git_merge', 'workspace.git_abort_merge', 'workspace.git_commit', 'workspace.git_push', 'workspace.git_pr']);
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
    assert.deepEqual(resolveRegisteredToolCapabilities('mcp.0.workspace.read', 'mcp'), ['filesystem.read_workspace']);
    assert.deepEqual(resolveRegisteredToolCapabilities('mcp.0.desktop.click', 'mcp'), ['desktop.control']);
});

test('desktop workspace automation reads, searches, patches, commits, and fails closed for tests without a worker', async () => {
    const root = createWorkspace();
    const grant = { path: root, label: 'Fixture', gitProvider: 'github_cli', managedWorktrees: {} };
    const confirmed = [];
    const confirmAction = async detail => { confirmed.push(detail.kind); return true; };
    const onManagedWorktreeCreated = async record => { grant.managedWorktrees[record.name] = record; };
    const onManagedWorktreeRemoved = async record => { delete grant.managedWorktrees[record.name]; };
    try {
        assert.equal(resolveWorkspace(grant), root);
        const inspect = await runLocalWorkspaceTask({ toolName: 'workspace.inspect', input: {}, grant, confirmAction });
        assert.equal(inspect.branch, 'master');
        const read = await runLocalWorkspaceTask({ toolName: 'workspace.read', input: { path: 'sample.js' }, grant, confirmAction });
        assert.match(read.content, /value = 1/);
        const search = await runLocalWorkspaceTask({ toolName: 'workspace.search', input: { query: 'value' }, grant, confirmAction });
        assert.ok(search.matches.some(line => /sample\.js/.test(line)));
        const flagLikeSearch = await runLocalWorkspaceTask({ toolName: 'workspace.search', input: { query: '--pre=definitely-not-a-preprocessor' }, grant, confirmAction });
        assert.deepEqual(flagLikeSearch.matches, []);
        const patched = await runLocalWorkspaceTask({
            toolName: 'workspace.patch',
            input: { changes: [{ path: 'sample.js', content: 'export const value = 2;\n', expectedDigest: read.digest }] },
            grant, confirmAction
        });
        assert.equal(patched.changed[0].path, 'sample.js');
        await assert.rejects(
            () => runLocalWorkspaceTask({ toolName: 'workspace.patch', input: { changes: [{ path: 'sample.js', content: 'x', expectedDigest: read.digest }] }, grant, confirmAction }),
            error => error.code === 'LOCAL_WORKSPACE_DIGEST_MISMATCH'
        );
        const committed = await runLocalWorkspaceTask({ toolName: 'workspace.git_commit', input: { message: 'change value', paths: ['sample.js'] }, grant, confirmAction });
        assert.match(committed.commit, /change value/);
        const worktree = await runLocalWorkspaceTask({ toolName: 'workspace.git_worktree', input: { branch: 'codex/isolated-test', name: 'isolated-test' }, grant, confirmAction, onManagedWorktreeCreated });
        assert.equal(worktree.branch, 'codex/isolated-test');
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
        fs.rmSync(root, { recursive: true, force: true });
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
        assert.equal(fs.readFileSync(path.join(outside, 'escape.js'), 'utf8'), 'export const escaped = true;\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
