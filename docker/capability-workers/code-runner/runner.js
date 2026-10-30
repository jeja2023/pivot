'use strict';

const fs = require('fs');
const http = require('http');
const vm = require('vm');

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 120000;

function fail(code, message) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
}

function readInput() {
    return new Promise((resolve, reject) => {
        let input = '';
        process.stdin.on('data', chunk => {
            input += chunk;
            if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) reject(Object.assign(new Error('输入超过限制。'), { code: 'AGENT_CODE_INPUT_LIMIT' }));
        });
        process.stdin.on('error', reject);
        process.stdin.on('end', () => resolve(input));
    });
}

function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function probeNetworkIsolation() {
    return new Promise(resolve => {
        const timer = setTimeout(() => { request.destroy(); resolve(true); }, 750);
        const request = http.get('http://1.1.1.1/', response => {
            response.resume(); clearTimeout(timer); resolve(false);
        });
        request.on('error', () => { clearTimeout(timer); resolve(true); });
    });
}

async function isolationProbe() {
    const probeFile = `/pivot-isolation-probe-${process.pid}-${Date.now()}`;
    let rootReadOnly = false;
    try { fs.writeFileSync(probeFile, 'probe', { flag: 'wx' }); fs.unlinkSync(probeFile); } catch (error) { rootReadOnly = ['EROFS', 'EACCES', 'EPERM'].includes(String(error?.code || '')); }
    let capabilitiesDropped = false;
    try { capabilitiesDropped = /^CapEff:\s*0+$/m.test(fs.readFileSync('/proc/self/status', 'utf8')); } catch (_) {}
    return {
        uidNonRoot: typeof process.getuid === 'function' && process.getuid() !== 0,
        rootReadOnly,
        capabilitiesDropped,
        networkBlocked: await probeNetworkIsolation()
    };
}

async function main() {
    try {
        const input = JSON.parse(await readInput());
        if (input?.version !== 1 || !['code', 'isolation_probe'].includes(input?.action)) throw Object.assign(new Error('不支持的 Worker 协议。'), { code: 'AGENT_CODE_PROTOCOL_INVALID' });
        if (input.action === 'isolation_probe') return process.stdout.write(`${JSON.stringify({ ok: true, result: await isolationProbe() })}\n`);
        const code = String(input.code || '');
        if (!code.trim()) throw Object.assign(new Error('代码不能为空。'), { code: 'AGENT_CODE_REQUIRED' });
        const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 30000, 1000), MAX_TIMEOUT_MS);
        const varsJson = JSON.stringify(input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars) ? input.vars : {});
        const sandbox = Object.create(null);
        const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
        // 在沙箱域中构造输入，避免宿主对象暴露宿主构造器。
        vm.runInContext(`Object.defineProperty(globalThis, 'vars', { value: Object.freeze(JSON.parse(${JSON.stringify(varsJson)})), enumerable: true })`, context, { timeout: timeoutMs });
        const source = `'use strict'; (function () { ${code}\n})()`;
        const script = new vm.Script(source, { filename: 'agent-code.js', displayErrors: true });
        const result = script.runInContext(context, { timeout: timeoutMs, breakOnSigint: true });
        if (result && typeof result.then === 'function') throw Object.assign(new Error('代码 Worker 不接受异步 Promise；请使用专用受控工具。'), { code: 'AGENT_CODE_ASYNC_UNSUPPORTED' });
        process.stdout.write(`${JSON.stringify({ ok: true, result: jsonClone(result) })}\n`);
    } catch (error) {
        fail(String(error?.code || 'AGENT_CODE_FAILED'), String(error?.message || '代码执行失败。').slice(0, 2000));
    }
}

main();
