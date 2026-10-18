const { enforceToolPolicy } = require('./agent-policy');
const {
    beginAgentToolCheckpoint,
    completeAgentToolCheckpoint,
    failAgentToolCheckpoint,
    checkpointInputHash
} = require('./agent-checkpoints');
const { recordAgentEvent } = require('./agent-event-log');
const { summarizeToolExecutionPlan } = require('./agent-tool-execution-plan');
const { buildAgentAuditFields } = require('./agent-step-context');
const { issueToolExecutionGrant } = require('./agent-execution-grant');
const { registerExecutionGrant } = require('./agent-execution-grant-ledger');
const { beginPreviewTaskEffect, recordPreviewTaskEffect, stageDeferredToolEffect } = require('./agent-task-effect-executor');
const { invokeAgentLifecycleHooks } = require('./agent-lifecycle-hooks');
const { assertPreviewToolAllowed } = require('./agent-dag-execution-guard');

function operationKeyFor({ run, tool, input, context = {} }) {
    const runId = run?.id || context.runId;
    if (!runId) return '';
    const hash = checkpointInputHash(input);
    return String(context.operationKey || `${runId}:${context.stepId || context.node?.id || 'step'}:${tool.name}:${hash}`);
}

function isWorkspaceMutation(tool = {}, input = {}) {
    const name = String(tool.name || '').trim();
    if (name === 'terminal.runtime') return ['write', 'exec'].includes(String(input.action || 'exec').toLowerCase());
    return new Set([
        'workspace.patch', 'workspace.install', 'workspace.git_worktree', 'workspace.git_worktree_remove',
        'workspace.git_merge', 'workspace.git_abort_merge', 'workspace.git_commit', 'workspace.git_push', 'workspace.git_pr'
    ]).has(name);
}

function lifecycleHookPayload(payload = {}, context = {}) {
    const scopes = context.authorizedScopes || context.authorized_scopes || context.agentScopes || context.agent_scopes || [];
    const authorization = payload.authorization && typeof payload.authorization === 'object' && !Array.isArray(payload.authorization)
        ? payload.authorization : {};
    return { ...payload, authorization: { ...authorization, scopes } };
}

