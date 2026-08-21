const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

function sanitizeTaskId(value) {
    const text = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    return text || crypto.randomUUID();
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
            return target;
        },
        metadata: {
            platform: process.platform,
            osIsolation: process.platform === 'win32' ? 'job-object-best-effort' : 'process-group',
            networkIsolation: process.platform === 'linux' ? 'caller-must-provide-namespace' : 'policy-enforced'
        }
    };
}

function runSandboxedProcess(command, args = [], options = {}) {
    const jail = options.jail;
    const cwd = jail ? jail.resolve('.') : path.resolve(options.cwd || process.cwd());
    const timeoutMs = Math.max(Number(options.timeoutMs) || 30000, 100);
    const env = { ...process.env, ...(options.env || {}) };
    delete env.NODE_OPTIONS;
    return new Promise((resolve, reject) => {
        const child = spawn(command, args.map(String), {
            cwd,
            env,
            shell: false,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const stdout = [];
        const stderr = [];
        let settled = false;
        const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => stderr.push(chunk));
        const timer = setTimeout(() => {
            if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }
            else { try { child.kill('SIGKILL'); } catch (_) {} }
            const error = new Error(`沙箱进程超过 ${timeoutMs}ms 限时。`);
            error.code = 'AGENT_SANDBOX_TIMEOUT';
            error.category = 'timeout';
            finish(error);
        }, timeoutMs);
        child.on('error', error => finish(error));
        child.on('close', (code, signal) => finish(null, {
            code,
            signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            timedOut: false
        }));
        if (options.input !== undefined) child.stdin.end(String(options.input));
        else child.stdin.end();
    });
}

module.exports = { createWorkspaceJail, runSandboxedProcess, sanitizeTaskId };
