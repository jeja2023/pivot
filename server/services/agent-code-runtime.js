'use strict';

/*
 * 受控脚本计算执行面。
 * 代码永远不在服务端运行进程执行；它只被发送给已登记的不可变
 * 能力执行镜像使用固定的版本化输入输出协议。
 */
const {
    isWorkerEnabled,
    normalizeDefinition: normalizeWorkerDefinition,
    runCapabilityWorker,
    verifyWorkerSignature
} = require('./agent-capability-worker');
const { verifyExecutionGrant } = require('./agent-execution-grant');
const { consumeExecutionGrant } = require('./agent-execution-grant-ledger');

const MAX_CODE_BYTES = 256 * 1024;
const MAX_VARS_BYTES = 512 * 1024;
const MAX_TIMEOUT_MS = 120000;

function codeRuntimeError(message, code = 'AGENT_CODE_RUNTIME_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.category = 'policy';
    return error;
}

function codeWorkerDefinition(env = process.env) {
    const image = String(env.PIVOT_AGENT_CODE_WORKER_IMAGE || '').trim();
    if (!image) return null;
    return {
        image,
        command: String(env.PIVOT_AGENT_CODE_WORKER_COMMAND || 'node,/runner/runner.js')
            .split(',').map(item => item.trim()).filter(Boolean).slice(0, 8),
        limits: {
            cpu: Number(env.PIVOT_AGENT_CODE_WORKER_CPU || 1),
            memoryMb: Number(env.PIVOT_AGENT_CODE_WORKER_MEMORY_MB || 512),
            timeoutMs: Math.min(Math.max(Number(env.PIVOT_AGENT_CODE_WORKER_TIMEOUT_MS || 30000), 1000), MAX_TIMEOUT_MS),
            maxOutputBytes: Number(env.PIVOT_AGENT_CODE_WORKER_MAX_OUTPUT_BYTES || 1024 * 1024)
        }
    };
}

function normalizeCodeInput(input = {}) {
    const code = String(input.code || '');
    if (!code.trim()) throw codeRuntimeError('代码执行需要提供非空 code。', 'AGENT_CODE_REQUIRED');
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) throw codeRuntimeError(`代码不能超过 ${MAX_CODE_BYTES} 字节。`, 'AGENT_CODE_LIMIT', 413);
    const vars = input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars) ? input.vars : {};
    let serialized;
    try { serialized = JSON.stringify(vars); } catch (_) { throw codeRuntimeError('代码变量必须为可序列化对象。', 'AGENT_CODE_VARS_INVALID'); }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_VARS_BYTES) throw codeRuntimeError(`代码变量不能超过 ${MAX_VARS_BYTES} 字节。`, 'AGENT_CODE_VARS_LIMIT', 413);
    const timeoutMs = Math.min(Math.max(Number(input.timeoutMs ?? input.timeout_ms) || 30000, 1000), MAX_TIMEOUT_MS);
    return { code, vars, timeoutMs };
}

function codeWorkspaceScopeId(context = {}) {
    const runId = String(context.run?.id || context.runId || context.node?.id || '').trim();
    return String(context.executionWorkspaceScopeId || (runId ? `run:${runId}` : '')).slice(0, 160);
}

function createAgentCodeRuntime(deps = {}) {
    const verifyGrant = deps.verifyExecutionGrant || verifyExecutionGrant;
    const consumeGrant = deps.consumeExecutionGrant || consumeExecutionGrant;
    const runWorker = deps.runCapabilityWorker || runCapabilityWorker;
    const normalizeDefinition = deps.normalizeWorkerDefinition || normalizeWorkerDefinition;
    const workerEnabled = deps.isWorkerEnabled || isWorkerEnabled;

    async function executeAgentCode(input = {}, user = null, context = {}) {
        const normalized = normalizeCodeInput(input);
        const env = context.env || process.env;
        const worker = codeWorkerDefinition(env);
        if (!worker || !workerEnabled(env)) {
            throw codeRuntimeError('代码执行需要已启用、镜像摘要固定的 Capability Worker；宿主进程后备已被禁止。', 'AGENT_CODE_WORKER_REQUIRED', 503);
        }
        let normalizedWorker;
        try { normalizedWorker = normalizeDefinition(worker); } catch (error) {
            throw codeRuntimeError(error.message || '代码 Worker 配置无效。', error.code || 'AGENT_CODE_WORKER_INVALID', error.status || 503);
        }
        try { verifyWorkerSignature(normalizedWorker, { env }); } catch (error) {
            throw codeRuntimeError(error.message || '代码 Worker 生产信任清单校验失败。', error.code || 'AGENT_CODE_WORKER_UNTRUSTED', error.status || 503);
        }
        const runId = String(context.run?.id || context.runId || context.node?.id || '').trim();
        const workspaceScopeId = codeWorkspaceScopeId(context);
        if (!runId || !workspaceScopeId || !user?.id) {
            throw codeRuntimeError('代码执行必须关联用户、运行和工作区授权范围。', 'AGENT_EXECUTION_GRANT_CONTEXT_INVALID', 403);
        }
        let executionGrant;
        try {
            executionGrant = verifyGrant(context.executionGrant, {
                runId,
                userId: user.id,
                tool: 'agent.code',
                input,
                workspaceScopeId
            }, { env });
        } catch (error) {
            throw codeRuntimeError(error.message || '代码执行授权无效。', error.code || 'AGENT_EXECUTION_GRANT_INVALID', error.status || 403);
        }
        try {
            await consumeGrant({
                token: context.executionGrant,
                payload: executionGrant.payload,
                consumer: `agent.code:${process.pid}`
            });
        } catch (error) {
            throw codeRuntimeError(error.message || '代码执行授权账本校验失败。', error.code || 'AGENT_EXECUTION_GRANT_UNAVAILABLE', error.status || 403);
        }
        let output;
        try {
            output = await runWorker(worker, {
                version: 1,
                action: 'code',
                code: normalized.code,
                vars: normalized.vars,
                timeoutMs: normalized.timeoutMs
            }, {
                env,
                signal: context.signal || null,
                requireExecutionGrant: true,
                executionGrant: context.executionGrant,
                executionGrantExpected: { runId, userId: user.id, tool: 'agent.code', input, workspaceScopeId }
            });
        } catch (error) {
            throw codeRuntimeError(error.message || '代码 Capability Worker 执行失败。', error.code || 'AGENT_CODE_WORKER_FAILED', error.status || 502);
        }
        if (!output || typeof output !== 'object' || output.ok !== true || !Object.hasOwn(output, 'result')) {
            throw codeRuntimeError(output?.error?.message || '代码 Capability Worker 返回格式无效。', output?.error?.code || 'AGENT_CODE_WORKER_OUTPUT_INVALID', 502);
        }
        let text = '';
        try { text = typeof output.result === 'string' ? output.result : JSON.stringify(output.result); } catch (_) { text = '[结构化结果无法序列化]'; }
        return {
            result: output.result,
            text: text.slice(0, 12000),
            worker: {
                provider: 'capability-worker',
                executionGrant: executionGrant.summary,
                isolation: { enforcement: 'enforced', filesystem: 'container-no-host-mount', process: 'container', network: 'none' }
            }
        };
    }

    return { executeAgentCode };
}

const defaultRuntime = createAgentCodeRuntime();

module.exports = {
    MAX_CODE_BYTES,
    MAX_TIMEOUT_MS,
    MAX_VARS_BYTES,

    createAgentCodeRuntime,
    executeAgentCode: defaultRuntime.executeAgentCode,
    normalizeCodeInput
};
