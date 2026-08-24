const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const { isolationMetadata, prepareProcessIsolation } = require('./agent-os-isolation');

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = Math.max(
    1024,
    Number.parseInt(process.env.PIVOT_AGENT_SANDBOX_MAX_OUTPUT_BYTES || String(DEFAULT_MAX_OUTPUT_BYTES), 10) || DEFAULT_MAX_OUTPUT_BYTES
);

let cachedCanUnshare = null;
function canUseUnshare(unsharePath) {
    if (cachedCanUnshare !== null) return cachedCanUnshare;
    try {
        const res = spawnSync(unsharePath, ['--net', 'true'], { stdio: 'ignore', timeout: 1000 });
        cachedCanUnshare = res.status === 0;
    } catch (_) {
        cachedCanUnshare = false;
    }
    return cachedCanUnshare;
}

function prepareCommand(command, args, isolation) {
    if (process.platform !== 'linux' || isolation?.spec?.networkDisabled !== true) return { command, args };
    const unshare = ['/usr/bin/unshare', '/bin/unshare'].find(candidate => fs.existsSync(candidate));
    if (!unshare || !canUseUnshare(unshare)) {
        if (isolation?.spec?.strict) {
            const error = new Error('Linux network namespace 工具不可用或权限不足，严格网络隔离无法启动。');
            error.code = 'AGENT_NETWORK_NAMESPACE_UNAVAILABLE';
            error.category = 'network';
            throw error;
        }
        return { command, args };
    }
    return { command: unshare, args: ['--net', '--', command, ...args] };
}

function sanitizeTaskId(value) {
    const text = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    return text || crypto.randomUUID();
}

function assertRealPathInside(workspace, target) {
    let existing = target;
    const suffix = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        suffix.unshift(path.basename(existing));
        existing = parent;
    }
    const realWorkspace = fs.realpathSync(workspace);
    const realExisting = fs.realpathSync(existing);
    const realTarget = path.join(realExisting, ...suffix);
    const relative = path.relative(realWorkspace, realTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        const error = new Error('工作区符号链接越权访问被沙箱拦截。');
        error.code = 'AGENT_WORKSPACE_SYMLINK_ESCAPE';
        error.category = 'permission';
        throw error;
    }
}

function createWorkspaceJail(root, taskId) {
    const base = path.resolve(root);
    const workspace = path.join(base, sanitizeTaskId(taskId));
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return {
        root: base,
        workspace,
        resolve(relativePath = '') {
            const target = path.resolve(workspace, String(relativePath || ''));
            const relative = path.relative(workspace, target);
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                const error = new Error('工作区越权访问被沙箱拦截。');
                error.code = 'AGENT_WORKSPACE_ESCAPE';
                error.category = 'permission';
                throw error;
            }
            try { assertRealPathInside(workspace, target); } catch (error) {
                if (!error.code) {
                    error.code = 'AGENT_WORKSPACE_SYMLINK_ESCAPE';
                    error.category = 'permission';
                }
                throw error;
            }
            return target;
        },
        metadata: {
            platform: process.platform,
            osIsolation: process.platform === 'win32' ? 'windows-job-object' : process.platform === 'linux' ? 'linux-cgroup' : 'process-tree',
            networkIsolation: process.platform === 'linux' ? 'network-namespace-requested' : 'policy-enforced'
        }
    };
}

