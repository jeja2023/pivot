'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 120000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 200;
const COMMANDS = new Set(['node', 'python', 'git', 'rg']);
// 发布容器未设置该变量，始终使用受控挂载点。仅测试夹具可注入临时目录，
// 不接受协议输入中的工作区根，避免调用方重定向 Worker 的文件系统范围。
const WORKSPACE_ROOT = path.resolve(process.env.PIVOT_CAPABILITY_WORKSPACE_ROOT || '/workspace');

function readInput() {
    return new Promise((resolve, reject) => {
        let input = '';
        process.stdin.on('data', chunk => {
            input += chunk;
            if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) reject(Object.assign(new Error('输入超过限制。'), { code: 'AGENT_TERMINAL_INPUT_LIMIT' }));
        });
        process.stdin.on('error', reject);
        process.stdin.on('end', () => resolve(input));
    });
}

function safeRelativePath(value) {
    const source = String(value || '').trim().replace(/\\/g, '/');
    if (!source || source.startsWith('/') || source.split('/').some(part => part === '..')) throw Object.assign(new Error('脚本路径无效。'), { code: 'AGENT_TERMINAL_PATH_DENIED' });
    const target = path.resolve(WORKSPACE_ROOT, source);
    if (target !== WORKSPACE_ROOT && !target.startsWith(`${WORKSPACE_ROOT}${path.sep}`)) throw Object.assign(new Error('脚本路径越界。'), { code: 'AGENT_TERMINAL_PATH_DENIED' });
    return target;
}

function assertNoSymlinkPath(target, { allowMissing = false } = {}) {
    const relative = path.relative(WORKSPACE_ROOT, target);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw Object.assign(new Error('工作区路径越界。'), { code: 'AGENT_TERMINAL_PATH_DENIED' });
    let current = WORKSPACE_ROOT;
    for (const part of relative ? relative.split(path.sep) : []) {
        current = path.join(current, part);
        if (!fs.existsSync(current)) {
            if (allowMissing) return;
            throw Object.assign(new Error('工作区文件不存在。'), { code: 'AGENT_TERMINAL_FILE_NOT_FOUND' });
        }
        if (fs.lstatSync(current).isSymbolicLink()) throw Object.assign(new Error('工作区符号链接访问被拒绝。'), { code: 'AGENT_TERMINAL_PATH_DENIED' });
    }
}

function safeWrite(input) {
    const target = safeRelativePath(input.path);
    const content = String(input.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw Object.assign(new Error('写入内容超过限制。'), { code: 'AGENT_TERMINAL_FILE_LIMIT' });
    assertNoSymlinkPath(path.dirname(target), { allowMissing: true });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    assertNoSymlinkPath(path.dirname(target));
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Object.assign(new Error('工作区符号链接访问被拒绝。'), { code: 'AGENT_TERMINAL_PATH_DENIED' });
    fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
    return { action: 'write', path: String(input.path), bytes: Buffer.byteLength(content, 'utf8') };
}

function safeRead(input) {
    const target = safeRelativePath(input.path);
    assertNoSymlinkPath(target);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw Object.assign(new Error('工作区中没有指定文件。'), { code: 'AGENT_TERMINAL_FILE_NOT_FOUND' });
    if (stat.size > MAX_FILE_BYTES) throw Object.assign(new Error('读取文件超过限制。'), { code: 'AGENT_TERMINAL_FILE_LIMIT' });
    return { action: 'read', path: String(input.path), content: fs.readFileSync(target, 'utf8'), bytes: stat.size };
}

function safeList(input) {
    const requested = String(input.path || '.').trim();
    const target = safeRelativePath(requested);
    assertNoSymlinkPath(target);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) throw Object.assign(new Error('工作区中没有指定目录。'), { code: 'AGENT_TERMINAL_DIRECTORY_NOT_FOUND' });
    const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, MAX_LIST_ENTRIES)
        .filter(entry => !entry.isSymbolicLink())
        .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
    return { action: 'list', path: requested, entries, truncated: entries.length >= MAX_LIST_ENTRIES };
}

function run(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: WORKSPACE_ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: '/tmp', LANG: 'C.UTF-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' } });
        let stdout = ''; let stderr = ''; let settled = false;
        const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        child.stdout.on('data', value => { stdout = `${stdout}${value}`.slice(0, 1024 * 1024); });
        child.stderr.on('data', value => { stderr = `${stderr}${value}`.slice(0, 1024 * 1024); });
        child.on('error', reject);
        child.on('close', (code, signal) => done({ exitCode: Number(code ?? 1), signal: signal || null, stdout, stderr }));
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} done({ exitCode: 124, signal: 'SIGKILL', stdout, stderr: `${stderr}\n命令超时。`.trim() }); }, timeoutMs);
    });
}

async function main() {
    try {
        const input = JSON.parse(await readInput());
        if (input?.version !== 1) throw Object.assign(new Error('不支持的 Worker 协议。'), { code: 'AGENT_TERMINAL_PROTOCOL_INVALID' });
        if (['read', 'write', 'list'].includes(input.action)) {
            const result = input.action === 'write' ? safeWrite(input) : input.action === 'read' ? safeRead(input) : safeList(input);
            return process.stdout.write(`${JSON.stringify(result)}\n`);
        }
        if (input.action !== 'exec') throw Object.assign(new Error('不支持的 Worker 协议。'), { code: 'AGENT_TERMINAL_PROTOCOL_INVALID' });
        const command = String(input.command || '').toLowerCase();
        if (!COMMANDS.has(command)) throw Object.assign(new Error('命令不在受控清单中。'), { code: 'AGENT_TERMINAL_COMMAND_DENIED' });
        const rawArgs = Array.isArray(input.args) ? input.args.map(value => String(value)) : [];
        const args = ['node', 'python'].includes(command)
            ? [safeRelativePath(input.scriptPath), ...rawArgs]
            // 容器内的非 root 用户与宿主工作区 UID 不一致；仅对已被 bind mount
            // 到固定 /workspace 的受控 Git 调用显式声明安全目录，不能读取任意仓库。
            : command === 'git' ? ['-c', `safe.directory=${WORKSPACE_ROOT}`, ...rawArgs] : rawArgs;
        const binary = command === 'python' ? 'python3' : command;
        process.stdout.write(`${JSON.stringify(await run(binary, args, Math.min(Math.max(Number(input.timeoutMs) || 30000, 1000), MAX_TIMEOUT_MS)))}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({ exitCode: 1, signal: null, stdout: '', stderr: `${String(error?.code || 'AGENT_TERMINAL_FAILED')}: ${String(error?.message || '执行失败。')}` })}\n`);
    }
}

main();
