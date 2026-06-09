const express = require('express');
const { asyncHandler, normalizeLimit } = require('../http');
const { listStrategies: listModelRouterStrategies } = require('../services/model-router');
const {
    createWorkflowDraftFromRun,
    getRunDetailForUser,
    listDeletedRunsForAdmin,
    listRuns,
    listSteps
} = require('../services/agent-runs');
const { preflightAgentRun } = require('../services/agent-preflight');
const { formatToolList } = require('../services/agent-tool-catalog');
const {
    cancelAgentRun,
    approveAgentTool,
    createAgentArtifactVersion,
    createAgentSchedule,
    createAgentTemplate,
    createAgentRun,
    createAgentWorkflow,
    deleteAgentSchedule,
    deleteAgentTemplate,
    deleteAgentWorkflow,
    diffAgentArtifactVersions,
    diffAgentWorkflowVersions,
    exportAgentRun,
    listAgentArtifacts,
    listAgentArtifactVersions,
    listAgentNotifications,
    listAgentSchedules,
    listAgentTemplates,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    getAgentMetrics,
    getAgentRuntimeStatus,
    markAgentNotificationRead,
    publishAgentWorkflowVersion,
    rerunAgentRun,
    rerunAgentDagFromNode,
    resumeAgentRun,
    restoreAgentWorkflow,
    restoreAgentWorkflowVersion,
    rollbackAgentArtifactVersion,
    runAgentScheduleNow,
    saveAgentRunArtifact,
    softDeleteAgentRun
    ,
    updateAgentSchedule,
    updateAgentTemplate,
    updateAgentWorkflow
} = require('../services/agent-runtime');

