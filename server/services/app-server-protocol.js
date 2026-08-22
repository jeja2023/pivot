const {
    cancelAgentRun,
    createAgentRun
} = require('./agent-runtime');
const { replayAgentEventsForUser } = require('./agent-event-log');
const { sendAgentControlMessage } = require('./agent-control');

const JSON_RPC_ERRORS = Object.freeze({
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603
});

function rpcError(code, message, data = undefined) {
    const error = new Error(message);
    error.rpcCode = code;
    error.data = data;
    return error;
}

function requireString(value, field) {
    const text = String(value || '').trim();
    if (!text) throw rpcError(JSON_RPC_ERRORS.invalidParams, `${field} 不能为空。`);
    return text;
}

function createAppServerProtocol({ services = {} } = {}) {
    const runtime = services.createAgentRun || createAgentRun;
    const cancel = services.cancelAgentRun || cancelAgentRun;
    const replay = services.replayAgentEventsForUser || replayAgentEventsForUser;
    const sendControl = services.sendAgentControlMessage || sendAgentControlMessage;
    const residency = services.residency || null;

    async function touchResidency(input, user, run, goal, threadId = '') {
        const residentKey = input.residentKey || input.resident_key || input.agentKey || input.agent_key;
        if (!residency || !residentKey) return null;
        return await residency.touchResident({
            user,
            residentKey,
            runId: run?.id || null,
            status: 'active',
            state: {
                schemaVersion: 1,
                goal: String(goal || '').slice(0, 4000),
                runId: String(run?.id || ''),
                threadId: String(threadId || ''),
                runStatus: String(run?.status || 'queued')
            }
        });
    }

    async function dispatch(method, params = {}, user) {
        const input = params && typeof params === 'object' ? params : {};
        if (!user?.id) throw rpcError(401, '需要登录后才能使用 App Server 协议。');
        switch (String(method || '').trim()) {
        case 'thread/start': {
            const goal = requireString(input.goal || input.prompt, 'goal');
            const run = await runtime({
                user,
                goal,
                modelId: input.modelId || input.model_id,
                title: input.title,
                runMode: input.runMode || input.run_mode,
                toolPolicy: input.toolPolicy || input.tool_policy,
                approvalPolicy: input.approvalPolicy || input.approval_policy,
                budgetConfig: input.budgetConfig || input.budget_config,
                metadata: { ...(input.metadata || {}), appServer: true }
            });
            const resident = await touchResidency(input, user, run, goal, run.id);
            return { thread: { id: run.id, status: run.status }, run, ...(resident ? { resident } : {}) };
        }
        case 'turn/start': {
            const goal = requireString(input.goal || input.prompt, 'goal');
            const run = await runtime({
                user,
                goal,
                sessionId: input.sessionId || input.session_id || null,
                modelId: input.modelId || input.model_id,
                runMode: input.runMode || input.run_mode,
                toolPolicy: input.toolPolicy || input.tool_policy,
                approvalPolicy: input.approvalPolicy || input.approval_policy,
                budgetConfig: input.budgetConfig || input.budget_config,
                metadata: { ...(input.metadata || {}), appServer: true, threadId: input.threadId || input.thread_id || '' },
                parentRunId: input.parentRunId || input.parent_run_id || null
            });
            const threadId = input.threadId || input.thread_id || run.id;
            const resident = await touchResidency(input, user, run, goal, threadId);
            return { turn: { id: run.id, threadId }, run, ...(resident ? { resident } : {}) };
        }
        case 'turn/steer': {
            const toRunId = requireString(input.runId || input.run_id || input.turnId || input.turn_id, 'runId');
            const message = requireString(input.message || input.goal || input.prompt, 'message');
            const control = await sendControl({
                user,
                fromRunId: input.fromRunId || input.from_run_id || toRunId,
                toRunId,
                type: 'steer',
                payload: { message, source: 'app_server' },
                expiresAt: input.expiresAt || input.expires_at || null
            });
            return { accepted: true, control };
        }
        case 'turn/interrupt': {
            const runId = requireString(input.runId || input.run_id || input.turnId || input.turn_id, 'runId');
            const run = await cancel(runId, user);
            if (!run) throw rpcError(404, '运行不存在或不可中断。');
            return { interrupted: true, run };
        }
        case 'turn/events': {
            const runId = requireString(input.runId || input.run_id || input.turnId || input.turn_id, 'runId');
            return await replay(runId, user, {
                after: input.after || input.afterSeq || 0,
                limit: input.limit,
                types: input.types || input.type || []
            });
        }
        case 'agent/residency/list': {
            if (!residency) throw rpcError(JSON_RPC_ERRORS.internal, 'Agent residency 未配置。');
            return {
                residents: await residency.listResidents({
                    user,
                    status: input.status,
                    limit: input.limit
                })
            };
        }
        case 'agent/residency/evict': {
            if (!residency) throw rpcError(JSON_RPC_ERRORS.internal, 'Agent residency 未配置。');
            const residentKey = input.residentKey || input.resident_key || input.agentKey || input.agent_key;
            if (!residentKey && !input.residentId && !input.resident_id) throw rpcError(JSON_RPC_ERRORS.invalidParams, 'residentKey 或 residentId 不能为空。');
            const resident = await residency.evictResident({
                user,
                residentKey,
                residentId: input.residentId || input.resident_id
            });
            if (!resident) throw rpcError(404, '常驻 Agent 不存在。');
            return { evicted: true, resident };
        }
        case 'agent/residency/acquire': {
            if (!residency) throw rpcError(JSON_RPC_ERRORS.internal, 'Agent residency 未配置。');
            const residentKey = input.residentKey || input.resident_key || input.agentKey || input.agent_key;
            const leaseOwner = requireString(input.leaseOwner || input.lease_owner, 'leaseOwner');
            const resident = await residency.acquireResidentLease({ user, residentKey, leaseOwner, leaseMs: input.leaseMs || input.lease_ms });
            if (!resident) throw rpcError(409, '常驻 Agent 当前不可领取，可能已过期或被其他工作进程租用。');
            return { acquired: true, resident };
        }
        case 'agent/residency/release': {
            if (!residency) throw rpcError(JSON_RPC_ERRORS.internal, 'Agent residency 未配置。');
            const residentKey = input.residentKey || input.resident_key || input.agentKey || input.agent_key;
            const leaseOwner = input.leaseOwner || input.lease_owner || '';
            const resident = await residency.releaseResidentLease({ user, residentKey, residentId: input.residentId || input.resident_id, leaseOwner });
            if (!resident) throw rpcError(404, '常驻 Agent 或租约不存在。');
            return { released: true, resident };
        }
        case 'agent/residency/sweep': {
            if (!residency) throw rpcError(JSON_RPC_ERRORS.internal, 'Agent residency 未配置。');
            return { evicted: await residency.sweepResidents({ userId: user.id }) };
        }
        default:
            throw rpcError(JSON_RPC_ERRORS.methodNotFound, `不支持的 App Server 方法：${method}`);
        }
    }

    async function handle(request, user) {
        if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
            throw rpcError(JSON_RPC_ERRORS.invalidRequest, 'JSON-RPC 请求格式无效。');
        }
        const result = await dispatch(request.method, request.params || {}, user);
        return request.id === undefined ? null : { jsonrpc: '2.0', id: request.id, result };
    }

    return { dispatch, handle };
}

module.exports = { JSON_RPC_ERRORS, createAppServerProtocol, rpcError };