function runSandboxedProcess(command, args = [], options = {}) {
    const jail = options.jail;
    const cwd = jail ? jail.resolve('.') : path.resolve(options.cwd || process.cwd());
    const timeoutMs = Math.max(Number(options.timeoutMs) || 30000, 100);
    const maxBufferBytes = Math.max(
        1024,
        Number.parseInt(options.maxBufferBytes ?? MAX_OUTPUT_BYTES, 10) || MAX_OUTPUT_BYTES
    );
    const isolation = options.isolation || prepareProcessIsolation({
        strictIsolation: options.strictIsolation === true,
        networkDisabled: options.networkDisabled === true,
        memoryLimitBytes: options.memoryLimitBytes
    });
    const env = { ...process.env, ...(options.env || {}) };
    delete env.NODE_OPTIONS;
    return new Promise((resolve, reject) => {
        let processCommand;
        try { processCommand = prepareCommand(command, args.map(String), isolation); } catch (error) { isolation.cleanup(); reject(error); return; }
        const child = spawn(processCommand.command, processCommand.args, {
            cwd,
            env,
            shell: false,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let timer;
        let outputLimitTriggered = false;
        let pendingTerminationError = null;
        const appendOutput = (target, chunk, totalBytes) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            const remaining = Math.max(0, maxBufferBytes - totalBytes);
            if (remaining > 0) target.push(buffer.subarray(0, remaining));
            return buffer.length;
        };
        const terminateChild = () => {
            if (process.platform !== 'win32') {
                try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
            } else {
                try { child.kill('SIGKILL'); } catch (_) {}
            }
        };
        const triggerOutputLimit = (streamName, totalBytes) => {
            if (outputLimitTriggered || settled) return;
            outputLimitTriggered = true;
            terminateChild();
            const error = new Error(`沙箱进程${streamName === 'stderr' ? '错误' : '标准'}输出超过 ${maxBufferBytes} 字节限制。`);
            error.code = 'AGENT_SANDBOX_OUTPUT_LIMIT_EXCEEDED';
            error.category = 'resource';
            error.stream = streamName;
            error.outputBytes = totalBytes;
            error.maxBufferBytes = maxBufferBytes;
            error.stdout = Buffer.concat(stdout).toString('utf8');
            error.stderr = Buffer.concat(stderr).toString('utf8');
            pendingTerminationError = error;
        };
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { isolationHelper?.kill(); } catch (_) {}
            isolation.cleanup();
            if (error && outputLimitTriggered) {
                error.stdout = error.stdout ?? Buffer.concat(stdout).toString('utf8');
                error.stderr = error.stderr ?? Buffer.concat(stderr).toString('utf8');
            }
            error ? reject(error) : resolve(result);
        };
        let isolationHelper = null;
        try {
            isolationHelper = isolation.attach(child.pid);
        } catch (error) {
            try { child.kill('SIGKILL'); } catch (_) {}
            isolation.cleanup();
            finish(error);
            return;
        }
        child.stdout.on('data', chunk => {
            const bytes = appendOutput(stdout, chunk, stdoutBytes + stderrBytes);
            stdoutBytes += bytes;
            if (stdoutBytes + stderrBytes > maxBufferBytes) triggerOutputLimit('stdout', stdoutBytes + stderrBytes);
        });
        child.stderr.on('data', chunk => {
            const bytes = appendOutput(stderr, chunk, stdoutBytes + stderrBytes);
            stderrBytes += bytes;
            if (stdoutBytes + stderrBytes > maxBufferBytes) triggerOutputLimit('stderr', stdoutBytes + stderrBytes);
        });
        timer = setTimeout(() => {
            if (outputLimitTriggered && pendingTerminationError) {
                terminateChild();
                finish(pendingTerminationError);
                return;
            }
            terminateChild();
            const error = new Error(`沙箱进程超过 ${timeoutMs}ms 限时。`);
            error.code = 'AGENT_SANDBOX_TIMEOUT';
            error.category = 'timeout';
            finish(error);
        }, timeoutMs);
        child.on('error', error => {
            if (pendingTerminationError) return;
            finish(error);
        });
        child.on('close', (code, signal) => finish(pendingTerminationError, {
            code,
            signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            timedOut: false,
            isolation: isolationMetadata(isolation)
        }));
        if (options.input !== undefined) child.stdin.end(String(options.input));
        else child.stdin.end();
    });
}

module.exports = { createWorkspaceJail, runSandboxedProcess, sanitizeTaskId };