function createToolOrchestrator(overrides = {}) {
    const policyEvaluator = overrides.enforceToolPolicy || enforceToolPolicy;
    const beginCheckpoint = overrides.beginAgentToolCheckpoint || beginAgentToolCheckpoint;
    const completeCheckpoint = overrides.completeAgentToolCheckpoint || completeAgentToolCheckpoint;
    const failCheckpoint = overrides.failAgentToolCheckpoint || failAgentToolCheckpoint;
    const emitEvent = overrides.recordAgentEvent || recordAgentEvent;
    const issueGrant = overrides.issueToolExecutionGrant || issueToolExecutionGrant;
    const registerGrant = overrides.registerExecutionGrant || registerExecutionGrant;
    const stageEffect = overrides.stageDeferredToolEffect || stageDeferredToolEffect;
    const beginPreviewEffect = overrides.beginPreviewTaskEffect || beginPreviewTaskEffect;
    const recordPreviewEffect = overrides.recordPreviewTaskEffect || recordPreviewTaskEffect;
    const invokeHooks = overrides.invokeAgentLifecycleHooks || invokeAgentLifecycleHooks;

    async function event(type, request, payload = {}) {
        if (typeof emitEvent !== 'function' || !request?.run?.id) return;
        try {
            const stepContext = {
                ...(request.context?.stepContext || {}),
                runId: request.run.id,
                entrypoint: request.context?.entrypoint || request.context?.stepContext?.entrypoint || 'agent'
            };
            await emitEvent({
                runId: request.run.id,
                userId: request.run.user_id || request.user?.id || null,
                turnId: request.context?.stepContext?.turnId || request.context?.turnId || '',
                stepIndex: request.context?.stepContext?.stepIndex || request.context?.stepIndex || 0,
                type,
                eventKey: request.operationKey || '',
                payload: {
                    ...buildAgentAuditFields(stepContext, { purpose: type }),
                    tool: request.tool.name,
                    operationKey: request.operationKey || '',
                    ...payload
                }
            });
        } catch (_) {
            // Event logging is an audit side channel and must not mask the tool outcome.
        }
    }

    async function invokePostHooks({ hooksEnabled, eventType, request, payload = {} } = {}) {
        if (!hooksEnabled) return;
        try {
            const result = await invokeHooks({ eventType, phase: 'post', user: request.user, payload: lifecycleHookPayload(payload, request.context) });
            await event('hook.post', request, {
                hookEventType: eventType,
                hookDecisions: (result?.decisions || []).map(item => ({ hookId: item.hookId, decision: item.decision, reason: item.reason || '' })),
                hookContextCount: Array.isArray(result?.additionalContext) ? result.additionalContext.length : 0
            });
        } catch (error) {
            // 副作用已经发生，post Hook 不能把成功结果伪装为失败；完整错误留在审计事件。
            await event('hook.post_failed', request, { hookEventType: eventType, errorCode: error.code || '', errorMessage: String(error.message || '').slice(0, 500) });
        }
    }

    async function recordCheckpointFailure(operationKey, error, request, options = {}) {
        if (!operationKey) return;
        try {
            if (await failCheckpoint(operationKey, error, options) !== false) return;
        } catch (_) {
            // 检查点未能落盘时维持原有状态，不能假定允许安全重试。
        }
        await event('checkpoint.failure_record_failed', request, {
            errorCode: String(error?.code || 'AGENT_PRE_EXECUTION_FAILED')
        });
    }

    async function execute(request = {}) {
        const {
            run = {}, tool = {}, input = {}, user = null, context = {}, execute, executionPlan = null,
            onComplete = null, onFailure = null
        } = request;
        if (typeof execute !== 'function') throw new Error('ToolOrchestrator 缺少实际工具执行器。');
        try {
            assertPreviewToolAllowed(run, tool);
        } catch (error) {
            await event('tool.denied', request, { errorCode: error.code, errorMessage: error.message });
            throw error;
        }
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
        const hooksEnabled = context.lifecycleHooksEnabled === true
            || String((context.env || process.env).PIVOT_AGENT_LIFECYCLE_HOOKS_ENABLED || '').toLowerCase() === 'true';
        if (hooksEnabled) {
            const hookResult = await invokeHooks({
                eventType: 'tool.preflight', phase: 'pre', user,
                payload: lifecycleHookPayload({ run, tool, input: effectiveInput, operationKey }, context)
            });
            const blocking = (hookResult?.decisions || []).find(item => String(item?.decision || '') === 'deny');
            await event('hook.preflight', requestWithKey, {
                hookDecisions: (hookResult?.decisions || []).map(item => ({ hookId: item.hookId, decision: item.decision, reason: item.reason || '' })),
                hookContextCount: Array.isArray(hookResult?.additionalContext) ? hookResult.additionalContext.length : 0
            });
            if (blocking) {
                const error = new Error(`生命周期 Hook「${blocking.hookName || blocking.hookId}」拒绝了当前工具调用。`);
                error.code = 'AGENT_HOOK_DENIED';
                error.category = 'policy';
                error.hook = blocking;
                throw error;
            }
        }
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
                    approvalGranted: context.approvalGranted === true,
                    user
                });
            }
        } catch (error) {
            try { await onFailure?.({ error, policy, operationKey, effectiveInput, executionPlan }); } catch (_) {}
            await event('tool.failed', requestWithKey, {
                errorCode: String(error?.code || 'AGENT_CHECKPOINT_FAILED'),
                errorCategory: String(error?.category || 'recovery'),
                errorMessage: String(error?.message || '').slice(0, 500)
            });
            throw error;
        }
        if (checkpoint?.replay) {
            try { await onComplete?.({ output: checkpoint.output, policy, operationKey, effectiveInput, executionPlan, replayed: true }); } catch (_) {}
            await event('tool.replayed', requestWithKey, { checkpointId: checkpoint.checkpointId || '' });
            return checkpoint.output;
        }

        let executionGrant = null;
        try {
            executionGrant = issueGrant({ run, user, tool, input: effectiveInput, executionPlan: executionPlan || {}, context });
            if (executionGrant) await registerGrant(executionGrant);
        } catch (error) {
            await recordCheckpointFailure(operationKey, error, requestWithKey);
            await invokePostHooks({ hooksEnabled, eventType: 'tool.failed', request: requestWithKey, payload: { run, tool, input: effectiveInput, error: { code: error.code || '', message: String(error.message || '').slice(0, 500) } } });
            try { await onFailure?.({ error, policy, operationKey, effectiveInput, executionPlan }); } catch (_) {}
            await event('sandbox.denied', requestWithKey, {
                errorCode: String(error?.code || 'AGENT_EXECUTION_GRANT_INVALID'),
                errorCategory: String(error?.category || 'policy'),
                errorMessage: String(error?.message || '').slice(0, 500)
            });
            throw error;
        }
        const executionContext = executionGrant
            ? { ...context, executionGrant: executionGrant.token, executionGrantSummary: executionGrant.summary }
            : context;
        const executionRequest = { ...request, context: executionContext, operationKey };
        if (executionGrant) {
            await event('sandbox.granted', executionRequest, { executionGrant: executionGrant.summary });
        }

        let deferredEffect = null;
        try {
            deferredEffect = await stageEffect({
                transactionId: context.taskTransactionId,
                user,
                run,
                tool,
                input: effectiveInput,
                operationKey,
                context: executionContext
            });
        } catch (error) {
            await recordCheckpointFailure(operationKey, error, executionRequest);
            await invokePostHooks({ hooksEnabled, eventType: 'tool.failed', request: executionRequest, payload: { run, tool, input: effectiveInput, error: { code: error.code || '', message: String(error.message || '').slice(0, 500) } } });
            try { await onFailure?.({ error, policy, operationKey, effectiveInput, executionPlan }); } catch (_) {}
            await event('transaction.denied', executionRequest, {
                errorCode: String(error?.code || 'AGENT_TASK_EFFECT_STAGE_FAILED'),
                errorMessage: String(error?.message || '').slice(0, 500)
            });
            throw error;
        }
        if (deferredEffect?.effect && deferredEffect.plan?.commitMode !== 'preview') {
            const output = {
                staged: true,
                transactionId: String(context.taskTransactionId),
                effectId: deferredEffect.effect.id,
                effectType: deferredEffect.effect.effectType,
                status: deferredEffect.effect.status,
                text: '外部副作用已暂存，任务通过独立验收后必须由用户提交；当前尚未执行。'
            };
            if (operationKey) await completeCheckpoint(operationKey, output, { user });
            await invokePostHooks({ hooksEnabled, eventType: 'tool.succeeded', request: executionRequest, payload: { run, tool, input: effectiveInput, output } });
            try { await onComplete?.({ output, policy, operationKey, effectiveInput, executionPlan, deferred: true }); } catch (_) {}
            await event('transaction.effect_staged', executionRequest, {
                transactionId: String(context.taskTransactionId),
                effectId: deferredEffect.effect.id,
                effectType: deferredEffect.effect.effectType
            });
            return output;
        }

        let executionStarted = false;
        try {
            if (deferredEffect?.effect && deferredEffect.plan?.commitMode === 'preview') {
                await beginPreviewEffect(deferredEffect.effect.id, user);
            }
            executionStarted = true;
            const output = await execute({
                ...executionRequest,
                operationKey,
                input: effectiveInput,
                policy,
                executionGrant
            });
            if (deferredEffect?.effect && deferredEffect.plan?.commitMode === 'preview') {
                await recordPreviewEffect(deferredEffect.effect.id, user, output && typeof output === 'object' ? output : { value: String(output ?? '') });
                await event('transaction.effect_previewed', executionRequest, {
                    transactionId: String(context.taskTransactionId),
                    effectId: deferredEffect.effect.id,
                    effectType: deferredEffect.effect.effectType
                });
            }
            if (operationKey) await completeCheckpoint(operationKey, output, { user });
            try {
                const { recordEvidenceFromToolOutput } = require('./agent-evidence-items');
                await recordEvidenceFromToolOutput({ run, user, toolName: tool.name, output });
            } catch (_) {
                // 证据持久化用于丰富审查与验收，不能使已检查点确认的成功工具结果失效。
            }
            await invokePostHooks({
                hooksEnabled,
                eventType: 'tool.succeeded',
                request: executionRequest,
                payload: { run, tool, input: effectiveInput, output }
            });
            if (isWorkspaceMutation(tool, effectiveInput)) {
                await invokePostHooks({
                    hooksEnabled,
                    eventType: 'workspace.changed',
                    request: executionRequest,
                    payload: { run, tool, input: effectiveInput, output }
                });
            }
            try { await onComplete?.({ output, policy, operationKey, effectiveInput, executionPlan }); } catch (_) {}
            await event('tool.completed', requestWithKey, { output: output && typeof output === 'object' ? { completed: true } : undefined });
            return output;
        } catch (error) {
            await recordCheckpointFailure(operationKey, error, requestWithKey, { executionMayHaveOccurred: executionStarted });
            await invokePostHooks({ hooksEnabled, eventType: 'tool.failed', request: executionRequest, payload: { run, tool, input: effectiveInput, error: { code: error.code || '', message: String(error.message || '').slice(0, 500) } } });
            const eventType = ['AGENT_SANDBOX_REQUIRED', 'AGENT_SANDBOX_DENIED', 'AGENT_WORKSPACE_DENIED'].includes(error?.code)
                ? 'sandbox.denied'
                : 'tool.failed';
            try { await onFailure?.({ error, policy, operationKey, effectiveInput, executionPlan }); } catch (_) {}
            await event(eventType, requestWithKey, {
                errorCode: String(error?.code || ''),
                errorCategory: String(error?.category || ''),
                errorMessage: String(error?.message || '').slice(0, 500),
                outcomeMayBeUncertain: executionStarted && tool.idempotent !== true
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
    isWorkspaceMutation,
    lifecycleHookPayload,
    operationKeyFor
};
