'use strict';

const crypto = require('crypto');
const { asyncHandler } = require('../http');
const { normalizeDelegationBatchInput } = require('../services/agent-collaboration');

// 批量协作是一项独立的高风险编排入口。拆出后可单独审计其“只能继承或收窄”
// 的权限规则，避免普通 Agent 路由继续膨胀。
function registerAgentDelegationBatchRoute({ router, authMiddleware, automationGuard, buildDelegationContext, createAgentRun, cancelAgentRun, logAction }) {
    router.post('/agents/runs/:id/delegate/batch', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const context = await buildDelegationContext(req.params.id, req.user);
        if (!context) return res.status(404).json({ error: '父任务不存在或无权委派。' });
        const batch = normalizeDelegationBatchInput(req.body || {});
        const batchId = `delegation_${crypto.randomUUID()}`;
        const idem = String(req.get('Idempotency-Key') || '').trim().slice(0, 180);
        const children = [];
        try {
            for (let index = 0; index < batch.tasks.length; index += 1) {
                const task = batch.tasks[index];
                const toolAllowlist = context.parentToolAllowlist.length
                    ? (task.toolAllowlist.length ? context.parentToolAllowlist.filter(tool => task.toolAllowlist.includes(tool)) : context.parentToolAllowlist)
                    : task.toolAllowlist;
                const child = await createAgentRun({
                    user: req.user, parentRunId: context.parentRunId,
                    goal: task.context ? `${task.goal}\n\n可用上下文：\n${task.context}` : task.goal,
                    title: task.title || `${batch.batchTitle} · 子任务 ${index + 1}`,
                    modelId: task.modelId || context.parentModelId || null,
                    maxSteps: task.maxSteps, maxTokenBudget: task.maxTokenBudget,
                    approvalPolicy: context.parentApprovalPolicy || 'safe_mcp_auto',
                    toolPolicy: context.parentToolPolicy === 'builtin_only' ? 'builtin_only' : task.toolPolicy,
                    toolAllowlist, forkHistory: task.forkHistory,
                    dedupeKey: idem ? `delegate-batch:${context.parentRunId}:${idem}:${index}` : null,
                    metadata: {
                        source: 'delegation', parentRunId: context.parentRunId,
                        collaboration: {
                            batchId, batchTitle: batch.batchTitle, taskIndex: index + 1, taskCount: batch.tasks.length,
                            supervisorRunId: context.parentRunId, agentName: task.agentName || `子智能体 ${index + 1}`,
                            role: task.role, instructions: task.instructions, outputSchema: task.outputSchema,
                            responseFormat: task.responseFormat, repairAttempt: 0
                        }
                    }
                });
                children.push(child);
            }
        } catch (error) {
            await Promise.all(children.map(child => cancelAgentRun(child.id, req.user).catch(() => null)));
            throw error;
        }
        logAction(req, '批量委派 Agent 协作子任务', `父任务ID: ${context.parentRunId}，批次: ${batchId}，子任务数: ${children.length}`);
        res.status(202).json({ success: true, batchId, runs: children, parent: context });
    }));
}

module.exports = { registerAgentDelegationBatchRoute };
