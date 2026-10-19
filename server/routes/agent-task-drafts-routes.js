'use strict';

const { asyncHandler } = require('../http');
const {
    approveTaskDraft,
    cancelTaskDraft,
    createTaskDraft,
    getTaskDraftForUser,
    listTaskDraftsForUser,
    reviseTaskDraft,
    startTaskDraft
} = require('../services/agent-task-drafts');

function registerAgentTaskDraftRoutes(router, { authMiddleware, automationGuard, logAction, createAgentRun }) {
    // 草案（Draft）是与运行（Run）独立的控制面。规划仅持久化可审阅的契约；
    // 实际执行依然交由 Agent Runtime 负责。
    router.post('/agents/task-drafts', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const draft = await createTaskDraft(req.user, req.body || {});
        logAction(req, '创建 Agent 任务草案', `草案: ${draft.id}，会话: ${draft.sessionId}，状态: ${draft.status}`);
        res.status(201).json({ success: true, data: draft });
    }));
    router.get('/agents/task-drafts', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listTaskDraftsForUser(req.user, { sessionId: req.query.sessionId }) });
    }));
    router.get('/agents/task-drafts/:id', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await getTaskDraftForUser(req.user, req.params.id) });
    }));
    router.patch('/agents/task-drafts/:id', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const draft = await reviseTaskDraft(req.user, req.params.id, req.body || {});
        logAction(req, '修订 Agent 任务草案', `草案: ${draft.id}，修订: ${draft.revision}，状态: ${draft.status}`);
        res.json({ success: true, data: draft });
    }));
    router.post('/agents/task-drafts/:id/approve', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const draft = await approveTaskDraft(req.user, req.params.id, req.body || {});
        logAction(req, '确认 Agent 任务计划', `草案: ${draft.id}，修订: ${draft.revision}，计划摘要: ${draft.planDigest}`);
        res.json({ success: true, data: draft });
    }));
    router.post('/agents/task-drafts/:id/start', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const draft = await startTaskDraft(req.user, req.params.id, req.body || {}, { createAgentRun });
        logAction(req, '启动已确认 Agent 任务', `草案: ${draft.id}，运行: ${draft.runId || draft.run?.id || 'unknown'}`);
        res.json({ success: true, data: draft });
    }));
    router.post('/agents/task-drafts/:id/cancel', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const draft = await cancelTaskDraft(req.user, req.params.id, req.body || {});
        logAction(req, '取消 Agent 任务草案', `草案: ${draft.id}`);
        res.json({ success: true, data: draft });
    }));
}

module.exports = { registerAgentTaskDraftRoutes };
