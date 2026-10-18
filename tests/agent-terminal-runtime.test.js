'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    executeTerminalRuntime,
    isTerminalRuntimeAvailable
} = require('../server/services/agent-terminal-runtime');
const { executeBuiltInTool } = require('../server/services/agent-tools');

const originalNodeEnv = process.env.NODE_ENV;
test.before(() => { process.env.NODE_ENV = 'test'; });
test.after(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-terminal-'));
    return {
        root,
        user: { id: 71 },
        context: {
            run: { id: 'terminal-test' },
            terminalWorkspaceRoot: root,
            // 本地 runner 绝非生产环境后备方案。此处仅用于在无 Docker 环境下
            // 单独对输入规范化逻辑进行单元测试。
            env: { PIVOT_AGENT_TERMINAL_ALLOW_UNSAFE_LOCAL: 'true' }
        }
    };
}

test('terminal runtime confines file operations to the user/run workspace', async () => {
    const item = fixture();
    try {
        const written = await executeTerminalRuntime({ action: 'write', path: 'notes/input.txt', content: 'Pivot terminal' }, item.user, item.context);
        assert.equal(written.action, 'write');
        const read = await executeTerminalRuntime({ action: 'read', path: 'notes/input.txt' }, item.user, item.context);
        assert.equal(read.content, 'Pivot terminal');
        const listed = await executeTerminalRuntime({ action: 'list', path: 'notes' }, item.user, item.context);
        assert.deepEqual(listed.entries, [{ name: 'input.txt', type: 'file' }]);
        await assert.rejects(
            () => executeTerminalRuntime({ action: 'write', path: '../outside.txt', content: 'no' }, item.user, item.context),
            error => error.code === 'AGENT_TERMINAL_PATH_DENIED'
        );
    } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('terminal runtime allows only explicit runtimes and read-only inspection commands', async () => {
    const item = fixture();
    try {
        const result = await executeTerminalRuntime({
            action: 'exec', command: 'node', script: 'process.stdout.write("ok")'
        }, item.user, item.context);
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'ok');
        assert.equal(result.workspace.runner, 'unsafe-local-development-only');
        await assert.rejects(
            () => executeTerminalRuntime({ action: 'exec', command: 'powershell', args: ['-Command', 'whoami'] }, item.user, item.context),
            error => error.code === 'AGENT_TERMINAL_COMMAND_DENIED'
        );
        await assert.rejects(
            () => executeTerminalRuntime({ action: 'exec', command: 'git', args: ['commit', '-m', 'no'] }, item.user, item.context),
            error => error.code === 'AGENT_TERMINAL_GIT_DENIED'
        );
    } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('terminal runtime fails closed without an audited worker or explicit development override', async () => {
    assert.equal(isTerminalRuntimeAvailable({ env: {} }), false);
    assert.equal(isTerminalRuntimeAvailable({ env: { PIVOT_AGENT_TERMINAL_ALLOW_UNSAFE_LOCAL: 'true' } }), true);
    assert.equal(isTerminalRuntimeAvailable({ env: { PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_AGENT_TERMINAL_WORKER_IMAGE: 'runner:latest' } }), false);
    const item = fixture();
    try {
        await assert.rejects(
            () => executeTerminalRuntime({ action: 'write', path: 'C:/Windows/system.ini', content: 'no' }, item.user, item.context),
            error => error.code === 'AGENT_TERMINAL_PATH_DENIED'
        );
        await assert.rejects(
            () => executeTerminalRuntime({ action: 'exec', command: 'node', script: 'process.stdout.write("no")' }, item.user, { ...item.context, env: {} }),
            error => error.code === 'AGENT_TERMINAL_RUNTIME_UNAVAILABLE'
        );
    } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('production rejects the unsafe local override even when requested explicitly', async () => {
    const item = fixture();
    const prior = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = 'production';
        const context = { ...item.context, allowUnsafeLocal: true, env: { NODE_ENV: 'development', PIVOT_AGENT_TERMINAL_ALLOW_UNSAFE_LOCAL: 'true' } };
        assert.equal(isTerminalRuntimeAvailable(context), false);
        await assert.rejects(() => executeTerminalRuntime({ action: 'exec', command: 'node', script: 'throw new Error("不应执行")' }, item.user, context), error => error.code === 'AGENT_TERMINAL_RUNTIME_UNAVAILABLE');
    } finally {
        if (prior === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prior;
        fs.rmSync(item.root, { recursive: true, force: true });
    }
    assert.equal(isTerminalRuntimeAvailable({ allowUnsafeLocal: true, env: { NODE_ENV: 'production' } }), false);
});

test('direct built-in terminal entry cannot bypass the runtime approval boundary', async () => {
    await assert.rejects(
        () => executeBuiltInTool('terminal.runtime', { action: 'list' }, { id: 71 }, {}),
        error => error.code === 'AGENT_SANDBOX_REQUIRED'
    );
});

test('non-development terminal workspace I/O consumes the same bound execution grant as command execution', async () => {
    const item = fixture();
    const original = process.env.PIVOT_AGENT_EXECUTION_GRANT_SECRET;
    const executionSecret = 'terminal-workspace-io-grant-test-secret-01234567890123456789';
    process.env.PIVOT_AGENT_EXECUTION_GRANT_SECRET = executionSecret;
    try {
        await assert.rejects(
            () => executeTerminalRuntime({ action: 'list', path: '.' }, item.user, {
                ...item.context,
                env: {
                    PIVOT_CAPABILITY_WORKER_ENABLED: 'true',
                    PIVOT_AGENT_TERMINAL_WORKER_IMAGE: 'registry.example/pivot/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    PIVOT_AGENT_EXECUTION_GRANT_SECRET: executionSecret
                }
            }),
            error => error.status === 403 && /执行授权令牌/.test(error.message)
        );
    } finally {
        if (original === undefined) delete process.env.PIVOT_AGENT_EXECUTION_GRANT_SECRET;
        else process.env.PIVOT_AGENT_EXECUTION_GRANT_SECRET = original;
        fs.rmSync(item.root, { recursive: true, force: true });
    }
});

test('missing grant rejects inline code before creating a workspace or script', async () => {
    const item = fixture();
    try {
        const context = {
            ...item.context,
            env: {
                NODE_ENV: 'test', PIVOT_CAPABILITY_WORKER_ENABLED: 'true',
                PIVOT_AGENT_TERMINAL_WORKER_IMAGE: 'registry.example/pivot/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                PIVOT_AGENT_EXECUTION_GRANT_SECRET: 'terminal-inline-grant-test-secret-01234567890123456789'
            }
        };
        await assert.rejects(() => executeTerminalRuntime({ action: 'exec', command: 'node', script: 'process.stdout.write("no")' }, item.user, context), error => error.status === 403);
        assert.deepEqual(fs.readdirSync(item.root), []);
    } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});
