'use strict';

const { asyncHandler } = require('../http');
const { createAgentEvalSuite, deleteAgentEvalSuite, getAgentEvalRun, getAgentEvalSuite, listAgentEvalSuites, startAgentEvaluation, updateAgentEvalSuite } = require('../services/agent-evaluations');
const { listJudgeProfiles, listJudgeCalibrationMetrics, listJudgeResultsForEvaluation, recordJudgeHumanReview, runJudgesForEvaluation, saveJudgeProfile } = require('../services/agent-judge-governance');

function registerAgentEvaluationRoutes(router, { authMiddleware, logAction, createAgentRun }) {
    router.get('/agents/evaluations/suites', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listAgentEvalSuites(req.user) });
    }));
    router.get('/agents/evaluations/judge-profiles', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listJudgeProfiles(req.user, { includeDisabled: req.query.includeDisabled === 'true' }) });
    }));
    router.get('/agents/evaluations/judge-profiles/calibration', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listJudgeCalibrationMetrics(req.user) });
    }));
    router.post('/agents/evaluations/judge-profiles', authMiddleware, asyncHandler(async (req, res) => {
        const profile = await saveJudgeProfile(req.user, req.body || {});
        logAction(req, '保存评测裁判 Profile', `Profile: ${profile.name}@${profile.version}，模型: ${profile.modelId}，状态: ${profile.status}`);
        res.status(201).json({ success: true, profile });
    }));
    router.post('/agents/evaluations/suites', authMiddleware, asyncHandler(async (req, res) => {
        const evaluation = await createAgentEvalSuite(req.user, req.body || {});
        logAction(req, '创建智能体评测集', `评测集ID: ${evaluation.suite.id}，名称: ${evaluation.suite.name}`);
        res.status(201).json({ success: true, ...evaluation });
    }));
    router.get('/agents/evaluations/runs/:evalRunId', authMiddleware, asyncHandler(async (req, res) => {
        const evaluation = await getAgentEvalRun(req.params.evalRunId, req.user);
        if (!evaluation) return res.status(404).json({ error: '智能体评测批次不存在。' });
        res.json(evaluation);
    }));
    router.get('/agents/evaluations/runs/:evalRunId/judges', authMiddleware, asyncHandler(async (req, res) => {
        const results = await listJudgeResultsForEvaluation(req.params.evalRunId, req.user);
        if (!results) return res.status(404).json({ error: '智能体评测批次不存在。' });
        res.json({ data: results });
    }));
    router.post('/agents/evaluations/runs/:evalRunId/judges', authMiddleware, asyncHandler(async (req, res) => {
        const outcome = await runJudgesForEvaluation(req.params.evalRunId, req.user, req.body?.profileIds || req.body?.profile_ids || []);
        logAction(req, '运行评测独立裁判', `评测批次: ${req.params.evalRunId}，Profile 数: ${outcome.profileIds.length}，结果数: ${outcome.results.length}`);
        res.status(202).json({ success: true, ...outcome });
    }));
    router.post('/agents/evaluations/judges/:judgeResultId/human-review', authMiddleware, asyncHandler(async (req, res) => {
        const review = await recordJudgeHumanReview(req.params.judgeResultId, req.user, req.body || {});
        if (!review) return res.status(404).json({ error: '裁判结果不存在或无权复核。' });
        logAction(req, '人工复核评测裁判', `裁判结果: ${req.params.judgeResultId}，结论: ${review.decision}`);
        res.status(201).json({ success: true, review });
    }));
    router.get('/agents/evaluations/suites/:id', authMiddleware, asyncHandler(async (req, res) => {
        const evaluation = await getAgentEvalSuite(req.params.id, req.user);
        if (!evaluation) return res.status(404).json({ error: '智能体评测集不存在。' });
        res.json(evaluation);
    }));
    router.put('/agents/evaluations/suites/:id', authMiddleware, asyncHandler(async (req, res) => {
        const evaluation = await updateAgentEvalSuite(req.params.id, req.user, req.body || {});
        if (!evaluation) return res.status(404).json({ error: '智能体评测集不存在。' });
        logAction(req, '更新智能体评测集', `评测集ID: ${evaluation.suite.id}，名称: ${evaluation.suite.name}`);
        res.json({ success: true, ...evaluation });
    }));
    router.post('/agents/evaluations/suites/:id/runs', authMiddleware, asyncHandler(async (req, res) => {
        const evaluation = await startAgentEvaluation(req.params.id, req.user, req.body || {}, createAgentRun);
        if (!evaluation) return res.status(404).json({ error: '智能体评测集不存在。' });
        logAction(req, '运行智能体评测集', `评测集ID: ${req.params.id}，批次ID: ${evaluation.run.id}`);
        res.status(202).json({ success: true, ...evaluation });
    }));
    router.delete('/agents/evaluations/suites/:id', authMiddleware, asyncHandler(async (req, res) => {
        const suite = await deleteAgentEvalSuite(req.params.id, req.user);
        if (!suite) return res.status(404).json({ error: '智能体评测集不存在。' });
        logAction(req, '归档智能体评测集', `评测集ID: ${suite.id}，名称: ${suite.name}`);
        res.json({ success: true, suite });
    }));
}

module.exports = { registerAgentEvaluationRoutes };
