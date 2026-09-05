const express = require('express');
const { asyncHandler } = require('../http');
const { queryOne } = require('../db/client');
const { getAgentProfile, listAgentProfileVersions, restoreAgentProfileVersion, updateAgentProfile } = require('../services/agent-profile');
const {
    activatePersonalEvolutionProposal, applyEvolutionProposal, createEvolutionProposal, decideEvolutionProposal,
    listEvolutionProposals, listEvolutionValidations, publishEvolutionProposal,
    rollbackEvolutionProposal, validateEvolutionProposal, pauseEvolutionProposal,
    restoreEvolutionProposal, revokePersonalEvolutionProposal, createEvolutionShareRequest
} = require('../services/agent-evolution');
const { getAgentFeedbackSummary, listAgentFeedback } = require('../services/agent-feedback');
const { createAgentGoal, listAgentGoals, runAgentGoalNow, setAgentGoalStatus, updateAgentGoal } = require('../services/agent-goals');
const { createAgentChannel, deleteAgentChannel, listAgentChannels, updateAgentChannel } = require('../services/agent-channels');
const { listAgentInbox, markInboxItem } = require('../services/agent-inbox');
const { getPersonalWorkbench, updatePersonalWorkbenchShortcuts } = require('../services/personal-workbench');
const { listToolReliability } = require('../services/agent-tool-reliability');
const { deleteAgentPersonalData, exportAgentPersonalData } = require('../services/agent-data');
const {
    approveSkillVersionForSharing, createSkillVersion, listSkillCatalogForUser, listSkillReleasesForUser, listSkillVersionsForUser,
    pauseSkillRelease, publishSkillVersion, publishWorkflowRelease, resumeSkillRelease,
    rollbackSkillRelease, rollbackWorkflowRelease, validateSkillVersion
} = require('../services/agent-releases');
const {
    createSkillVersionFromMarkdown, diffSkillVersions, exportSkillVersionMarkdown,
    listSkillVersionHistory, previewSkillSource
} = require('../services/agent-skill-authoring');
const {
    deleteSkillReleasePermission,
    listSkillReleasePermissions,
    upsertSkillReleasePermission
} = require('../services/agent-skill-access');
const { getAgentQualityDashboard } = require('../services/agent-quality');
const { getAgentImprovementSuggestions } = require('../services/agent-improvement-suggestions');
const { getAgentGovernanceStatus } = require('../services/agent-governance-status');
const {
    getAgentLearningOverview, getAgentLearningSettings, learnAgentRun,
    listAgentLearningJobs, updateAgentLearningSettings
} = require('../services/agent-learning');

function allowedSkillPermissions() {
    const values = String(process.env.AGENT_SKILL_ALLOWED_PERMISSIONS || '').split(',').map(item => item.trim()).filter(Boolean);
    return values.length ? values : undefined;
}

