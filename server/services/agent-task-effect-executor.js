'use strict';

/* 任务验收前不得发生的副作用，统一由两阶段执行器处理。 */
const {
    beginTaskCompensation,
    commitTaskTransaction,
    completeTaskCompensation,
    finalizeTaskRollback,
    getTaskTransactionForUser,
    recordTaskWorkspaceSnapshot,
    stageTaskEffect,
    updateTaskEffect
} = require('./agent-task-transactions');
const { dispatchPostLifecycleHook } = require('./agent-lifecycle-dispatcher');
const { queryOne } = require('../db/client');

function workspaceToolName(value = '') {
    const name = String(value || '').trim();
    const match = name.match(/^(?:mcp\.\d+\.)?(workspace\.[a-z_]+)$/);
    return match ? match[1] : '';
}

function effectIdempotencyKey(input = {}, operationKey = '') {
    const source = input && typeof input === 'object' ? input : {};
    const businessKey = String(source.idempotencyKey || source.idempotency_key || source.requestId || source.request_id || '').trim();
    if (businessKey && /^[A-Za-z0-9._:-]{8,200}$/.test(businessKey)) return `business:${businessKey}`;
    return String(operationKey || '').slice(0, 255);
}

function deferredEffectForTool({ tool = {}, input = {}, operationKey = '' } = {}) {
    const name = String(tool.name || '').trim();
    const idempotencyKey = effectIdempotencyKey(input, operationKey);
    if (name === 'workflow.notify') {
        const bindingId = String(input.bindingId || input.binding_id || '').trim();
        if (!bindingId) return null;
        return {
            effectType: name,
            resourceKeys: [`channel-binding:${bindingId}`],
            idempotencyKey,
            commitMode: 'after_verify',
            compensation: { mode: 'none', instructions: '外部通知发送后无法可靠撤回；提交前请复核接收渠道和内容。' }
        };
    }
    if (name === 'agent.http') {
        const method = String(input.method || 'GET').trim().toUpperCase();
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
        let origin = '';
        try { origin = new URL(String(input.url || '')).origin; } catch (_) {}
        return {
            effectType: 'agent.http',
            resourceKeys: origin ? [`http-origin:${origin}`] : ['http-origin:unresolved'],
            idempotencyKey,
            commitMode: 'after_verify',
            compensation: { mode: 'none', instructions: '远端 HTTP 写操作可能不可逆；提交前请复核目标、方法和请求体。' }
        };
    }
    const workspaceTool = workspaceToolName(name);
    if (!workspaceTool) return null;
    const worktreeName = String(input.worktreeName || input.worktree_name || '').trim();
    const previewTools = new Set(['workspace.patch', 'workspace.install', 'workspace.git_commit', 'workspace.git_worktree']);
    const commitTools = new Set(['workspace.git_merge', 'workspace.git_push', 'workspace.git_pr']);
    if (!previewTools.has(workspaceTool) && !commitTools.has(workspaceTool)) return null;
    if (previewTools.has(workspaceTool) && !worktreeName && workspaceTool !== 'workspace.git_worktree') {
        const error = new Error('事务化代码修改、依赖安装和提交必须指定 Pivot 创建的影子工作树，不能直接写入主工作区。');
        error.code = 'AGENT_WORKSPACE_SHADOW_REQUIRED';
        error.status = 409;
        throw error;
    }
    const effectiveWorktreeName = worktreeName || String(input.name || '').trim();
    const resources = effectiveWorktreeName
        ? [`workspace-worktree:${effectiveWorktreeName}`]
        : ['workspace-primary'];
    if (workspaceTool === 'workspace.patch') {
        (Array.isArray(input.changes) ? input.changes : []).forEach(change => {
            const file = String(change?.path || '').trim();
            if (file) resources.push(`workspace-file:${effectiveWorktreeName}:${file}`);
        });
    }
    return {
        effectType: `mcp.${workspaceTool}`,
        resourceKeys: [...new Set(resources)].slice(0, 32),
        idempotencyKey,
        commitMode: previewTools.has(workspaceTool) ? 'preview' : 'after_verify',
        compensation: previewTools.has(workspaceTool)
            ? { mode: 'manual', action: 'preserve_shadow_worktree', instructions: '保留影子工作树及未提交内容；请先检查、保存或归档，再由用户决定如何处理。' }
            : { mode: 'none', instructions: '主工作区合并、推送或 Pull Request 属于交付动作，提交前必须由用户确认。' }
    };
}

async function stageDeferredToolEffect({ transactionId, user, run = {}, tool = {}, input = {}, operationKey = '', context = {} } = {}) {
    const plan = deferredEffectForTool({ tool, input, operationKey });
    if (!plan) return null;
    if (!transactionId) {
        if (context.autonomous === true) {
            const error = new Error('自主任务的受控副作用缺少任务事务，已拒绝执行。');
            error.code = 'AGENT_TASK_TRANSACTION_REQUIRED';
            error.status = 409;
            throw error;
        }
        return null;
    }
    const effect = await stageTaskEffect(transactionId, user, plan, {
        toolName: tool.name,
        input,
        runId: run.id || context.runId || '',
        nodeId: context.node?.id || context.stepId || '',
        networkPolicy: run.network_policy || run.networkPolicy || {}
    });
    return { effect, plan };
}

