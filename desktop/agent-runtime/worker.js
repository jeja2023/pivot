// One-request execution worker. It speaks JSONL over stdin/stdout so the
// Electron main process can keep the execution plane outside its renderer.
const readline = require('readline');
const { createWorkspaceJail, runSandboxedProcess } = require('../../server/services/agent-sandbox');

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function writeResult(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(request) {
    if (!request || typeof request !== 'object') throw new Error('Worker 请求格式无效。');
    if (request.approved !== true) {
        const error = new Error('桌面 Worker 执行必须携带显式批准。');
        error.code = 'AGENT_DESKTOP_APPROVAL_REQUIRED';
        throw error;
    }
    const command = String(request.command || '').trim();
    if (!command || command.includes('/') || command.includes('\\')) {
        const error = new Error('Worker 只接受不含路径的可执行文件名。');
        error.code = 'AGENT_WORKER_COMMAND_INVALID';
        throw error;
    }
    const allowlist = String(process.env.AGENT_WORKER_COMMAND_ALLOWLIST || 'node,python,python3').split(',').map(item => item.trim()).filter(Boolean);
    if (!allowlist.includes(command)) {
        const error = new Error(`Worker 命令未获允许：${command}`);
        error.code = 'AGENT_WORKER_COMMAND_DENIED';
        throw error;
    }
    const workspaceRoot = String(request.workspaceRoot || '').trim();
    if (!workspaceRoot) throw new Error('Worker 必须绑定工作区根目录。');
    const jail = createWorkspaceJail(workspaceRoot, request.taskId || 'agent-worker');
    const args = Array.isArray(request.args) ? request.args.slice(0, 32).map(String) : [];
    const result = await runSandboxedProcess(command, args, {
        jail,
        timeoutMs: Math.min(Math.max(Number(request.timeoutMs) || 30000, 100), 10 * 60 * 1000),
        input: request.input === undefined ? '' : String(request.input),
        env: { PIVOT_AGENT_WORKER: '1' }
    });
    return {
        ...result,
        stdout: result.stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: result.stderr.slice(0, MAX_OUTPUT_BYTES),
        truncated: result.stdout.length > MAX_OUTPUT_BYTES || result.stderr.length > MAX_OUTPUT_BYTES,
        jail: jail.metadata
    };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let consumed = false;
rl.on('line', async line => {
    if (consumed) return;
    consumed = true;
    try {
        if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Worker 请求超过大小限制。');
        const result = await handle(JSON.parse(line));
        writeResult({ ok: true, result });
    } catch (error) {
        writeResult({ ok: false, error: { code: error.code || 'AGENT_WORKER_FAILED', message: String(error.message || error) } });
        process.exitCode = 1;
    } finally {
        rl.close();
    }
});