function createAgentControlPlaneRouter({ authMiddleware, logAction, automationLimiter } = {}) {
    const router = express.Router();
    const automationGuard = typeof automationLimiter === 'function' ? automationLimiter : (_req, _res, next) => next();
    const writeLog = typeof logAction === 'function' ? logAction : () => {};

    router.get('/agents/profile', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, profile: await getAgentProfile(req.user.id) })));
    router.get('/agents/profile/versions', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, data: await listAgentProfileVersions(req.user.id, req.query.limit) })));
    router.put('/agents/profile', authMiddleware, asyncHandler(async (req, res) => {
        const profile = await updateAgentProfile(req.user.id, req.body || {}, { expectedVersion: req.body?.expectedVersion ?? req.body?.expected_version, source: req.body?.source || 'user' });
        writeLog(req, '更新个人 Agent 档案', `档案版本: ${profile.version}`);
        res.json({ success: true, profile });
    }));
    router.post('/agents/profile/versions/:version/restore', authMiddleware, asyncHandler(async (req, res) => {
        const profile = await restoreAgentProfileVersion(req.user.id, req.params.version);
        if (!profile) return res.status(404).json({ error: '档案版本不存在。', code: 'PROFILE_VERSION_NOT_FOUND' });
        writeLog(req, '恢复个人 Agent 档案版本', `版本: ${req.params.version}，新版本: ${profile.version}`);
        res.json({ success: true, profile });
    }));

    router.get('/agents/data/export', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, export: await exportAgentPersonalData(req.user) })));
    router.delete('/agents/data', authMiddleware, asyncHandler(async (req, res) => {
        const result = await deleteAgentPersonalData(req.user, { reason: req.body?.reason || 'user_request' });
        writeLog(req, '删除个人 Agent 数据', result);
        res.json({ success: true, result });
    }));

    router.get('/agents/learning/overview', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ success: true, ...(await getAgentLearningOverview(req.user)) });
    }));
    router.get('/agents/learning/jobs', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ success: true, data: await listAgentLearningJobs(req.user, { limit: req.query.limit }) });
    }));
    router.get('/agents/learning/settings', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ success: true, settings: await getAgentLearningSettings(req.user.id) });
    }));
    router.put('/agents/learning/settings', authMiddleware, asyncHandler(async (req, res) => {
        const settings = await updateAgentLearningSettings(req.user.id, req.body || {});
        writeLog(req, '更新 Agent 个人学习设置', JSON.stringify(settings));
        res.json({ success: true, settings });
    }));

    router.get('/agents/goals', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, data: await listAgentGoals(req.user, { status: req.query.status, limit: req.query.limit }) })));
    router.post('/agents/goals', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const result = await createAgentGoal(req.user, req.body || {});
        writeLog(req, '创建 Agent 持续目标', `目标ID: ${result.goal.id}，标题: ${result.goal.title}`);
        res.status(201).json({ success: true, ...result });
    }));
    router.patch('/agents/goals/:id', authMiddleware, asyncHandler(async (req, res) => {
        const goal = await updateAgentGoal(req.params.id, req.user, req.body || {});
        if (!goal) return res.status(404).json({ error: '持续目标不存在或无权修改。', code: 'AGENT_GOAL_NOT_FOUND' });
        writeLog(req, '更新 Agent 持续目标', `目标ID: ${goal.id}，版本: ${goal.version}`);
        res.json({ success: true, goal });
    }));
    for (const [path, status, action] of [['pause', 'paused', '暂停'], ['resume', 'active', '恢复'], ['terminate', 'completed', '终止']]) {
        router.post(`/agents/goals/:id/${path}`, authMiddleware, asyncHandler(async (req, res) => {
            const goal = await setAgentGoalStatus(req.params.id, req.user, status);
            if (!goal) return res.status(404).json({ error: '持续目标不存在或无权操作。' });
            writeLog(req, `${action} Agent 持续目标`, `目标ID: ${goal.id}`);
            res.json({ success: true, goal });
        }));
    }
    router.post('/agents/goals/:id/run', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const goal = await queryOne("SELECT * FROM agent_goals WHERE id = ? AND user_id = ? AND status = 'active'", [req.params.id, req.user.id]);
        if (!goal) return res.status(404).json({ error: '持续目标不存在、已暂停或无权运行。' });
        const run = await runAgentGoalNow(goal, req.user, { triggerType: 'manual', triggerKey: `goal:${goal.id}:manual:${req.get('Idempotency-Key') || Date.now()}` });
        writeLog(req, '手动运行 Agent 持续目标', `目标ID: ${goal.id}，任务ID: ${run.id}`);
        res.status(202).json({ success: true, run });
    }));
    router.delete('/agents/goals/:id', authMiddleware, asyncHandler(async (req, res) => {
        const goal = await setAgentGoalStatus(req.params.id, req.user, 'deleted');
        if (!goal) return res.status(404).json({ error: '持续目标不存在或无权删除。' });
        writeLog(req, '删除 Agent 持续目标', `目标ID: ${goal.id}`);
        res.json({ success: true, goal });
    }));

    router.get('/agents/inbox', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, ...(await listAgentInbox(req.user, { type: req.query.type, limit: req.query.limit })) })));
    router.post('/agents/inbox/:sourceType/:sourceId/:action', authMiddleware, asyncHandler(async (req, res) => {
        const result = await markInboxItem(req.user, req.params.sourceType, req.params.sourceId, req.params.action, req.body || {});
        if (!result) return res.status(404).json({ error: '收件箱条目不存在或无权操作。' });
        res.json({ success: true, item: result });
    }));
    const sendWorkbenchSummary = async (req, res) => {
        res.json({ success: true, dashboard: await getPersonalWorkbench(req.user) });
    };
    router.get('/user/workbench-summary', authMiddleware, asyncHandler(sendWorkbenchSummary));
    // 兼容已接入的旧工作台路径，后续前端统一使用 user/workbench-summary。
    router.get('/agents/workbench', authMiddleware, asyncHandler(sendWorkbenchSummary));
    router.put('/agents/workbench/shortcuts', authMiddleware, asyncHandler(async (req, res) => {
        const shortcuts = await updatePersonalWorkbenchShortcuts(req.user, req.body?.shortcuts);
        res.json({ success: true, shortcuts });
    }));
    router.get('/agents/tools/reliability', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, ...(await listToolReliability(req.user, { days: req.query.days, scope: req.query.scope === 'tenant' && ['admin', 'root'].includes(String(req.user?.role || '').toLowerCase()) ? 'tenant' : 'user', persist: req.query.persist !== 'false' })) })));
    router.get('/agents/improvements', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, ...(await getAgentImprovementSuggestions(req.user, { days: req.query.days })) })));
    router.get('/agents/quality', authMiddleware, asyncHandler(async (req, res) => {
        if (!['admin', 'root'].includes(String(req.user?.role || '').toLowerCase())) return res.status(403).json({ error: '质量仪表盘仅管理员可访问。', code: 'AGENT_QUALITY_ADMIN_REQUIRED' });
        res.json({ success: true, dashboard: await getAgentQualityDashboard(req.user, { days: req.query.days }) });
    }));
    router.get('/agents/governance', authMiddleware, asyncHandler(async (req, res) => {
        if (!['admin', 'root'].includes(String(req.user?.role || '').toLowerCase())) {
            return res.status(403).json({ error: '治理观测仅管理员可访问。', code: 'AGENT_GOVERNANCE_ADMIN_REQUIRED' });
        }
        res.json({ success: true, governance: getAgentGovernanceStatus() });
    }));

    router.get('/agents/channels', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, data: await listAgentChannels(req.user, { status: req.query.status }) })));
    router.post('/agents/channels', authMiddleware, asyncHandler(async (req, res) => {
        const channel = await createAgentChannel(req.user, req.body || {});
        writeLog(req, '创建 Agent 渠道绑定', `渠道ID: ${channel.id}，类型: ${channel.channelType}`);
        res.status(201).json({ success: true, channel });
    }));
    router.post('/agents/channels/:id/test', authMiddleware, asyncHandler(async (req, res) => {
        const { enqueueChannelDelivery, deliverChannelDelivery } = require('../services/agent-channel-adapters');
        const queued = await enqueueChannelDelivery(req.user, { bindingId: req.params.id, eventType: 'channel.test', idempotencyKey: req.get('Idempotency-Key') || `test:${Date.now()}`, subject: 'Pivot 渠道测试', body: String(req.body?.body || '渠道连通性测试').slice(0, 2000), attachments: req.body?.attachments, interaction: { test: true } });
        if (!queued) return res.status(404).json({ error: '渠道不存在或已停用。' });
        const delivery = await deliverChannelDelivery(queued.id);
        res.status(202).json({ success: true, delivery });
    }));
    router.patch('/agents/channels/:id', authMiddleware, asyncHandler(async (req, res) => {
        const channel = await updateAgentChannel(req.params.id, req.user, req.body || {});
        if (!channel) return res.status(404).json({ error: '渠道绑定不存在或无权修改。' });
        res.json({ success: true, channel });
    }));
    router.delete('/agents/channels/:id', authMiddleware, asyncHandler(async (req, res) => {
        const channel = await deleteAgentChannel(req.params.id, req.user);
        if (!channel) return res.status(404).json({ error: '渠道绑定不存在或无权删除。' });
        res.json({ success: true, channel });
    }));

    router.get('/agents/feedback', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, data: await listAgentFeedback(req.user, { limit: req.query.limit }) })));
    router.get('/agents/feedback/summary', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, summary: await getAgentFeedbackSummary(req.user, { days: req.query.days }) })));

    router.post('/agents/evolution/proposals', authMiddleware, asyncHandler(async (req, res) => {
        const proposal = await createEvolutionProposal(req.user, req.body || {});
        writeLog(req, '创建 Agent 进化提议', `提议ID: ${proposal.id}，类型: ${proposal.kind}`);
        res.status(201).json({ success: true, proposal });
    }));
    router.get('/agents/evolution/proposals', authMiddleware, asyncHandler(async (req, res) => res.json({ success: true, data: await listEvolutionProposals(req.user, { status: req.query.status, limit: req.query.limit }) })));
    router.post('/agents/evolution/proposals/:id/decision', authMiddleware, asyncHandler(async (req, res) => {
        const proposal = await decideEvolutionProposal(req.user, req.params.id, req.body?.decision, req.body?.note || req.body?.reviewNote);
        if (!proposal) return res.status(404).json({ error: '进化提议不存在或无权操作。' });
        writeLog(req, proposal.status === 'approved' || proposal.status === 'pending_review' ? '批准 Agent 进化提议' : '拒绝 Agent 进化提议', `提议ID: ${proposal.id}`);
        res.json({ success: true, proposal });
    }));
    router.post('/agents/evolution/proposals/:id/apply', authMiddleware, asyncHandler(async (req, res) => {
        const result = await applyEvolutionProposal(req.user, req.params.id);
        if (!result) return res.status(404).json({ error: '进化提议不存在或无权操作。' });
        if (result.applied) writeLog(req, '应用 Agent 进化提议', `提议ID: ${req.params.id}`);
        res.json({ success: true, ...result });
    }));
    router.post('/agents/evolution/proposals/:id/activate', authMiddleware, asyncHandler(async (req, res) => {
        const result = await activatePersonalEvolutionProposal(req.user, req.params.id);
        if (!result) return res.status(404).json({ error: '个人经验不存在或无权启用。' });
        if (result.activated) writeLog(req, '启用 Agent 个人经验', `提议ID: ${req.params.id}，发布ID: ${result.release?.id || '-'}`);
        res.json({ success: true, ...result });
    }));
    router.get('/agents/evolution/proposals/:id/validations', authMiddleware, asyncHandler(async (req, res) => {
        const data = await listEvolutionValidations(req.user, req.params.id);
        if (!data.length) return res.status(404).json({ error: '进化提议不存在或无权访问。' });
        res.json({ success: true, data });
    }));
    router.post('/agents/evolution/proposals/:id/validate', authMiddleware, asyncHandler(async (req, res) => {
        const result = await validateEvolutionProposal(req.user, req.params.id, req.body || {});
        if (!result) return res.status(404).json({ error: '进化提议不存在或无权验证。' });
        writeLog(req, '验证 Agent 进化提议', `提议ID: ${req.params.id}，结果: ${result.validation.passed ? '通过' : '失败'}`);
        res.status(result.validation.passed ? 200 : 422).json({ success: result.validation.passed, ...result });
    }));
    router.post('/agents/evolution/proposals/:id/publish', authMiddleware, asyncHandler(async (req, res) => {
        const proposal = await publishEvolutionProposal(req.user, req.params.id);
        if (!proposal) return res.status(404).json({ error: '进化提议不存在或无权发布。' });
        writeLog(req, '发布 Agent 进化版本', `提议ID: ${proposal.id}，版本: ${proposal.version}`);
        res.json({ success: true, proposal });
    }));
    router.post('/agents/evolution/proposals/:id/rollback', authMiddleware, asyncHandler(async (req, res) => {
        const result = await rollbackEvolutionProposal(req.user, req.params.id);
        if (!result) return res.status(404).json({ error: '进化提议不存在或无权回滚。' });
        writeLog(req, '回滚 Agent 进化版本', `提议ID: ${req.params.id}，回滚目标: ${result.rollbackTargetId || '无'}`);
        res.json({ success: true, ...result });
    }));
    router.post('/agents/evolution/proposals/:id/pause', authMiddleware, asyncHandler(async (req, res) => {
        const proposal = await pauseEvolutionProposal(req.user, req.params.id);
        if (!proposal) return res.status(404).json({ error: '个人经验不存在、未启用或无权暂停。' });
        writeLog(req, '暂停 Agent 个人经验', `提议ID: ${proposal.id}`);
        res.json({ success: true, proposal });
    }));
    router.post('/agents/evolution/proposals/:id/restore', authMiddleware, asyncHandler(async (req, res) => {
        const proposal = await restoreEvolutionProposal(req.user, req.params.id);
        if (!proposal) return res.status(404).json({ error: '个人经验不存在、未暂停或无权恢复。' });
        writeLog(req, '恢复 Agent 个人经验', `提议ID: ${proposal.id}`);
        res.json({ success: true, proposal });
    }));
    router.post('/agents/evolution/proposals/:id/revoke', authMiddleware, asyncHandler(async (req, res) => {
        const proposal = await revokePersonalEvolutionProposal(req.user, req.params.id);
        if (!proposal) return res.status(404).json({ error: '个人经验不存在、未启用或无权撤销。' });
        writeLog(req, '撤销 Agent 个人经验', `提议ID: ${proposal.id}`);
        res.json({ success: true, proposal });
    }));
    router.post('/agents/evolution/proposals/:id/share-request', authMiddleware, asyncHandler(async (req, res) => {
        const proposal = await createEvolutionShareRequest(req.user, req.params.id);
        if (!proposal) return res.status(404).json({ error: '个人经验不存在、未启用或无权共享。' });
        writeLog(req, '申请共享 Agent 个人经验', `提议ID: ${proposal.id}`);
        res.status(201).json({ success: true, proposal });
    }));
    router.get('/agents/skills/versions', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ success: true, data: await listSkillVersionsForUser(req.user, { limit: req.query.limit }) });
    }));
    router.get('/agents/skills/releases', authMiddleware, asyncHandler(async (req, res) => {
        const rows = await listSkillReleasesForUser(req.user, { limit: req.query.limit });
        res.json({
            success: true,
            data: rows.map(row => ({
                ...row,
                manifest_yaml: undefined,
                target_user_ids: typeof row.target_user_ids === 'string' ? JSON.parse(row.target_user_ids || '[]') : row.target_user_ids,
                target_units: typeof row.target_units === 'string' ? JSON.parse(row.target_units || '[]') : row.target_units,
                breaker_thresholds: typeof row.breaker_thresholds === 'string' ? JSON.parse(row.breaker_thresholds || '{}') : row.breaker_thresholds
            }))
        });
    }));
    router.get('/agents/skills/releases/:id/permissions', authMiddleware, asyncHandler(async (req, res) => {
        const result = await listSkillReleasePermissions(req.params.id, req.user);
        if (!result) return res.status(404).json({ error: 'Skill 发布不存在或无权管理。' });
        res.json({ success: true, release: result.release, data: result.permissions });
    }));
    router.put('/agents/skills/releases/:id/permissions', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const permission = await upsertSkillReleasePermission(req.params.id, req.user, req.body || {});
        if (!permission) return res.status(404).json({ error: 'Skill 发布不存在或无权管理。' });
        writeLog(req, '更新 Skill 发布授权', `发布ID: ${req.params.id}，主体: ${permission.subject_type}:${permission.subject_id}，动作: ${permission.action}，效果: ${permission.effect}`);
        res.status(201).json({ success: true, permission });
    }));
    router.delete('/agents/skills/releases/:id/permissions/:permissionId', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const deleted = await deleteSkillReleasePermission(req.params.id, req.params.permissionId, req.user);
        if (!deleted) return res.status(404).json({ error: 'Skill 授权不存在或无权管理。' });
        writeLog(req, '删除 Skill 发布授权', `发布ID: ${req.params.id}，授权ID: ${req.params.permissionId}`);
        res.json({ success: true });
    }));
    router.get('/agents/skills/catalog', authMiddleware, asyncHandler(async (req, res) => {
        const rows = await listSkillCatalogForUser(req.user, { limit: req.query.limit });
        res.json({ success: true, data: rows.map(row => ({ id: row.id, name: row.name, rollout_scope: row.rollout_scope, rollout_percent: row.rollout_percent, status: row.status, published_at: row.published_at, version: row.version, digest: row.digest, content_digest: row.content_digest })) });
    }));
    router.post('/agents/skills/source/preview', authMiddleware, asyncHandler(async (req, res) => {
        // 预览只做解析与严格校验，不落库；错误清单直接回传给编辑器。
        res.json({ success: true, preview: previewSkillSource(String(req.body?.markdown || '')) });
    }));
    router.post('/agents/skills/source', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const result = await createSkillVersionFromMarkdown(req.user, req.body || {});
        writeLog(req, '从 SKILL.md 创建技能版本草稿', `技能: ${result.version.name}@${result.version.version}`);
        res.status(201).json({ success: true, version: result.version, preview: result.preview });
    }));
    router.get('/agents/skills/versions/:id/source', authMiddleware, asyncHandler(async (req, res) => {
        const exported = await exportSkillVersionMarkdown(req.user, req.params.id);
        if (!exported) return res.status(404).json({ error: 'Skill 版本不存在或无权访问。' });
        res.json({ success: true, markdown: exported.markdown, version: exported.version });
    }));
    router.get('/agents/skills/versions/:id/history', authMiddleware, asyncHandler(async (req, res) => {
        const history = await listSkillVersionHistory(req.user, req.params.id);
        if (!history) return res.status(404).json({ error: 'Skill 版本不存在或无权访问。' });
        res.json({ success: true, ...history });
    }));
    router.get('/agents/skills/versions/:id/diff/:targetId', authMiddleware, asyncHandler(async (req, res) => {
        const diff = await diffSkillVersions(req.user, req.params.id, req.params.targetId);
        if (!diff) return res.status(404).json({ error: '对比的 Skill 版本不存在或无权访问。' });
        res.json({ success: true, diff });
    }));
    router.post('/agents/skills/versions', authMiddleware, asyncHandler(async (req, res) => {
        const version = await createSkillVersion(req.user, req.body || {});
        res.status(201).json({ success: true, version });
    }));
    router.post('/agents/skills/versions/:id/validate', authMiddleware, asyncHandler(async (req, res) => {
        const result = await validateSkillVersion(req.params.id, req.user, { ...(req.body || {}), requireSignature: false, publicKey: process.env.AGENT_SKILL_PUBLIC_KEY || '', allowedPermissions: allowedSkillPermissions() });
        if (!result) return res.status(404).json({ error: 'Skill 版本不存在或无权访问。' });
        res.status(result.passed ? 200 : 422).json({ success: result.passed, ...result });
    }));
    router.post('/agents/skills/versions/:id/approve-shared', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const result = await approveSkillVersionForSharing(req.params.id, req.user, req.body || {});
        if (!result) return res.status(404).json({ error: 'Skill 版本不存在或无权批准。' });
        writeLog(req, '批准并组织签名共享 Skill', `技能: ${result.version.name}@${result.version.version}，签名密钥: ${result.envelope.keyId}`);
        res.json({ success: true, ...result });
    }));
    router.post('/agents/skills/versions/:id/publish', authMiddleware, asyncHandler(async (req, res) => {
        const release = await publishSkillVersion(req.params.id, req.user, req.body || {});
        if (!release) return res.status(404).json({ error: 'Skill 版本不存在或无权发布。' });
        const action = release.autoApproved ? '自动批准、组织签名并发布共享 Skill' : '发布 Agent Skill';
        const detail = release.autoApproved
            ? `发布ID: ${release.id}，组织签名密钥: ${release.organizationSigningKeyId || 'organization-default'}`
            : `发布ID: ${release.id}`;
        writeLog(req, action, detail);
        res.json({ success: true, release });
    }));
    router.post('/agents/skills/releases/:id/rollback', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const release = await rollbackSkillRelease(req.params.id, req.user);
        if (!release) return res.status(404).json({ error: 'Skill 发布不存在或无权回滚。' });
        writeLog(req, '回滚 Agent Skill 发布', `发布ID: ${req.params.id}`);
        res.json({ success: true, release });
    }));
    router.post('/agents/skills/releases/:id/pause', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const reason = String(req.body?.reason || '').slice(0, 200);
        const release = await pauseSkillRelease(req.params.id, req.user, reason);
        if (!release) return res.status(404).json({ error: 'Skill 发布不存在、非发布态或无权暂停。' });
        writeLog(req, '暂停 Agent Skill 发布', `发布ID: ${req.params.id}，原因: ${reason || '未说明'}`);
        res.json({ success: true, release });
    }));
    router.post('/agents/skills/releases/:id/resume', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const release = await resumeSkillRelease(req.params.id, req.user);
        if (!release) return res.status(404).json({ error: 'Skill 发布不存在、非暂停态或无权恢复。' });
        writeLog(req, '恢复 Agent Skill 发布', `发布ID: ${req.params.id}`);
        res.json({ success: true, release });
    }));
    router.post('/agents/workflows/:id/releases', authMiddleware, asyncHandler(async (req, res) => {
        const release = await publishWorkflowRelease(req.params.id, req.user, req.body || {});
        if (!release) return res.status(404).json({ error: '工作流不存在或无权发布。' });
        res.json({ success: true, release });
    }));
    router.post('/agents/workflows/releases/:id/rollback', authMiddleware, asyncHandler(async (req, res) => {
        const release = await rollbackWorkflowRelease(req.params.id, req.user);
        if (!release) return res.status(404).json({ error: '工作流发布不存在或无权回滚。' });
        res.json({ success: true, release });
    }));
    router.get('/agents/workflows/:id/releases', authMiddleware, asyncHandler(async (req, res) => {
        const rows = await require('../db/client').query(`SELECT r.*, v.version, v.note FROM agent_workflow_releases r JOIN agent_workflow_versions v ON v.id = r.workflow_version_id WHERE r.workflow_id = ? ORDER BY r.published_at DESC LIMIT ?`, [req.params.id, Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 100, 200))]);
        res.json({ success: true, data: rows });
    }));
    router.post('/agents/runs/:id/evolution-proposals', authMiddleware, asyncHandler(async (req, res) => {
        const proposal = await createEvolutionProposal(req.user, { ...(req.body || {}), sourceRunId: req.params.id });
        writeLog(req, '从 Agent 任务创建进化提议', `任务ID: ${req.params.id}，提议ID: ${proposal.id}`);
        res.status(201).json({ success: true, proposal });
    }));
    router.post('/agents/runs/:id/learn', authMiddleware, asyncHandler(async (req, res) => {
        const result = await learnAgentRun(req.user, req.params.id, { kind: req.body?.kind, title: req.body?.title, runNow: req.body?.runNow !== false });
        if (!result.scheduled && result.reason === 'run_not_found') return res.status(404).json({ error: '任务不存在或无权学习。' });
        writeLog(req, '从 Agent 任务学习个人经验', `任务ID: ${req.params.id}，学习任务: ${result.job?.id || result.job?.id || '-'}`);
        res.status(202).json({ success: true, ...result });
    }));
    return router;
}

module.exports = { createAgentControlPlaneRouter };
