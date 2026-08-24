const { enforceToolPolicy } = require('./agent-policy');
const {
    beginAgentToolCheckpoint,
    completeAgentToolCheckpoint,
    failAgentToolCheckpoint,
    checkpointInputHash
} = require('./agent-checkpoints');
const { recordAgentEvent } = require('./agent-event-log');
const { summarizeToolExecutionPlan } = require('./agent-tool-execution-plan');

function operationKeyFor({ run, tool, input, context = {} }) {
    const runId = run?.id || context.runId;
    if (!runId) return '';
    const hash = checkpointInputHash(input);
    return String(context.operationKey || `${runId}:${context.stepId || context.node?.id || 'step'}:${tool.name}:${hash}`);
}

function createToolOrchestrator(overrides = {}) {
    const policyEvaluator = overrides.enforceToolPolicy || enforceToolPolicy;
    const beginCheckpoint = overrides.beginAgentToolCheckpoint || beginAgentToolCheckpoint;
    const completeCheckpoint = overrides.completeAgentToolCheckpoint || completeAgentToolCheckpoint;
    const failCheckpoint = overrides.failAgentToolCheckpoint || failAgentToolCheckpoint;
    const emitEvent = overrides.recordAgentEvent || recordAgentEvent;

    async function event(type, request, payload = {}) {
        if (typeof emitEvent !== 'function' || !request?.run?.id) return;
        try {
            await emitEvent({
                runId: request.run.id,
                userId: request.run.user_id || request.user?.id || null,
                turnId: request.context?.stepContext?.turnId || request.context?.turnId || '',
                stepIndex: request.context?.stepContext?.stepIndex || request.context?.stepIndex || 0,
                type,
                eventKey: request.operationKey || '',
                payload: {
                    tool: request.tool.name,
                    operationKey: request.operationKey || '',
                    contextHash: request.context?.stepContext?.contextHash || '',
                    ...payload
                }
            });
        } catch (_) {
            // Event logging is an audit side channel and must not mask the tool outcome.
        }
    }

    async function execute(request = {}) {
        const {
            run = {}, tool = {}, input = {}, user = null, context = {}, execute, executionPlan = null
        } = request;
        if (typeof execute !== 'function') throw new Error('ToolOrchestrator 缺少实际工具执行器。');
        let policy;
        if (executionPlan?.network?.preflight === 'denied') {
            const error = new Error(executionPlan.network.error?.message || '工具网络预检被策略拒绝。');
            error.code = executionPlan.network.error?.code || 'AGENT_NETWORK_POLICY_DENIED';
            error.category = 'policy';
            await event('tool.denied', request, { errorCode: error.code, errorMessage: error.message, executionPlan: summarizeToolExecutionPlan(executionPlan) });
            throw error;
        }
        if (executionPlan?.sandbox?.preflight === 'denied') {
            const error = new Error(executionPlan.sandbox.error?.message || '工具沙箱预检被策略拒绝。');
            error.code = executionPlan.sandbox.error?.code || 'AGENT_SANDBOX_REQUIRED';
            error.category = 'policy';
            await event('sandbox.denied', request, { errorCode: error.code, errorMessage: error.message, executionPlan: summarizeToolExecutionPlan(executionPlan) });
            throw error;
        }
        try {
            policy = policyEvaluator({
                run,
                tool,
                input,
                user,
                budget: context.budgetAlreadyConsumed === true ? null : (context.budget || null),
                allowApproval: context.allowApproval === true || context.approvalGranted === true
            });
        } catch (error) {
            const deniedRequest = { ...request, operationKey: '' };
            await event('tool.denied', deniedRequest, {
                errorCode: String(error?.code || 'AGENT_POLICY_DENIED'),
                errorMessage: String(error?.message || '').slice(0, 500)
            });
            throw error;
        }
        const effectiveInput = policy?.input || input;
        const operationKey = operationKeyFor({ run, tool, input: effectiveInput, context });
        const requestWithKey = { ...request, operationKey };
        await event('tool.requested', requestWithKey, {
            policyDecision: policy?.decision || 'allow',
            riskLevel: Number(tool.risk_level || tool.riskLevel || 0) || 0,
            executionPlan: summarizeToolExecutionPlan(executionPlan || {})
        });

        let checkpoint = { replay: false };
        try {
            if (operationKey) {
                checkpoint = await beginCheckpoint(run.id, {
                    operationKey,
                    stepIndex: context.stepIndex || context.step || 0,
                    toolName: tool.name,
                    input: effectiveInput,
                    inputHash: checkpointInputHash(effectiveInput),
                    idempotent: tool.idempotent,
                    approvalGranted: context.approvalGranted === true
                });
            }
        } catch (error) {
            await event('tool.failed', requestWithKey, {
                errorCode: String(error?.code || 'AGENT_CHECKPOINT_FAILED'),
                errorCategory: String(error?.category || 'recovery'),
                errorMessage: String(error?.message || '').slice(0, 500)
            });
            throw error;
        }
        if (checkpoint?.replay) {
            await event('tool.replayed', requestWithKey, { checkpointId: checkpoint.checkpointId || '' });
            return checkpoint.output;
        }

        try {
            const output = await execute({
                ...request,
                operationKey,
                input: effectiveInput,
                policy
            });
            if (operationKey) await completeCheckpoint(operationKey, output);
            await event('tool.completed', requestWithKey, { output: output && typeof output === 'object' ? { completed: true } : undefined });
            return output;
        } catch (error) {
            if (operationKey) {
                try { await failCheckpoint(operationKey, error); } catch (_) {}
            }
            const eventType = ['AGENT_SANDBOX_REQUIRED', 'AGENT_SANDBOX_DENIED', 'AGENT_WORKSPACE_DENIED'].includes(error?.code)
                ? 'sandbox.denied'
                : 'tool.failed';
            await event(eventType, requestWithKey, {
                errorCode: String(error?.code || ''),
                errorCategory: String(error?.category || ''),
                errorMessage: String(error?.message || '').slice(0, 500)
            });
            throw error;
        }
    }

    return { execute };
}

const defaultToolOrchestrator = createToolOrchestrator();

module.exports = {
    createToolOrchestrator,
    defaultToolOrchestrator,
    operationKeyFor
};