async function recordPreviewTaskEffect(effectId, user, result = {}) {
    const effect = await getTaskEffectForPreview(effectId, user);
    const snapshot = workspaceSnapshotForPreview(effect, result);
    if (snapshot) await recordTaskWorkspaceSnapshot(effect.transactionId, user, snapshot);
    return await updateTaskEffect(effectId, user, 'staged', { result });
}

async function getTaskEffectForPreview(effectId, user) {
    const { queryOne } = require('../db/client');
    const row = await queryOne(`SELECT e.transaction_id, e.effect_type, e.commit_mode, e.request
        FROM agent_task_effects e JOIN agent_task_transactions t ON t.id = e.transaction_id
        WHERE e.id = ? AND t.user_id = ? AND e.status = 'executing'`, [effectId, user?.id]);
    if (!row) {
        const error = new Error('预览副作用不存在或不处于执行状态。');
        error.code = 'AGENT_TASK_EFFECT_NOT_READY';
        error.status = 409;
        throw error;
    }
    let request = row.request;
    if (typeof request === 'string') { try { request = JSON.parse(request); } catch (_) { request = {}; } }
    return { id: effectId, transactionId: row.transaction_id, effectType: row.effect_type, commitMode: row.commit_mode, request: request || {} };
}

async function beginPreviewTaskEffect(effectId, user) {
    return await updateTaskEffect(effectId, user, 'executing');
}

function workspaceSnapshotForPreview(effect = {}, result = {}) {
    if (!String(effect.effectType || '').startsWith('mcp.workspace.') || String(effect.commitMode || '') !== 'preview') return null;
    const request = effect.request || {};
    const input = request.input || {};
    const workspace = result?.workspace && typeof result.workspace === 'object' ? result.workspace : {};
    const worktreeName = String(result?.worktreeName || input.worktreeName || input.worktree_name || input.name || '').trim();
    const revision = String(workspace.revision || '');
    const archiveDigest = String(result?.recoverySnapshot?.archiveDigest || '');
    const restoreHandle = String(result?.recoverySnapshot?.restoreHandle || '');
    if (!worktreeName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(worktreeName) || !/^[a-f0-9]{64}$/i.test(revision)) {
        const error = new Error('影子工作区预览未返回受控工作树标识，不能作为可恢复事务结果。');
        error.code = 'AGENT_WORKSPACE_SNAPSHOT_REQUIRED';
        error.status = 409;
        throw error;
    }
    return {
        worktreeName,
        branch: String(workspace.branch || '').slice(0, 160),
        head: String(workspace.head || ''),
        revision,
        effectId: effect.id,
        ...(archiveDigest && restoreHandle ? { archiveDigest, restoreHandle } : {})
    };
}

async function executeEffect(effect, user, transaction) {
    if (effect.effectType === 'workflow.notify') {
        const { executeWorkflowNotify } = require('./agent-tools-workflow-nodes');
        const request = effect.request || {};
        return await executeWorkflowNotify(request.input || {}, user, {
            run: { id: transaction.runId },
            runId: transaction.runId,
            node: request.nodeId ? { id: request.nodeId } : null
        });
    }
    if (effect.effectType === 'agent.http') {
        const { executeAgentHttp } = require('./agent-http-tool');
        const request = effect.request || {};
        return await executeAgentHttp(request.input || {}, user, {
            run: { id: transaction.runId, network_policy: request.networkPolicy || {} },
            autonomous: true
        });
    }
    if (effect.effectType.startsWith('mcp.workspace.')) {
        const { executeMcpTool } = require('./mcp-client');
        const request = effect.request || {};
        return await executeMcpTool(request.toolName, request.input || {}, user, {
            source: 'task_transaction_commit',
            traceContext: { runId: transaction.runId, transactionId: transaction.id }
        });
    }
    const error = new Error(`没有登记副作用执行器：${effect.effectType}`);
    error.code = 'AGENT_TASK_EFFECT_EXECUTOR_UNAVAILABLE';
    error.status = 503;
    throw error;
}

async function executeCompensation(compensation, effect) {
    const plan = compensation?.plan || effect?.compensation || {};
    if (String(plan.mode || '') !== 'automatic' || String(plan.action || '') !== 'remove_shadow_worktree') {
        return { skipped: true, reason: 'manual_or_no_compensation' };
    }
    // 旧事务可能仍存有自动移除计划。此前记录的 revision 只反映 Git 状态，
    // 不是包含未提交和忽略文件的可恢复快照；不得以它为凭据删除工作树。
    return { skipped: true, reason: 'shadow_worktree_requires_manual_preservation' };
}

