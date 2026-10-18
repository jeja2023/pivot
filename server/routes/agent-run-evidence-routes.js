'use strict';

const { asyncHandler } = require('../http');
const { parseJsonObject } = require('../services/agent-validators');
const { getDagNodeCompleteOutputForUser, getRunDetailForUser, listWorkflowIterationItemsForUser, listWorkflowInvocationsForUser } = require('../services/agent-runs');
const { getTaskVerificationForUser } = require('../services/agent-verification');
const { createTaskTransaction, getTaskTransactionForUser, listTaskTransactionsForRun, recordTaskTransactionVerification, resolveUncertainTaskEffect } = require('../services/agent-task-transactions');
const { executeAndCommitTaskTransaction, executeAndFinalizeTaskCompensation } = require('../services/agent-task-effect-executor');
const { listAgentEvidenceForUser } = require('../services/agent-evidence-items');
const { closeAgentBrowserSession, listAgentBrowserSessionsForRun, recoverAgentBrowserSession } = require('../services/agent-browser-sessions');
const { getAgentTraceForUser } = require('../services/agent-traces');
const { listAgentCheckpointsForUser } = require('../services/agent-checkpoints');

function registerAgentRunEvidenceRoutes(router, { authMiddleware, automationGuard, logAction, finalizeCommittedTaskTransactionRun, finalizeRolledBackTaskTransactionRun }) {
    router.get('/agents/runs/:id/browser-sessions', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        res.json({ data: await listAgentBrowserSessionsForRun(req.params.id, req.user, { limit: req.query.limit, includeClosed: req.query.includeClosed === 'true' }) });
    }));
    router.post('/agents/browser-sessions/:id/recover', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        if (req.body?.confirmed !== true) return res.status(409).json({ error: '请先明确确认重新观察浏览器页面。', code: 'AGENT_BROWSER_RECOVERY_CONFIRMATION_REQUIRED' });
        const recovered = await recoverAgentBrowserSession(req.params.id, req.user, { confirmed: true });
        logAction(req, '人工恢复浏览器观察会话', `会话: ${recovered.session.id}，页面: ${recovered.observation.url}`);
        res.json({ success: true, data: recovered });
    }));
    router.post('/agents/browser-sessions/:id/close', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const session = await closeAgentBrowserSession(req.params.id, req.user, { reason: 'user_closed' });
        if (!session) return res.status(404).json({ error: '浏览器会话不存在或无权关闭。' });
        logAction(req, '关闭浏览器会话', `会话: ${session.id}`);
        res.json({ success: true, data: session });
    }));
    router.get('/agents/runs/:id/verification', authMiddleware, asyncHandler(async (req, res) => {
        const verification = await getTaskVerificationForUser(req.params.id, req.user);
        if (!verification) return res.status(404).json({ error: '任务验收报告不存在或无权访问。' });
        res.json({ success: true, verification });
    }));
    router.get('/agents/runs/:id/transactions', authMiddleware, asyncHandler(async (req, res) => {
        const transactions = await listTaskTransactionsForRun(req.params.id, req.user, { limit: req.query.limit });
        if (transactions === null) return res.status(404).json({ error: '智能体任务不存在。' });
        res.json({ success: true, transactions });
    }));
    router.post('/agents/runs/:id/transactions', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const run = await getRunDetailForUser(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        const transaction = await createTaskTransaction({
            run: run.run, user: req.user,
            taskContract: req.body?.taskContract || req.body?.task_contract || parseJsonObject(run.run?.metadata || {})?.taskContract || {},
            workspaceSnapshot: req.body?.workspaceSnapshot || req.body?.workspace_snapshot || {}, effects: req.body?.effects || []
        });
        logAction(req, '创建任务事务', `任务ID: ${run.id}，事务ID: ${transaction.id}`);
        res.status(201).json({ success: true, transaction });
    }));
    router.get('/agents/transactions/:transactionId', authMiddleware, asyncHandler(async (req, res) => {
        const transaction = await getTaskTransactionForUser(req.params.transactionId, req.user);
        if (!transaction) return res.status(404).json({ error: '任务事务不存在或无权访问。' });
        res.json({ success: true, transaction });
    }));
    router.post('/agents/transactions/:transactionId/verify', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const transaction = await getTaskTransactionForUser(req.params.transactionId, req.user);
        if (!transaction) return res.status(404).json({ error: '任务事务不存在或无权访问。' });
        const verification = await getTaskVerificationForUser(transaction.runId, req.user);
        if (!verification) return res.status(409).json({ error: '任务尚无独立验收报告，不能进入提交阶段。', code: 'AGENT_TASK_TRANSACTION_VERIFICATION_REQUIRED' });
        const updated = await recordTaskTransactionVerification(transaction.id, req.user, verification.report);
        logAction(req, '写入任务事务验收', `事务ID: ${transaction.id}，验收状态: ${verification.outcomeStatus}`);
        res.json({ success: true, transaction: updated });
    }));
    router.post('/agents/transactions/:transactionId/commit', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const transaction = await executeAndCommitTaskTransaction(req.params.transactionId, req.user, req.body?.commitEvidence || req.body?.commit_evidence || {});
        await finalizeCommittedTaskTransactionRun(transaction.runId, req.user, transaction);
        logAction(req, '提交任务事务', `事务ID: ${transaction.id}`);
        res.json({ success: true, transaction });
    }));
    router.post('/agents/transactions/:transactionId/rollback', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const transaction = await executeAndFinalizeTaskCompensation(req.params.transactionId, req.user, req.body?.reason || '用户请求回滚');
        await finalizeRolledBackTaskTransactionRun(transaction.runId, req.user, transaction);
        logAction(req, '完成任务事务补偿', `事务ID: ${transaction.id}，状态: ${transaction.status}`);
        res.json({ success: true, transaction });
    }));
    router.post('/agents/task-effects/:effectId/resolve-uncertain', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const effect = await resolveUncertainTaskEffect(req.params.effectId, req.user, req.body || {});
        logAction(req, '人工核对不确定任务副作用', `副作用ID: ${effect.id}，结论: ${effect.errorInfo?.manualReview?.conclusion || '-'}`);
        res.json({ success: true, effect });
    }));
    router.get('/agents/runs/:id/evidence', authMiddleware, asyncHandler(async (req, res) => {
        const evidence = await listAgentEvidenceForUser(req.params.id, req.user, { limit: req.query.limit });
        if (evidence === null) return res.status(404).json({ error: '任务不存在或无权访问。' });
        res.json({ success: true, evidence });
    }));
    router.get('/agents/runs/:id/dag/nodes/:nodeId/output', authMiddleware, asyncHandler(async (req, res) => {
        const output = await getDagNodeCompleteOutputForUser(req.params.id, req.params.nodeId, req.user);
        if (!output) return res.status(404).json({ error: '工作流节点不存在或无权访问。' });
        res.json({ success: true, ...output });
    }));
    router.get('/agents/runs/:id/invocations', authMiddleware, asyncHandler(async (req, res) => {
        const invocations = await listWorkflowInvocationsForUser(req.params.id, req.user);
        if (invocations === null) return res.status(404).json({ error: '工作流任务不存在或无权访问。' });
        res.json({ success: true, data: invocations });
    }));
    router.get('/agents/runs/:id/iteration-items', authMiddleware, asyncHandler(async (req, res) => {
        const items = await listWorkflowIterationItemsForUser(req.params.id, req.user);
        if (items === null) return res.status(404).json({ error: '工作流任务不存在或无权访问。' });
        res.json({ success: true, data: items });
    }));
    router.get('/agents/runs/:id/trace', authMiddleware, asyncHandler(async (req, res) => {
        const trace = await getAgentTraceForUser(req.params.id, req.user);
        if (!trace) return res.status(404).json({ error: '智能体任务不存在。' });
        res.json(trace);
    }));
    router.get('/agents/runs/:id/checkpoints', authMiddleware, asyncHandler(async (req, res) => {
        const checkpoints = await listAgentCheckpointsForUser(req.params.id, req.user, { limit: req.query.limit });
        if (!checkpoints) return res.status(404).json({ error: '智能体任务不存在。' });
        res.json({ data: checkpoints });
    }));
}

module.exports = { registerAgentRunEvidenceRoutes };
