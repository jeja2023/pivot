const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sanitizeTaskId } = require('../server/services/agent-sandbox');

const DEFAULT_APPROVAL_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_APPROVALS = 128;
const MAX_WORKER_INPUT_BYTES = 64 * 1024;
const MAX_WORKER_ARGUMENTS = 32;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function workerSecurityError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function configuredWorkerCommands(env = process.env) {
    return new Set(String(env.AGENT_WORKER_COMMAND_ALLOWLIST || 'node,python,python3')
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean));
}

function isSecureWorkerRendererUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || ''));
    } catch (_error) {
        return false;
    }
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

function assertPathInside(root, target) {
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw workerSecurityError('Worker 脚本必须位于当前任务工作区内。', 'AGENT_WORKER_SCRIPT_OUTSIDE_WORKSPACE');
    }
}

function normalizeWorkerRequest(payload = {}, { workspaceRoot, env = process.env, requireExistingScript = true } = {}) {
    const trustedRoot = path.resolve(String(workspaceRoot || ''));
    if (!workspaceRoot) {
        throw workerSecurityError('主进程未配置 Worker 工作区。', 'AGENT_WORKER_ROOT_REQUIRED');
    }

    const command = String(payload.command || '').trim().toLowerCase();
    if (!command || command.includes('/') || command.includes('\\') || !configuredWorkerCommands(env).has(command)) {
        throw workerSecurityError('Worker 命令不在允许列表中。', 'AGENT_WORKER_COMMAND_DENIED');
    }
    if (payload.networkEnabled === true) {
        throw workerSecurityError('通用进程 Worker 禁止联网；请使用受治理的 HTTP/MCP 工具。', 'AGENT_WORKER_NETWORK_DENIED');
    }

    const rawArgs = Array.isArray(payload.args) ? payload.args : [];
    if (rawArgs.length < 1 || rawArgs.length > MAX_WORKER_ARGUMENTS) {
        throw workerSecurityError('Worker 必须提供一个工作区脚本，且参数数量不能超过 32 个。', 'AGENT_WORKER_ARGUMENTS_INVALID');
    }
    const args = rawArgs.map(value => String(value));
    if (args.some(value => value.includes('\0') || value.length > 4096)) {
        throw workerSecurityError('Worker 参数包含非法内容或长度超限。', 'AGENT_WORKER_ARGUMENTS_INVALID');
    }

    const scriptArg = args[0];
    if (!scriptArg || scriptArg.startsWith('-') || path.isAbsolute(scriptArg)) {
        throw workerSecurityError('Worker 不允许解释器内联执行或绝对脚本路径。', 'AGENT_WORKER_INLINE_CODE_DENIED');
    }
    const extension = path.extname(scriptArg).toLowerCase();
    const expectedExtensions = command === 'node'
        ? new Set(['.js', '.cjs', '.mjs'])
        : new Set(['.py']);
    if (!expectedExtensions.has(extension)) {
        throw workerSecurityError('Worker 脚本扩展名与解释器不匹配。', 'AGENT_WORKER_SCRIPT_TYPE_INVALID');
    }

    const taskId = sanitizeTaskId(payload.taskId || 'agent-worker');
    const workspace = path.join(trustedRoot, taskId);
    const scriptPath = path.resolve(workspace, scriptArg);
    assertPathInside(workspace, scriptPath);
    if (requireExistingScript) {
        let stat;
        try {
            stat = fs.statSync(scriptPath);
            const realWorkspace = fs.realpathSync(workspace);
            const realScript = fs.realpathSync(scriptPath);
            assertPathInside(realWorkspace, realScript);
        } catch (error) {
            if (error.code && String(error.code).startsWith('AGENT_')) throw error;
            throw workerSecurityError('Worker 脚本不存在或无法安全读取。', 'AGENT_WORKER_SCRIPT_UNAVAILABLE');
        }
        if (!stat.isFile()) {
            throw workerSecurityError('Worker 执行目标必须是普通文件。', 'AGENT_WORKER_SCRIPT_INVALID');
        }
    }

    const input = payload.input === undefined ? '' : String(payload.input);
    if (Buffer.byteLength(input, 'utf8') > MAX_WORKER_INPUT_BYTES) {
        throw workerSecurityError('Worker 输入超过 64KB 限制。', 'AGENT_WORKER_INPUT_TOO_LARGE');
    }

    return {
        command,
        args,
        taskId,
        input,
        timeoutMs: Math.min(Math.max(Number(payload.timeoutMs) || 30000, 100), 10 * 60 * 1000),
        networkEnabled: false,
        workspaceRoot: trustedRoot
    };
}

function workerRequestFingerprint(request) {
    return crypto.createHash('sha256').update(JSON.stringify({
        command: request.command,
        args: request.args,
        taskId: request.taskId,
        input: request.input,
        timeoutMs: request.timeoutMs,
        networkEnabled: false,
        workspaceRoot: path.resolve(request.workspaceRoot)
    })).digest('hex');
}

function createWorkerApprovalStore({ ttlMs = DEFAULT_APPROVAL_TTL_MS, maxEntries = DEFAULT_MAX_APPROVALS, now = () => Date.now() } = {}) {
    const approvals = new Map();

    function prune() {
        const current = now();
        for (const [token, entry] of approvals) {
            if (entry.expiresAt <= current) approvals.delete(token);
        }
        while (approvals.size >= maxEntries) approvals.delete(approvals.keys().next().value);
    }

    return {
        issue(request) {
            prune();
            const token = crypto.randomBytes(32).toString('base64url');
            const expiresAt = now() + ttlMs;
            approvals.set(token, { fingerprint: workerRequestFingerprint(request), expiresAt });
            return { token, expiresAt };
        },
        consume(token, request) {
            prune();
            const cleanToken = String(token || '');
            const entry = approvals.get(cleanToken);
            approvals.delete(cleanToken);
            if (!entry || entry.expiresAt <= now()) {
                throw workerSecurityError('Worker 审批不存在、已使用或已过期。', 'AGENT_WORKER_APPROVAL_INVALID');
            }
            const expected = Buffer.from(entry.fingerprint, 'hex');
            const actual = Buffer.from(workerRequestFingerprint(request), 'hex');
            if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
                throw workerSecurityError('Worker 请求与已批准内容不一致。', 'AGENT_WORKER_APPROVAL_MISMATCH');
            }
            return true;
        },
        size() {
            prune();
            return approvals.size;
        }
    };
}

module.exports = {
    DEFAULT_APPROVAL_TTL_MS,
    MAX_WORKER_ARGUMENTS,
    MAX_WORKER_INPUT_BYTES,
    createWorkerApprovalStore,
    isSecureWorkerRendererUrl,
    normalizeWorkerRequest,
    workerRequestFingerprint
};