async function executeAndCommitTaskTransaction(transactionId, user, commitEvidence = {}, deps = {}) {
    let transaction = await getTaskTransactionForUser(transactionId, user);
    if (!transaction) {
        const error = new Error('任务事务不存在或无权访问。');
        error.code = 'AGENT_TASK_TRANSACTION_NOT_FOUND';
        error.status = 404;
        throw error;
    }
    if (transaction.status !== 'awaiting_commit') {
        const error = new Error('任务事务尚未通过验收或已被处理。');
        error.code = 'AGENT_TASK_TRANSACTION_NOT_READY';
        error.status = 409;
        throw error;
    }
    const run = await queryOne('SELECT status, deleted_at FROM agent_runs WHERE id = ? AND user_id = ?', [transaction.runId, user?.id]);
    if (!run || run.deleted_at || run.status !== 'awaiting_commit') {
        const error = new Error('任务已隐藏、停止或不在等待提交状态，不能执行事务副作用。');
        error.code = 'AGENT_TASK_RUN_NOT_COMMITTABLE';
        error.status = 409;
        throw error;
    }
    // 必须在执行任何待提交外部效果之前检查预览，避免先发送通知或写入远端，
    // 随后才发现影子工作区状态登记失败而无法提交事务。
    assertPreviewEffectsReady(transaction.effects);
    for (const effect of transaction.effects) {
        if (effect.status === 'committed' || effect.commitMode === 'preview') continue;
        if (effect.status !== 'staged') {
            const error = new Error(`副作用 ${effect.effectType} 当前状态不可提交：${effect.status}`);
            error.code = 'AGENT_TASK_EFFECT_NOT_READY';
            error.status = 409;
            throw error;
        }
        await updateTaskEffect(effect.id, user, 'executing', { requireRunAwaitingCommit: true });
        try {
            const result = await (deps.executeEffect || executeEffect)(effect, user, transaction);
            await updateTaskEffect(effect.id, user, 'committed', { result, requireRunAwaitingCommit: true });
        } catch (error) {
            try {
                await updateTaskEffect(effect.id, user, 'failed', { errorInfo: { code: error.code || '', message: String(error.message || '').slice(0, 2000), outcomeUncertain: true, phase: 'commit' } });
            } catch (recordError) {
                const persistenceError = new Error('副作用提交结果无法持久化，请勿重试或回滚，需先人工核对外部状态。', { cause: recordError });
                persistenceError.code = 'AGENT_TASK_EFFECT_OUTCOME_RECORD_FAILED';
                persistenceError.status = 409;
                throw persistenceError;
            }
            throw error;
        }
        transaction = await getTaskTransactionForUser(transactionId, user);
    }
    const committed = await commitTaskTransaction(transactionId, user, {
        ...commitEvidence,
        kind: commitEvidence.kind || 'task_effect_commit',
        committedEffectCount: transaction.effects.length
    }, { requireRunAwaitingCommit: true });
    await dispatchPostLifecycleHook({
        eventType: 'transaction.committed',
        user,
        run: { id: committed.runId, user_id: user?.id || null },
        payload: { transaction: committed },
        eventKey: `transaction.committed:${committed.id}`
    });
    return committed;
}

function assertPreviewEffectsReady(effects = []) {
    if ((Array.isArray(effects) ? effects : []).some(effect => effect?.commitMode === 'preview' && effect.status !== 'staged')) {
        const error = new Error('影子工作区预览尚未完成或需要人工处理，不能执行外部提交。');
        error.code = 'AGENT_TASK_PREVIEW_NOT_READY';
        error.status = 409;
        throw error;
    }
}

async function executeAndFinalizeTaskCompensation(transactionId, user, reason = '') {
    let transaction = await beginTaskCompensation(transactionId, user, reason);
    const effects = new Map(transaction.effects.map(effect => [effect.id, effect]));
    for (const compensation of transaction.compensations) {
        if (!['pending', 'executing'].includes(compensation.status)) continue;
        const effect = effects.get(compensation.effectId);
        try {
            const result = await executeCompensation(compensation, effect, user);
            await completeTaskCompensation(compensation.id, user, { success: result?.skipped !== true, result });
        } catch (error) {
            await completeTaskCompensation(compensation.id, user, {
                success: false,
                errorInfo: { code: error.code || '', message: String(error.message || '').slice(0, 2000) }
            });
        }
        transaction = await getTaskTransactionForUser(transactionId, user);
    }
    const finalized = await finalizeTaskRollback(transactionId, user);
    if (finalized.status === 'rolled_back') {
        await dispatchPostLifecycleHook({
            eventType: 'transaction.rolled_back',
            user,
            run: { id: finalized.runId, user_id: user?.id || null },
            payload: { transaction: finalized },
            eventKey: `transaction.rolled_back:${finalized.id}`
        });
    }
    return finalized;
}

module.exports = {
    assertPreviewEffectsReady,
    beginPreviewTaskEffect,
    deferredEffectForTool,
    executeAndCommitTaskTransaction,
    executeAndFinalizeTaskCompensation,
    executeCompensation,
    recordPreviewTaskEffect,
    stageDeferredToolEffect,
    workspaceSnapshotForPreview
};
