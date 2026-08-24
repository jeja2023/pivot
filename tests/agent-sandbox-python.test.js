const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildRecoveryPlan } = require('../server/services/agent-diagnosis');
const { createWorkspaceJail, runSandboxedProcess } = require('../server/services/agent-sandbox');
const { runPythonScript } = require('../server/services/agent-python');

test('diagnosis creates bounded category-specific recovery plan', () => {
    const plan = buildRecoveryPlan({ category: 'network', retryable: true }, 2);
    assert.equal(plan.delayMs, 1000);
    assert.equal(plan.maxAttempts, 3);
    assert.match(plan.actions.join(' '), /退避/);
});

test('sandbox reports enforced isolation metadata and workspace jail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-sandbox-'));
    try {
        const jail = createWorkspaceJail(root, 'task');
        const result = await runSandboxedProcess(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { jail, timeoutMs: 5000 });
        assert.equal(result.code, 0);
        assert.match(result.stdout, /task/);
        assert.ok(result.isolation.osIsolation);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('python worker executes only inside task workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-python-'));
    try {
        const result = await runPythonScript({
            workspaceRoot: root,
            taskId: 'python-test',
            strictIsolation: false,
            script: "import json, sys\nfrom pathlib import Path\np = Path(sys.argv[sys.argv.index('--pivot-input') + 1])\ndata = json.loads(p.read_text())\nprint(data['value'] * 2)\n",
            input: { value: 21 }
        });
        assert.equal(result.code, 0);
        assert.match(result.stdout, /42/);
        assert.match(result.scriptPath, /python-test/);
        assert.match(result.stdout, /42/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace jail rejects symlink escapes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-symlink-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-outside-'));
    const jail = createWorkspaceJail(root, 'symlink-task');
    try {
        const link = path.join(jail.workspace, 'outside');
        try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
            if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return;
            throw error;
        }
        assert.throws(() => jail.resolve('outside/secret.txt'), /符号链接|越权/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('sandbox terminates noisy processes at the bounded output limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-agent-output-limit-'));
    try {
        const jail = createWorkspaceJail(root, 'output-limit');
        await assert.rejects(
            runSandboxedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(3000)); process.stderr.write("y".repeat(3000));'], {
                jail,
                timeoutMs: 5000,
                maxBufferBytes: 4096
            }),
            error => {
                assert.equal(error.code, 'AGENT_SANDBOX_OUTPUT_LIMIT_EXCEEDED');
            assert.equal(error.category, 'resource');
            assert.equal(error.maxBufferBytes, 4096);
            assert.ok(error.outputBytes > 4096);
                assert.ok(Buffer.byteLength(error.stdout, 'utf8') <= 4096);
                return true;
            }
        );
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
