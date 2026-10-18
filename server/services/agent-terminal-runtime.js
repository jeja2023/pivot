'use strict';

/*
 * 面向 Agent 运行的受限终端执行面。本模块绝非宿主机 Shell：所有命令均在按用户和按运行隔离的
 * 隔离工作区中无 Shell 启动，默认切断网络，且可执行程序集合完全受控。
 * 保持该边界可确保桌面端、Agent 自动化及手动测试统一具备完全一致的执行语义。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createWorkspaceJail, runSandboxedProcess } = require('./agent-sandbox');
const { resolvePythonExecutable } = require('./agent-python');
const {
    isWorkerEnabled,
    normalizeDefinition: normalizeWorkerDefinition,
    runCapabilityWorker,
    verifyWorkerSignature
} = require('./agent-capability-worker');
const { verifyExecutionGrant } = require('./agent-execution-grant');
const { consumeExecutionGrant } = require('./agent-execution-grant-ledger');

const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_LENGTH = 1024;
const MAX_TIMEOUT_MS = 120000;
const TERMINAL_COMMANDS = Object.freeze(['node', 'python', 'git', 'rg']);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show']);

function terminalError(message, code = 'AGENT_TERMINAL_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function terminalRoot(context = {}) {
    const configured = String(context.terminalWorkspaceRoot || process.env.PIVOT_AGENT_TERMINAL_ROOT || '').trim();
    return path.resolve(configured || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-terminal'));
}

function terminalTaskId(user = {}, context = {}) {
    const userId = Number.parseInt(user?.id, 10);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw terminalError('终端执行必须关联有效用户。', 'AGENT_TERMINAL_USER_REQUIRED', 401);
    const runId = String(context.run?.id || context.runId || context.taskId || 'manual').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'manual';
    // 严禁从工具入参接收自定义任务 ID。用户只能访问归属于本人账户的工作区，
    // 常规 Agent 调用还会额外按 Run 隔离到独立子空间。
    return `user-${userId}-${runId}`;
}

function safeRelativePath(value, fallback = '') {
    const source = String(value || fallback).trim().replace(/\\/g, '/');
    if (!source) throw terminalError('请提供工作区内的文件路径。', 'AGENT_TERMINAL_PATH_REQUIRED');
    if (source.length > 240 || source.startsWith('/') || /^[A-Za-z]:/.test(source) || source.split('/').some(item => item === '..')) {
        throw terminalError('终端文件路径必须位于当前受控工作区内。', 'AGENT_TERMINAL_PATH_DENIED', 403);
    }
    const normalized = path.posix.normalize(source).replace(/^\.\//, '');
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
        throw terminalError('终端文件路径无效。', 'AGENT_TERMINAL_PATH_DENIED', 403);
    }
    return normalized;
}

function normalizeArgs(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw terminalError('终端参数必须是字符串数组。', 'AGENT_TERMINAL_ARGS_INVALID');
    if (value.length > MAX_ARGUMENTS) throw terminalError(`终端参数最多 ${MAX_ARGUMENTS} 个。`, 'AGENT_TERMINAL_ARGS_LIMIT');
    return value.map(item => {
        const arg = String(item ?? '');
        if (!arg || arg.length > MAX_ARGUMENT_LENGTH || /[\u0000\r\n]/.test(arg)) {
            throw terminalError('终端参数不能为空、不能包含换行且长度受限。', 'AGENT_TERMINAL_ARGS_INVALID');
        }
        return arg;
    });
}

function normalizeAction(value) {
    const action = String(value || 'exec').trim().toLowerCase();
    if (!['exec', 'write', 'read', 'list'].includes(action)) throw terminalError('终端操作仅支持 exec、write、read 或 list。');
    return action;
}

function ensureScriptSource(value) {
    const source = String(value || '');
    const bytes = Buffer.byteLength(source, 'utf8');
    if (!source.trim()) throw terminalError('Node/Python 执行需要 script 或 scriptPath。', 'AGENT_TERMINAL_SCRIPT_REQUIRED');
    if (bytes > MAX_SCRIPT_BYTES) throw terminalError(`脚本超过 ${MAX_SCRIPT_BYTES} 字节限制。`, 'AGENT_TERMINAL_SCRIPT_LIMIT');
    return source;
}

function inlineScriptName(command, source) {
    const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 20);
    return `.pivot-terminal-${digest}.${command === 'python' ? 'py' : 'js'}`;
}

function resolveCommand(command) {
    if (command === 'node') return process.execPath;
    if (command === 'python') return resolvePythonExecutable();
    return command;
}

function terminalWorkerDefinition(env = process.env) {
    const image = String(env.PIVOT_AGENT_TERMINAL_WORKER_IMAGE || '').trim();
    if (!image) return null;
    const command = String(env.PIVOT_AGENT_TERMINAL_WORKER_COMMAND || 'node,/runner/runner.js')
        .split(',').map(item => item.trim()).filter(Boolean).slice(0, 8);
    return {
        image,
        command,
        limits: {
            cpu: Number(env.PIVOT_AGENT_TERMINAL_WORKER_CPU || 1),
            memoryMb: Number(env.PIVOT_AGENT_TERMINAL_WORKER_MEMORY_MB || 512),
            timeoutMs: MAX_TIMEOUT_MS,
            maxOutputBytes: Number(env.PIVOT_AGENT_TERMINAL_MAX_OUTPUT_BYTES || 1024 * 1024)
        }
    };
}

function allowUnsafeLocal(context = {}) {
    const env = context.env || process.env;
    // 请求上下文不能覆盖真实进程的生产环境；生产误配置或调用方传入
    // allowUnsafeLocal 时也必须保持 fail-closed。
    if ([process.env.NODE_ENV, env.NODE_ENV].some(value => String(value || '').trim().toLowerCase() === 'production')) return false;
    return context.allowUnsafeLocal === true || String(env.PIVOT_AGENT_TERMINAL_ALLOW_UNSAFE_LOCAL || '').toLowerCase() === 'true';
}

function isTerminalRuntimeAvailable(context = {}) {
    const env = context.env || process.env;
    if (allowUnsafeLocal(context)) return true;
    const worker = terminalWorkerDefinition(env);
    if (!worker || !isWorkerEnabled(env)) return false;
    try {
        const normalized = normalizeWorkerDefinition(worker);
        verifyWorkerSignature(normalized, { env });
        return true;
    } catch (_) { return false; }
}

function validateReadOnlyCommand(command, args) {
    if (command === 'git') {
        if (!READ_ONLY_GIT_SUBCOMMANDS.has(String(args[0] || ''))) {
            throw terminalError('受控 Git 终端仅支持 status、diff、log 或 show。', 'AGENT_TERMINAL_GIT_DENIED', 403);
        }
        if (args.some(arg => /(?:^|[\\/])\.\.(?:[\\/]|$)|^--upload-pack|^--receive-pack/i.test(arg))) {
            throw terminalError('Git 参数包含不允许的路径或远程执行选项。', 'AGENT_TERMINAL_ARGS_DENIED', 403);
        }
    }
    if (command === 'rg') {
        if (!args.length || args.some(arg => /(?:^|[\\/])\.\.(?:[\\/]|$)|^--pre|^--type-add/i.test(arg))) {
            throw terminalError('受控 ripgrep 需要搜索词，且不允许越出工作区或定义预处理命令。', 'AGENT_TERMINAL_ARGS_DENIED', 403);
        }
    }
}

function prepareJail(user, context = {}) {
    return createWorkspaceJail(terminalRoot(context), terminalTaskId(user, context));
}

function executionWorkspaceScopeId(context = {}) {
    const runId = String(context.run?.id || context.runId || context.taskId || '').trim();
    return String(context.executionWorkspaceScopeId || (runId ? `run:${runId}` : '')).slice(0, 160);
}

function assertTerminalExecutionGrant(input, user, context = {}) {
    const env = context.env || process.env;
    const runId = String(context.run?.id || context.runId || context.taskId || '').trim();
    const workspaceScopeId = executionWorkspaceScopeId(context);
    if (!runId || !workspaceScopeId) {
        throw terminalError('受控终端执行必须关联运行与工作区授权范围。', 'AGENT_EXECUTION_GRANT_CONTEXT_INVALID', 403);
    }
    try {
        return verifyExecutionGrant(context.executionGrant, {
            runId,
            userId: user?.id,
            tool: 'terminal.runtime',
            input,
            workspaceScopeId
        }, { env });
    } catch (error) {
        throw terminalError(error.message || '受控终端执行授权无效。', error.code || 'AGENT_EXECUTION_GRANT_INVALID', error.status || 403);
    }
}

async function consumeTerminalExecutionGrant(input, user, context = {}) {
    const executionGrant = assertTerminalExecutionGrant(input, user, context);
    try {
        await consumeExecutionGrant({
            token: context.executionGrant,
            payload: executionGrant.payload,
            consumer: `terminal.runtime:${process.pid}`
        });
    } catch (error) {
        throw terminalError(error.message || '受控终端执行授权账本校验失败。', error.code || 'AGENT_EXECUTION_GRANT_UNAVAILABLE', error.status || 403);
    }
    return executionGrant;
}

function publicWorkspace(jail) {
    return {
        isolated: true,
        network: 'disabled',
        osIsolation: jail.metadata?.osIsolation || 'process-tree',
        networkIsolation: jail.metadata?.networkIsolation || 'policy-enforced'
    };
}

async function writeTerminalFile(input = {}, user, context = {}) {
    const relativePath = safeRelativePath(input.path || input.filePath || input.file_path);
    const content = String(input.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw terminalError(`终端写入内容超过 ${MAX_FILE_BYTES} 字节限制。`, 'AGENT_TERMINAL_FILE_LIMIT');
    const jail = prepareJail(user, context);
    const target = jail.resolve(relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    // 创建父目录后再次校验解析路径，防御校验与写入之间的并发符号链接替换。
    const safeTarget = jail.resolve(relativePath);
    fs.writeFileSync(safeTarget, content, { encoding: 'utf8', mode: 0o600 });
    return { action: 'write', path: relativePath, bytes: Buffer.byteLength(content, 'utf8'), workspace: publicWorkspace(jail) };
}

async function readTerminalFile(input = {}, user, context = {}) {
    const relativePath = safeRelativePath(input.path || input.filePath || input.file_path);
    const jail = prepareJail(user, context);
    const target = jail.resolve(relativePath);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) throw terminalError('工作区内未找到指定文件。', 'AGENT_TERMINAL_FILE_NOT_FOUND', 404);
    if (stat.size > MAX_FILE_BYTES) throw terminalError(`终端读取文件超过 ${MAX_FILE_BYTES} 字节限制。`, 'AGENT_TERMINAL_FILE_LIMIT');
    return { action: 'read', path: relativePath, content: fs.readFileSync(target, 'utf8'), bytes: stat.size, workspace: publicWorkspace(jail) };
}

async function listTerminalFiles(input = {}, user, context = {}) {
    const requested = String(input.path || input.directory || '.').trim();
    const relativePath = requested === '.' ? '.' : safeRelativePath(requested);
    const jail = prepareJail(user, context);
    const target = relativePath === '.' ? jail.resolve('.') : jail.resolve(relativePath);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) throw terminalError('工作区内未找到指定目录。', 'AGENT_TERMINAL_DIRECTORY_NOT_FOUND', 404);
    const entries = fs.readdirSync(target, { withFileTypes: true })
        .slice(0, MAX_LIST_ENTRIES)
        .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
    return { action: 'list', path: relativePath, entries, truncated: entries.length >= MAX_LIST_ENTRIES, workspace: publicWorkspace(jail) };
}

async function executeTerminalCommand(input = {}, user, context = {}) {
    const command = String(input.command || input.runtime || '').trim().toLowerCase();
    if (!TERMINAL_COMMANDS.includes(command)) throw terminalError(`受控终端仅支持：${TERMINAL_COMMANDS.join('、')}。`, 'AGENT_TERMINAL_COMMAND_DENIED', 403);
    const args = normalizeArgs(input.args);
    // 生产环境在创建工作区或写入内联脚本前先消费绑定授权，避免无授权请求
    // 留下宿主文件副作用。可用性与镜像信任已由 executeTerminalRuntime 校验。
    const unsafeLocal = allowUnsafeLocal(context);
    const executionGrant = unsafeLocal ? null : await consumeTerminalExecutionGrant(input, user, context);
    const jail = prepareJail(user, context);
    let effectiveArgs = args;
    let scriptPath = '';
    if (command === 'node' || command === 'python') {
        const suppliedScript = input.script;
        const suppliedPath = input.scriptPath || input.script_path;
        if (suppliedScript !== undefined && String(suppliedScript).trim()) {
            const source = ensureScriptSource(suppliedScript);
            const relative = safeRelativePath(suppliedPath || inlineScriptName(command, source));
            const target = jail.resolve(relative);
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            fs.writeFileSync(jail.resolve(relative), source, { encoding: 'utf8', mode: 0o600 });
            scriptPath = relative;
        } else {
            scriptPath = safeRelativePath(suppliedPath);
            const target = jail.resolve(scriptPath);
            const stat = fs.statSync(target, { throwIfNoEntry: false });
            if (!stat || !stat.isFile()) throw terminalError('指定脚本不存在；请先写入脚本或提供 script。', 'AGENT_TERMINAL_SCRIPT_NOT_FOUND', 404);
            if (stat.size > MAX_SCRIPT_BYTES) throw terminalError(`脚本超过 ${MAX_SCRIPT_BYTES} 字节限制。`, 'AGENT_TERMINAL_SCRIPT_LIMIT');
        }
        effectiveArgs = [jail.resolve(scriptPath), ...args];
    } else {
        validateReadOnlyCommand(command, args);
    }
    const timeoutMs = Math.min(Math.max(Number(input.timeoutMs || input.timeout_ms) || 30000, 100), MAX_TIMEOUT_MS);
    const env = context.env || process.env;
    const worker = terminalWorkerDefinition(env);
    if (worker && isWorkerEnabled(env) && !unsafeLocal) {
        const output = await runCapabilityWorker(worker, {
            version: 1,
            action: 'exec',
            command,
            args,
            scriptPath: scriptPath || null,
            timeoutMs
        }, {
            env,
            signal: context.signal || null,
            workspaceMount: { source: jail.workspace, target: '/workspace', readOnly: false },
            requireExecutionGrant: true,
            executionGrant: context.executionGrant,
            executionGrantExpected: {
                runId: String(context.run?.id || context.runId || context.taskId || ''),
                userId: user?.id,
                tool: 'terminal.runtime',
                input,
                workspaceScopeId: executionWorkspaceScopeId(context)
            }
        });
        if (!output || typeof output !== 'object' || Array.isArray(output)) throw terminalError('受控终端 Worker 返回格式无效。', 'AGENT_TERMINAL_WORKER_OUTPUT_INVALID', 502);
        return {
            action: 'exec', command, args, scriptPath: scriptPath || null,
            exitCode: Number.isInteger(output.exitCode) ? output.exitCode : 0,
            signal: output.signal ? String(output.signal) : null,
            stdout: String(output.stdout || ''), stderr: String(output.stderr || ''),
            workspace: { ...publicWorkspace(jail), runner: 'capability-worker', executionGrant: executionGrant.summary }
        };
    }
    if (!allowUnsafeLocal(context)) {
        throw terminalError('受控终端尚未配置。请启用 Capability Worker 并登记带摘要的终端 Runner 镜像；开发诊断环境才可显式开启本地后备。', 'AGENT_TERMINAL_RUNTIME_UNAVAILABLE', 503);
    }
    const result = await runSandboxedProcess(resolveCommand(command), effectiveArgs, {
        jail,
        timeoutMs,
        signal: context.signal || null,
        strictIsolation: context.strictIsolation === true || process.env.PIVOT_AGENT_STRICT_ISOLATION === '1' || process.env.PIVOT_AGENT_STRICT_ISOLATION === 'true',
        networkDisabled: true,
        inheritEnv: false,
        env: { PIVOT_AGENT_TERMINAL: '1', NO_PROXY: '*', no_proxy: '*', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
    });
    return {
        action: 'exec', command, args,
        scriptPath: scriptPath || null,
        exitCode: result.code,
        signal: result.signal || null,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        workspace: { ...publicWorkspace(jail), runner: 'unsafe-local-development-only' }
    };
}

function normalizeWorkerWorkspaceEntries(value) {
    if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) throw terminalError('终端 Worker 返回的目录条目无效。', 'AGENT_TERMINAL_WORKER_OUTPUT_INVALID', 502);
    return value.map(item => {
        const name = String(item?.name || '');
        const type = String(item?.type || '');
        if (!name || name.length > 240 || /[\\/\u0000\r\n]/.test(name) || !['file', 'directory', 'other'].includes(type)) {
            throw terminalError('终端 Worker 返回的目录条目无效。', 'AGENT_TERMINAL_WORKER_OUTPUT_INVALID', 502);
        }
        return { name, type };
    });
}

async function executeTerminalWorkspaceActionInWorker(action, input = {}, user, context = {}) {
    const env = context.env || process.env;
    const worker = terminalWorkerDefinition(env);
    if (!worker || !isWorkerEnabled(env)) {
        throw terminalError('终端文件操作需要已认证的隔离 Capability Worker。', 'AGENT_TERMINAL_RUNTIME_UNAVAILABLE', 503);
    }
    const relativePath = action === 'list'
        ? (String(input.path || input.directory || '.').trim() === '.' ? '.' : safeRelativePath(input.path || input.directory))
        : safeRelativePath(input.path || input.filePath || input.file_path);
    const content = action === 'write' ? String(input.content ?? '') : undefined;
    if (action === 'write' && Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        throw terminalError(`终端写入内容超过 ${MAX_FILE_BYTES} 字节限制。`, 'AGENT_TERMINAL_FILE_LIMIT');
    }
    const jail = prepareJail(user, context);
    const executionGrant = await consumeTerminalExecutionGrant(input, user, context);
    const output = await runCapabilityWorker(worker, {
        version: 1,
        action,
        path: relativePath,
        ...(action === 'write' ? { content } : {})
    }, {
        env,
        signal: context.signal || null,
        workspaceMount: { source: jail.workspace, target: '/workspace', readOnly: action !== 'write' },
        requireExecutionGrant: true,
        executionGrant: context.executionGrant,
        executionGrantExpected: {
            runId: String(context.run?.id || context.runId || context.taskId || ''),
            userId: user?.id,
            tool: 'terminal.runtime',
            input,
            workspaceScopeId: executionWorkspaceScopeId(context)
        }
    });
    if (!output || typeof output !== 'object' || Array.isArray(output) || String(output.action || '') !== action) {
        throw terminalError('终端 Worker 返回格式无效。', 'AGENT_TERMINAL_WORKER_OUTPUT_INVALID', 502);
    }
    const workspace = { ...publicWorkspace(jail), runner: 'capability-worker', executionGrant: executionGrant.summary };
    if (action === 'write') {
        const bytes = Number(output.bytes || 0);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_FILE_BYTES) throw terminalError('终端 Worker 返回字节数无效。', 'AGENT_TERMINAL_WORKER_OUTPUT_INVALID', 502);
        return { action, path: relativePath, bytes, workspace };
    }
    if (action === 'read') {
        const value = String(output.content ?? '');
        const bytes = Number(output.bytes || Buffer.byteLength(value, 'utf8'));
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_FILE_BYTES || Buffer.byteLength(value, 'utf8') > MAX_FILE_BYTES) {
            throw terminalError('终端 Worker 返回内容超过限制。', 'AGENT_TERMINAL_WORKER_OUTPUT_INVALID', 502);
        }
        return { action, path: relativePath, content: value, bytes, workspace };
    }
    return {
        action,
        path: relativePath,
        entries: normalizeWorkerWorkspaceEntries(output.entries),
        truncated: output.truncated === true,
        workspace
    };
}

async function executeTerminalRuntime(input = {}, user, context = {}) {
    if (!isTerminalRuntimeAvailable(context)) {
        throw terminalError('受控终端尚未配置；请先启用已审计的 Capability Worker。', 'AGENT_TERMINAL_RUNTIME_UNAVAILABLE', 503);
    }
    const action = normalizeAction(input.action);
    if (action === 'write' || action === 'read' || action === 'list') {
        // 生产文件 I/O 和命令执行使用同一已认证 Worker；宿主路径检查不能替代
        // 文件系统隔离。只有显式开发诊断环境保留本地实现以支持离线单测。
        if (!allowUnsafeLocal(context)) return await executeTerminalWorkspaceActionInWorker(action, input, user, context);
        const result = action === 'write'
            ? await writeTerminalFile(input, user, context)
            : action === 'read'
                ? await readTerminalFile(input, user, context)
                : await listTerminalFiles(input, user, context);
        return result;
    }
    return await executeTerminalCommand(input, user, context);
}

module.exports = { executeTerminalRuntime, isTerminalRuntimeAvailable, assertTerminalExecutionGrant, executionWorkspaceScopeId };
