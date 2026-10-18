'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const runner = path.resolve(__dirname, '..', 'docker', 'capability-workers', 'code-runner', 'runner.js');

function runCodeWorker(input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', value => { stdout += value; });
        child.stderr.on('data', value => { stderr += value; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(stderr || `执行器以状态码 ${code} 退出`));
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify(input));
    });
}

test('code runner executes only the versioned JSON protocol and serializes a result', async () => {
    const result = await runCodeWorker({ version: 1, action: 'code', code: 'return vars.value * 2;', vars: { value: 21 }, timeoutMs: 1000 });
    assert.deepEqual(result, { ok: true, result: 42 });
});

test('code runner does not expose Node host globals to evaluated code', async () => {
    const result = await runCodeWorker({
        version: 1,
        action: 'code',
        code: 'return `${typeof process}:${typeof require}:${typeof Buffer}`;',
        vars: {},
        timeoutMs: 1000
    });
    assert.deepEqual(result, { ok: true, result: 'undefined:undefined:undefined' });
});

test('code runner reports unsupported async code as a structured failure', async () => {
    const result = await runCodeWorker({ version: 1, action: 'code', code: 'return Promise.resolve(1);', vars: {}, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AGENT_CODE_ASYNC_UNSUPPORTED');
});
