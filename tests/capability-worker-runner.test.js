'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const fs = require('node:fs');

const runner = path.resolve(__dirname, '..', 'docker', 'capability-workers', 'code-runner', 'runner.js');

test('纯 Node 能力执行器使用独立轻量底座，终端保留完整工具底座', () => {
    const root = path.resolve(__dirname, '..', 'docker', 'capability-workers');
    for (const name of ['code-runner', 'foreach-runner']) {
        assert.match(fs.readFileSync(path.join(root, name, 'Dockerfile'), 'utf8'), /^ARG BASE_IMAGE=node:22-bookworm-slim$/m);
    }
    assert.match(fs.readFileSync(path.join(root, 'terminal-runner', 'Dockerfile'), 'utf8'), /^ARG BASE_IMAGE=pivot:latest$/m);
});

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

test('code runner input and nested objects cannot reach host Function constructor', async () => {
    for (const expression of ['vars.constructor.constructor', 'vars.nested.constructor.constructor']) {
        const result = await runCodeWorker({ version: 1, action: 'code',
            code: `return ${expression}('return process')();`, vars: { nested: {} }, timeoutMs: 1000 });
        assert.equal(result.ok, false);
        assert.match(result.error.message, /Code generation from strings disallowed/);
    }
});

test('code runner reports unsupported async code as a structured failure', async () => {
    const result = await runCodeWorker({ version: 1, action: 'code', code: 'return Promise.resolve(1);', vars: {}, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AGENT_CODE_ASYNC_UNSUPPORTED');
});
