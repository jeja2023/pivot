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
    router.get('/agents/runs/:id/audit-bundle', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        const run = detail.run || {};
        const steps = detail.steps || [];
        const evidence = (await listAgentEvidenceForUser(req.params.id, req.user, { limit: 100 })) || [];
        const verification = await getTaskVerificationForUser(req.params.id, req.user).catch(() => null);
        const browserSessions = await listAgentBrowserSessionsForRun(req.params.id, req.user, { includeClosed: true }).catch(() => []);
        const transactions = await listTaskTransactionsForRun(req.params.id, req.user, { limit: 50 }).catch(() => []);

        const bundle = {
            runId: run.id,
            title: run.title || run.goal,
            status: run.status,
            createdAt: run.created_at,
            completedAt: run.completed_at,
            durationMs: run.duration_ms,
            goal: run.goal,
            finalAnswer: run.final_answer || '',
            errorMessage: run.error_message || '',
            stepsCount: steps.length,
            steps: steps.map(s => ({
                stepIndex: s.step_index,
                type: s.type,
                title: s.title,
                toolName: s.tool_name,
                durationMs: s.duration_ms,
                status: s.status,
                createdAt: s.created_at
            })),
            evidenceCount: evidence.length,
            evidence: evidence.map(e => ({
                id: e.id,
                kind: e.kind || e.evidence_type,
                title: e.title,
                sha256: e.sha256,
                uri: e.uri,
                createdAt: e.created_at
            })),
            verification: verification?.outcomeStatus ? {
                status: verification.outcomeStatus,
                report: verification.report
            } : null,
            browserSessionsCount: browserSessions.length,
            transactionsCount: transactions.length
        };

        if (req.query.format === 'json') {
            return res.json({ success: true, bundle });
        }

        const lines = [
            `# 智能体任务交付与全景审计报告`,
            ``,
            `- **任务ID**: \`${run.id}\``,
            `- **任务标题**: ${run.title || run.goal || '-'}`,
            `- **执行状态**: **${run.status}**`,
            `- **开始时间**: ${run.created_at || '-'}`,
            `- **完成时间**: ${run.completed_at || '-'}`,
            `- **总耗时**: ${run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)} 秒` : '-'}`,
            `- **运行模式**: ${run.run_mode || 'standard'}`,
            ``,
            `## 一、任务目标与最终交付`,
            ``,
            `### 任务目标`,
            `> ${String(run.goal || '').replace(/\n/g, '\n> ')}`,
            ``,
            `### 最终结果`,
            run.final_answer ? run.final_answer : (run.error_message ? `**异常退出**：${run.error_message}` : '*(尚无最终回答)*'),
            ``,
            `## 二、执行步骤时间线 (共 ${steps.length} 步)`,
            ``,
            `| 步数 | 类型 | 工具 / 动作 | 耗时 | 状态 | 发生时间 |`,
            `| :--- | :--- | :--- | :--- | :--- | :--- |`,
            ...steps.map(s => `| ${s.step_index} | ${s.type || 'step'} | ${s.title || s.tool_name || '-'} | ${s.duration_ms ? `${s.duration_ms}ms` : '-'} | ${s.status || 'done'} | ${s.created_at || '-'} |`),
            ``,
            `## 三、工程证据凭据 (共 ${evidence.length} 项)`,
            ``,
            evidence.length ? [
                `| 凭据ID | 证据类别 | 说明 | SHA-256 校验哈希 | 记录时间 |`,
                `| :--- | :--- | :--- | :--- | :--- |`,
                ...evidence.map(e => `| \`${e.id}\` | ${e.kind || e.evidence_type || 'evidence'} | ${e.title || '-'} | \`${(e.sha256 || '-').slice(0, 16)}...\` | ${e.created_at || '-'} |`)
            ].join('\n') : '*(无独立外置凭据文件)*',
            ``,
            verification ? `## 四、验收核验报告\n\n- **核验结论**: ${verification.outcomeStatus}\n\n\`\`\`json\n${JSON.stringify(verification.report, null, 2)}\n\`\`\`\n` : '',
            `---`,
            `*本审计包由 Pivot 自动化控制面于 ${new Date().toISOString()} 生成，受控于平台访问审计。*`
        ];

        logAction(req, '导出任务全景审计包', `任务ID: ${run.id}`);
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="pivot-audit-${run.id}.md"`);
        res.send(lines.join('\n'));
    }));
}

module.exports = { registerAgentRunEvidenceRoutes };
