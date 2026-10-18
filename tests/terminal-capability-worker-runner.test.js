'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const runner = path.resolve(__dirname, '..', 'docker', 'capability-workers', 'terminal-runner', 'runner.js');

function runTerminalWorker(workspace, input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, PIVOT_CAPABILITY_WORKSPACE_ROOT: workspace }
        });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', value => { stdout += value; });
        child.stderr.on('data', value => { stderr += value; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(stderr || `Worker 退出码 ${code}`));
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify(input));
    });
}

test('terminal capability worker performs bounded workspace file I/O without accepting a caller-selected root', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-terminal-worker-'));
    try {
        const written = await runTerminalWorker(workspace, { version: 1, action: 'write', path: 'notes/check.txt', content: '受控内容' });
        assert.deepEqual(written, { action: 'write', path: 'notes/check.txt', bytes: Buffer.byteLength('受控内容') });
        const read = await runTerminalWorker(workspace, { version: 1, action: 'read', path: 'notes/check.txt' });
        assert.equal(read.content, '受控内容');
        const list = await runTerminalWorker(workspace, { version: 1, action: 'list', path: 'notes' });
        assert.deepEqual(list.entries, [{ name: 'check.txt', type: 'file' }]);
        const traversal = await runTerminalWorker(workspace, { version: 1, action: 'read', path: '../outside.txt', workspaceRoot: os.tmpdir() });
        assert.match(traversal.stderr, /AGENT_TERMINAL_PATH_DENIED/);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
