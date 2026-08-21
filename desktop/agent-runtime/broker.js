const path = require('path');
const { createWorkspaceJail, runSandboxedProcess } = require('../../server/services/agent-sandbox');

function assertWorkerConfiguration(request = {}) {
    if (request.approved !== true) {
        const error = new Error('桌面 Worker 执行必须先完成审批。');
        error.code = 'AGENT_DESKTOP_APPROVAL_REQUIRED';
        throw error;
    }
    if (request.networkEnabled === true && request.networkPolicy?.allowed_origins?.length === 0) {
        const error = new Error('桌面 Worker 网络执行必须绑定非空 allowlist。');
        error.code = 'AGENT_NETWORK_POLICY_REQUIRED';
        throw error;
    }
}

async function runDesktopWorker(request = {}) {
    assertWorkerConfiguration(request);
    const workspaceRoot = String(request.workspaceRoot || '').trim();
    if (!workspaceRoot) throw new Error('桌面 Worker 必须绑定工作区根目录。');
    const jail = createWorkspaceJail(workspaceRoot, request.taskId || 'agent-worker');
    const workerPath = path.join(__dirname, 'worker.js');
    const result = await runSandboxedProcess(process.execPath, [workerPath], {
        jail,
        timeoutMs: Math.min(Math.max(Number(request.timeoutMs) || 30000, 100), 10 * 60 * 1000),
        input: JSON.stringify({ ...request, workspaceRoot, taskId: request.taskId || 'agent-worker' }),
        env: { PIVOT_AGENT_WORKER: '1' }
    });
    let message = null;
    try { message = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).pop() || '{}'); } catch (_) {}
    if (!message?.ok) {
        const error = new Error(message?.error?.message || result.stderr || '桌面 Worker 执行失败。');
        error.code = message?.error?.code || 'AGENT_WORKER_FAILED';
        error.worker = result;
        throw error;
    }
    return { ...message.result, worker: result, jail: jail.metadata };
}

module.exports = { runDesktopWorker, assertWorkerConfiguration };
