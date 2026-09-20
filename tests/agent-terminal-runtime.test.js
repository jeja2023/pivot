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

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-terminal-'));
    return {
        root,
        user: { id: 71 },
        context: {
            run: { id: 'terminal-test' },
            terminalWorkspaceRoot: root,
            // The local runner is never a production fallback. It is enabled
            // here solely to unit-test input normalization without Docker.
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

test('direct built-in terminal entry cannot bypass the runtime approval boundary', async () => {
    await assert.rejects(
        () => executeBuiltInTool('terminal.runtime', { action: 'list' }, { id: 71 }, {}),
        error => error.code === 'AGENT_SANDBOX_REQUIRED'
    );
});