function createAgentsRouter({ authMiddleware, logAction }) {
    const router = express.Router();

    router.get('/agents/tools', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ tools: formatToolList(req.user) });
    }));

    // 公开支持的模型路由策略，供前端下拉填充
    router.get('/agents/model-routers', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ strategies: listModelRouterStrategies() });
    }));

    router.get('/agents/runtime', authMiddleware, asyncHandler(async (req, res) => {
        res.json(getAgentRuntimeStatus(req.user));
    }));

    router.get('/agents/metrics', authMiddleware, asyncHandler(async (req, res) => {
        res.json(getAgentMetrics(req.user, req.query.days));
    }));

    router.post('/agents/preflight', authMiddleware, asyncHandler(async (req, res) => {
        res.json(preflightAgentRun(req.user, req.body || {}));
    }));

    router.get('/agents/templates', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: listAgentTemplates(req.user) });
    }));

    router.post('/agents/templates', authMiddleware, asyncHandler(async (req, res) => {
        const template = createAgentTemplate(req.user, req.body || {});
        logAction(req, '创建智能体模板', `模板ID: ${template.id}，名称: ${template.name}`);
        res.status(201).json({ success: true, template });
    }));

    router.put('/agents/templates/:id', authMiddleware, asyncHandler(async (req, res) => {
        const template = updateAgentTemplate(req.params.id, req.user, req.body || {});
        if (!template) return res.status(404).json({ error: '智能体模板不存在或无权修改。' });
        logAction(req, '更新智能体模板', `模板ID: ${template.id}，名称: ${template.name}`);
        res.json({ success: true, template });
    }));

    router.delete('/agents/templates/:id', authMiddleware, asyncHandler(async (req, res) => {
        const template = deleteAgentTemplate(req.params.id, req.user);
        if (!template) return res.status(404).json({ error: '智能体模板不存在或无权删除。' });
        logAction(req, '删除智能体模板', `模板ID: ${template.id}，名称: ${template.name}`);
        res.json({ success: true });
    }));

    router.get('/agents/workflows', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: listAgentWorkflows(req.user) });
    }));

    router.post('/agents/workflows', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = createAgentWorkflow(req.user, req.body || {});
        logAction(req, '保存智能体工作流', `工作流ID: ${workflow.id}，名称: ${workflow.name}，版本: ${workflow.current_version}`);
        res.status(201).json({ success: true, workflow });
    }));

    router.put('/agents/workflows/:id', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = updateAgentWorkflow(req.params.id, req.user, req.body || {});
        if (!workflow) return res.status(404).json({ error: '智能体工作流不存在或无权修改。' });
        logAction(req, '更新智能体工作流', `工作流ID: ${workflow.id}，名称: ${workflow.name}，版本: ${workflow.current_version}`);
        res.json({ success: true, workflow });
    }));

    router.post('/agents/workflows/:id/publish', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = publishAgentWorkflowVersion(req.params.id, req.user, req.body?.version || 'current');
        if (!workflow) return res.status(404).json({ error: '智能体工作流或目标版本不存在。' });
        logAction(req, '发布智能体工作流版本', `工作流ID: ${workflow.id}，发布版本: ${workflow.published_version || '-'}`);
        res.json({ success: true, workflow });
    }));

    router.get('/agents/workflows/:id/versions', authMiddleware, asyncHandler(async (req, res) => {
        const versions = listAgentWorkflowVersions(req.params.id, req.user);
        if (!versions) return res.status(404).json({ error: '智能体工作流不存在。' });
        res.json({ data: versions });
    }));

    router.get('/agents/workflows/:id/diff', authMiddleware, asyncHandler(async (req, res) => {
        const diff = diffAgentWorkflowVersions(req.params.id, req.user, req.query.from, req.query.to || 'current');
        if (!diff) return res.status(404).json({ error: '智能体工作流或版本不存在。' });
        res.json(diff);
    }));

    router.post('/agents/workflows/:id/versions/:version/restore', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = restoreAgentWorkflowVersion(req.params.id, req.user, req.params.version);
        if (!workflow) return res.status(404).json({ error: '智能体工作流或目标版本不存在。' });
        logAction(req, '回滚智能体工作流版本', `工作流ID: ${workflow.id}，当前版本: ${workflow.current_version}`);
        res.json({ success: true, workflow });
    }));

    router.delete('/agents/workflows/:id', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = deleteAgentWorkflow(req.params.id, req.user);
        if (!workflow) return res.status(404).json({ error: '智能体工作流不存在或无权删除。' });
        logAction(req, '删除智能体工作流', `工作流ID: ${workflow.id}，名称: ${workflow.name}`);
        res.json({ success: true, workflow: { id: workflow.id, name: workflow.name } });
    }));

    // 恢复已删除工作流
    router.patch('/agents/workflows/:id/restore', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = restoreAgentWorkflow(req.params.id, req.user);
        if (!workflow) return res.status(404).json({ error: '工作流不存在、未删除或已超过 30 天恢复期限。' });
        logAction(req, '恢复智能体工作流', `工作流ID: ${workflow.id}，名称: ${workflow.name}`);
        res.json({ success: true, workflow });
    }));

    router.get('/agents/schedules', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: listAgentSchedules(req.user) });
    }));

    router.post('/agents/schedules', authMiddleware, asyncHandler(async (req, res) => {
        const schedule = createAgentSchedule(req.user, req.body || {});
        logAction(req, '创建智能体计划', `计划ID: ${schedule.id}，名称: ${schedule.name}`);
        res.status(201).json({ success: true, schedule });
    }));

    router.put('/agents/schedules/:id', authMiddleware, asyncHandler(async (req, res) => {
        const schedule = updateAgentSchedule(req.params.id, req.user, req.body || {});
        if (!schedule) return res.status(404).json({ error: '智能体计划不存在或无权修改。' });
        logAction(req, '更新智能体计划', `计划ID: ${schedule.id}，名称: ${schedule.name}`);
        res.json({ success: true, schedule });
    }));

    router.post('/agents/schedules/:id/run', authMiddleware, asyncHandler(async (req, res) => {
        const run = runAgentScheduleNow(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体计划不存在。' });
        logAction(req, '手动运行智能体计划', `任务ID: ${run.id}，计划ID: ${req.params.id}`);
        res.status(202).json({ success: true, run });
    }));

    router.delete('/agents/schedules/:id', authMiddleware, asyncHandler(async (req, res) => {
        const schedule = deleteAgentSchedule(req.params.id, req.user);
        if (!schedule) return res.status(404).json({ error: '智能体计划不存在或无权删除。' });
        logAction(req, '删除智能体计划', `计划ID: ${schedule.id}，名称: ${schedule.name}`);
        res.json({ success: true });
    }));

    router.get('/agents/notifications', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: listAgentNotifications(req.user, normalizeLimit(req.query.limit, 20, 100)) });
    }));

    router.post('/agents/notifications/:id/read', authMiddleware, asyncHandler(async (req, res) => {
        const notification = markAgentNotificationRead(req.params.id, req.user);
        if (!notification) return res.status(404).json({ error: '通知不存在。' });
        res.json({ success: true, notification });
    }));

    router.get('/agents/artifacts', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: listAgentArtifacts(req.user, normalizeLimit(req.query.limit, 30, 100)) });
    }));

    router.get('/agents/artifacts/:id/versions', authMiddleware, asyncHandler(async (req, res) => {
        const result = listAgentArtifactVersions(req.params.id, req.user);
        if (!result) return res.status(404).json({ error: '智能体结果不存在。' });
        res.json(result);
    }));

    router.post('/agents/artifacts/:id/versions', authMiddleware, asyncHandler(async (req, res) => {
        const artifact = createAgentArtifactVersion(req.params.id, req.user, req.body || {});
        if (!artifact) return res.status(404).json({ error: '智能体结果不存在。' });
        logAction(req, '新增智能体结果版本', `结果ID: ${artifact.id}，版本: ${artifact.current_version || '-'}`);
        res.status(201).json({ success: true, artifact });
    }));

    router.get('/agents/artifacts/:id/diff', authMiddleware, asyncHandler(async (req, res) => {
        const result = diffAgentArtifactVersions(req.params.id, req.user, req.query.from, req.query.to);
        if (!result) return res.status(404).json({ error: '智能体结果不存在。' });
        res.json(result);
    }));

    router.post('/agents/artifacts/:id/rollback', authMiddleware, asyncHandler(async (req, res) => {
        const artifact = rollbackAgentArtifactVersion(req.params.id, req.user, req.body?.version, req.body?.note || '');
        if (!artifact) return res.status(404).json({ error: '智能体结果不存在。' });
        logAction(req, '回滚智能体结果版本', `结果ID: ${artifact.id}，目标版本: ${req.body?.version}`);
        res.json({ success: true, artifact });
    }));

    router.get('/agents/runs', authMiddleware, asyncHandler(async (req, res) => {
        const result = listRuns(req.user, {
            page: req.query.page,
            limit: normalizeLimit(req.query.limit, 10, 100),
            status: req.query.status,
            query: req.query.query,
            runType: req.query.runType || req.query.run_type || req.query.type,
            includePreview: req.query.includePreview || req.query.include_preview
        });
        res.json(result);
    }));

    router.get('/agents/runs/deleted/audit', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: listDeletedRunsForAdmin(req.user, normalizeLimit(req.query.limit, 100, 200)) });
    }));

    router.post('/agents/runs', authMiddleware, asyncHandler(async (req, res) => {
        const run = createAgentRun({
            user: req.user,
            goal: req.body?.goal,
            modelId: req.body?.modelId,
            sessionId: req.body?.sessionId,
            title: req.body?.title,
            maxSteps: req.body?.maxSteps,
            priority: req.body?.priority,
            runMode: req.body?.runMode,
            toolPolicy: req.body?.toolPolicy,
            toolAllowlist: req.body?.toolAllowlist,
            approvalPolicy: req.body?.approvalPolicy,
            timeoutMs: req.body?.timeoutMs,
            toolTimeoutMs: req.body?.toolTimeoutMs,
            retryLimit: req.body?.retryLimit,
            maxTokenBudget: req.body?.maxTokenBudget,
            templateId: req.body?.templateId,
            scheduleId: req.body?.scheduleId,
            contextConfig: req.body?.contextConfig,
            metadata: req.body?.metadata,
            dagSpec: req.body?.dagSpec,
            dagInputs: req.body?.dagInputs || req.body?.dag_inputs,
            workflowId: req.body?.workflowId || req.body?.workflow_id,
            workflowVersion: req.body?.workflowVersion || req.body?.workflow_version,
            modelRouter: req.body?.modelRouter || req.body?.model_router
        });
        logAction(req, '创建智能体任务', `任务ID: ${run.id}，目标: ${String(req.body?.goal || '').slice(0, 120)}`);
        res.status(202).json({ success: true, run });
    }));

    router.get('/agents/runs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const detail = getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        res.json(detail);
    }));

    router.post('/agents/runs/:id/workflow-draft', authMiddleware, asyncHandler(async (req, res) => {
        const draft = createWorkflowDraftFromRun(req.params.id, req.user);
        if (!draft) return res.status(404).json({ error: '自由任务不存在或无权访问。' });
        logAction(req, '从自由任务生成工作流草稿', `任务ID: ${req.params.id}，节点数: ${draft.summary?.nodeCount || 0}`);
        res.json({ success: true, draft });
    }));

    router.post('/agents/runs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const run = cancelAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '停止智能体任务', `任务ID: ${run.id}`);
        res.json({ success: true, run, steps: listSteps(run.id) });
    }));

    router.post('/agents/runs/:id/approval', authMiddleware, asyncHandler(async (req, res) => {
        const run = approveAgentTool(req.params.id, req.user, req.body?.approve !== false);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, req.body?.approve === false ? '拒绝智能体工具审批' : '批准智能体工具审批', `任务ID: ${run.id}`);
        res.json({ success: true, run, steps: listSteps(run.id) });
    }));

    router.get('/agents/runs/:id/export', authMiddleware, asyncHandler(async (req, res) => {
        const exported = exportAgentRun(req.params.id, req.user, req.query.format === 'markdown' ? 'markdown' : 'json');
        if (!exported) return res.status(404).json({ error: '智能体任务不存在。' });
        res.setHeader('Content-Type', exported.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
        res.send(exported.body);
    }));

    router.post('/agents/runs/:id/rerun', authMiddleware, asyncHandler(async (req, res) => {
        const run = rerunAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '重新运行智能体任务', `任务ID: ${run.id}，来源任务ID: ${req.params.id}`);
        res.status(202).json({ success: true, run });
    }));

    router.post('/agents/runs/:id/resume', authMiddleware, asyncHandler(async (req, res) => {
        const run = resumeAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '断点续跑智能体任务', `任务ID: ${run.id}，来源任务ID: ${req.params.id}`);
        res.status(202).json({ success: true, run });
    }));

    router.post('/agents/runs/:id/dag/rerun', authMiddleware, asyncHandler(async (req, res) => {
        const run = rerunAgentDagFromNode(req.params.id, req.user, req.body?.nodeId || req.body?.node_id || '');
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '重跑智能体工作流节点', `任务ID: ${run.id}，来源任务ID: ${req.params.id}，节点: ${req.body?.nodeId || req.body?.node_id || '-'}`);
        res.status(202).json({ success: true, run });
    }));

    router.post('/agents/runs/:id/artifacts', authMiddleware, asyncHandler(async (req, res) => {
        const artifact = saveAgentRunArtifact(req.params.id, req.user, req.body || {});
        if (!artifact) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '沉淀智能体结果', `结果ID: ${artifact.id}，任务ID: ${req.params.id}`);
        res.status(201).json({ success: true, artifact });
    }));

    router.delete('/agents/runs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const run = softDeleteAgentRun(req.params.id, req.user, req.body?.reason || '');
        if (!run) return res.status(404).json({ error: '智能体任务记录不存在。' });
        logAction(req, '移除智能体任务记录', `任务ID: ${run.id}，目标: ${String(run.goal || '').slice(0, 120)}`);
        res.json({ success: true, run });
    }));

    return router;
}

module.exports = { createAgentsRouter };
