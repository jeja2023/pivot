const express = require('express');
const { asyncHandler, normalizeLimit } = require('../http');
const { queryOne } = require('../db/client');
const { createAgentControlPlaneRouter } = require('./agent-control-plane');
const { isSuperAdmin } = require('../permissions');
const { parseJsonObject } = require('../services/agent-validators');
const { listStrategies: listModelRouterStrategies } = require('../services/model-router');
const {
    createWorkflowDraftFromRun,
    getRunDetailForUser,
    listDeletedRunsForAdmin,
    listRuns,
    listSteps,
    updateAgentRunTitleAndGoalForUser
} = require('../services/agent-runs');
const { preflightAgentRun } = require('../services/agent-preflight');
const { getAgentWorkflowForUser, resolveAgentWorkflowVersion } = require('../services/agent-workflows');
const {
    getAgentWorkflowDependencyConfiguration,
    saveAgentWorkflowDependencyConfiguration
} = require('../services/agent-workflow-dependencies');
const { getAgentTraceForUser } = require('../services/agent-traces');
const { listAgentCheckpointsForUser } = require('../services/agent-checkpoints');
const { getAgentEventCursorForUser, listAgentEventsForUser, replayAgentEventsForUser } = require('../services/agent-event-log');
const {
    listAgentContextWindowsForUser,
    listAgentWorldStateSnapshotsForUser
} = require('../services/agent-world-state-store');
const {
    acknowledgeAgentControlMessage,
    listAgentControlMessages,
    sendAgentControlMessage
} = require('../services/agent-control');
const { getAgentRunResources } = require('../services/agent-run-resources');
const { listAgentToolCalls } = require('../services/agent-tool-audit');
const { listChatAgentRunsForSession } = require('../services/chat-agent-bridge');
const { compileTraceToWorkflow } = require('../services/agent-trace-compiler');
const { disableAgentSkill, listAgentSkillsForUser } = require('../services/agent-skills');
const { installSkillPackage, verifySkillPackage } = require('../services/agent-skill-packages');
const { listRuntimePacks, syncRuntimePack } = require('../services/agent-runtime-packs');
const { createAgentResidencyStore } = require('../services/agent-residency');
const {
    createAgentEvalSuite,
    deleteAgentEvalSuite,
    getAgentEvalRun,
    getAgentEvalSuite,
    listAgentEvalSuites,
    startAgentEvaluation,
    updateAgentEvalSuite
} = require('../services/agent-evaluations');
const { formatToolList } = require('../services/agent-tool-catalog');
const { executeToolByName, findAgentToolByName } = require('../services/agent-tool-runtime');
const { recordAgentFeedback } = require('../services/agent-feedback');
const { createSkillVersion } = require('../services/agent-releases');
const { publishWorkflowRelease } = require('../services/agent-releases');
const { buildDelegationContext, listCollaboratorRuns, normalizeDelegationInput } = require('../services/agent-collaboration');
const {
    createWorkflowCredential,
    deleteWorkflowCredential,
    listWorkflowCredentials,
    revertWorkflowCredentialRotation,
    rotateWorkflowCredential,
    updateWorkflowCredential
} = require('../services/workflow-credentials');
const {
    decideWorkflowApprovalRequest,
    listWorkflowApprovalRequests
} = require('../services/agent-approval-requests');
const {
    cancelAgentRun,
    approveAgentTool,
    createAgentArtifactVersion,
    createAgentSchedule,
    createAgentTemplate,
    createAgentRun,
    createAgentWorkflow,
    createWorkflowTrigger,
    deleteAgentSchedule,
    deleteAgentTemplate,
    deleteAgentWorkflow,
    deleteWorkflowTrigger,
    diffAgentArtifactVersions,
    diffAgentWorkflowVersions,
    exportAgentRun,
    listAgentArtifacts,
    listAgentArtifactVersions,
    listAgentNotifications,
    listAgentSchedules,
    listAgentTemplates,
    listAgentWorkflowShareOptions,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    listWorkflowTriggers,
    getAgentMetrics,
    getAgentRuntimeStatus,
    markAgentNotificationRead,
    rerunAgentRun,
    rerunAgentDagFromNode,
    resumeAgentRun,
    restoreAgentWorkflow,
    restoreAgentWorkflowVersion,
    rollbackAgentArtifactVersion,
    rotateWorkflowTriggerToken,
    runAgentScheduleNow,
    saveAgentRunArtifact,
    softDeleteAgentRun
    ,
    updateAgentSchedule,
    updateAgentTemplate,
    updateAgentWorkflow,
    updateAgentWorkflowMetadata,
    updateAgentWorkflowSharing,
    updateWorkflowTrigger
} = require('../services/agent-runtime');

function createAgentsRouter({ authMiddleware, logAction, automationLimiter, uploadLimiter, skillUpload }) {
    const router = express.Router();
    const automationGuard = typeof automationLimiter === 'function' ? automationLimiter : (req, res, next) => next();
    const residency = createAgentResidencyStore();
    router.use(createAgentControlPlaneRouter({ authMiddleware, logAction, automationLimiter }));

    router.get('/agents/tools', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ tools: await formatToolList(req.user) });
    }));

    router.get('/agents/skills', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listAgentSkillsForUser(req.user, { includeDisabled: req.query.includeDisabled === 'true' }) });
    }));

    router.post('/agents/skills', authMiddleware, asyncHandler(async (req, res) => {
        const allowedPermissions = String(process.env.AGENT_SKILL_ALLOWED_PERMISSIONS || '')
            .split(',').map(item => item.trim()).filter(Boolean);
        const version = await createSkillVersion(req.user, {
            manifest: req.body?.manifest || req.body?.manifestYaml,
            instructions: req.body?.instructions || '',
            // The client cannot widen the permission set. An empty server-side
            // allowlist intentionally rejects manifests that request privileges.
            allowedPermissions,
            requireSignature: process.env.AGENT_SKILL_REQUIRE_SIGNATURE !== 'false' || req.body?.requireSignature === true,
            publicKey: process.env.AGENT_SKILL_PUBLIC_KEY || ''
        });
        logAction(req, '创建 Agent Skill 版本草稿', `Skill: ${version.name}@${version.version}`);
        res.status(201).json({ success: true, version, status: 'draft' });
    }));

    router.post('/agents/skills/package', authMiddleware, uploadLimiter || ((_req, _res, next) => next()), ...(skillUpload?.single ? skillUpload.single('file') : []), asyncHandler(async (req, res) => {
        if (!req.file?.path) return res.status(400).json({ error: '请选择 .skill.zip 文件。' });
        try {
            const allowedPermissions = String(process.env.AGENT_SKILL_ALLOWED_PERMISSIONS || '')
                .split(',').map(item => item.trim()).filter(Boolean);
            const verified = await verifySkillPackage(req.file.path, {
                allowedPermissions,
                requireSignature: process.env.AGENT_SKILL_REQUIRE_SIGNATURE !== 'false',
                publicKey: process.env.AGENT_SKILL_PUBLIC_KEY || ''
            });
            const installed = await installSkillPackage(req.file.path, {
                allowedPermissions,
                requireSignature: process.env.AGENT_SKILL_REQUIRE_SIGNATURE !== 'false',
                publicKey: process.env.AGENT_SKILL_PUBLIC_KEY || '',
                installRoot: process.env.AGENT_SKILL_ROOT
            });
            const version = await createSkillVersion(req.user, {
                manifest: verified.manifest.manifest,
                instructions: verified.package.instructions,
                packageRoot: installed.installDir,
                allowedPermissions,
                requireSignature: process.env.AGENT_SKILL_REQUIRE_SIGNATURE !== 'false',
                signatureVerified: Boolean(verified.signatureValid),
                publicKey: process.env.AGENT_SKILL_PUBLIC_KEY || ''
            });
            logAction(req, '导入 Agent Skill 包草稿', `Skill: ${version.name}@${version.version}，包摘要: ${installed.package.digest}`);
            res.status(201).json({ success: true, version, package: { digest: installed.package.digest, installDir: installed.installDir, bytes: installed.package.bytes }, status: 'draft' });
        } finally {
            try { require('fs').rmSync(req.file.path, { force: true }); } catch (_) {}
        }
    }));

    router.get('/agents/runtime-packs', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listRuntimePacks({ root: process.env.PIVOT_RUNTIME_PACK_ROOT }) });
    }));

    router.post('/agents/runtime-packs/sync', authMiddleware, asyncHandler(async (req, res) => {
        if (!['admin', 'root'].includes(String(req.user?.role || '').toLowerCase())) return res.status(403).json({ error: '只有管理员可以同步运行时资源包。' });
        const result = await syncRuntimePack(req.body?.manifest || {}, { root: process.env.PIVOT_RUNTIME_PACK_ROOT, networkPolicy: req.body?.networkPolicy || req.body?.network_policy });
        logAction(req, '同步 Agent 运行时资源包', `资源包: ${result.manifest.id}@${result.manifest.version}`);
        res.status(201).json({ success: true, pack: { type: result.manifest.type, id: result.manifest.id, version: result.manifest.version, sha256: result.manifest.sha256, target: result.target } });
    }));

    router.post('/agents/skills/:name/disable', authMiddleware, asyncHandler(async (req, res) => {
        const changes = await disableAgentSkill(req.params.name, req.user);
        if (!changes) return res.status(404).json({ error: 'Skill 不存在或无权操作。' });
        logAction(req, '停用 Agent Skill', `Skill: ${req.params.name}`);
        res.json({ success: true });
    }));

    router.post('/agents/tools/test', authMiddleware, asyncHandler(async (req, res) => {
        const toolName = String(req.body?.tool || '').trim();
        const input = req.body?.input && typeof req.body.input === 'object' && !Array.isArray(req.body.input) ? req.body.input : {};
        const tools = await formatToolList(req.user);
        const tool = findAgentToolByName(toolName, tools);
        if (!tool) return res.status(403).json({ error: '工具不可用或无权访问。' });
        if (['workflow.approval', 'workflow.delay', 'workflow.subworkflow'].includes(toolName)) {
            return res.status(400).json({ error: '人工审批、延时和子工作流节点需要在完整工作流中测试。' });
        }
        const startedAt = Date.now();
        const output = await executeToolByName(toolName, input, req.user, tools, {
            dagInputs: req.body?.dagInputs && typeof req.body.dagInputs === 'object' ? req.body.dagInputs : {}
        });
        logAction(req, '测试智能体工具节点', `工具: ${toolName}`);
        res.json({ success: true, output, durationMs: Date.now() - startedAt });
    }));

    // 公开支持的模型路由策略，供前端下拉填充
    router.get('/agents/model-routers', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ strategies: listModelRouterStrategies() });
    }));

    router.get('/agents/runtime', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await getAgentRuntimeStatus(req.user));
    }));

    router.get('/agents/residencies', authMiddleware, asyncHandler(async (req, res) => {
        const allUsers = String(req.query.scope || '').toLowerCase() === 'all' && isSuperAdmin(req.user);
        const data = allUsers
            ? await residency.listAllResidents({ status: req.query.status, limit: req.query.limit })
            : await residency.listResidents({ user: req.user, status: req.query.status, limit: req.query.limit });
        res.json({
            data,
            scope: allUsers ? 'all' : 'self',
            config: residency.config
        });
    }));

    router.post('/agents/residencies/sweep', authMiddleware, asyncHandler(async (req, res) => {
        const allUsers = String(req.body?.scope || '').toLowerCase() === 'all' && isSuperAdmin(req.user);
        const evicted = await residency.sweepResidents({ userId: allUsers ? null : req.user.id });
        logAction(req, '清理 Agent Residency', `范围: ${allUsers ? '全部用户' : '当前用户'}，清理数量: ${evicted}`);
        res.json({ success: true, evicted, scope: allUsers ? 'all' : 'self' });
    }));

    router.post('/agents/residencies/:residentId/evict', authMiddleware, asyncHandler(async (req, res) => {
        const allUsers = String(req.body?.scope || '').toLowerCase() === 'all' && isSuperAdmin(req.user);
        const resident = allUsers
            ? await residency.evictResidentForAdmin({ residentId: req.params.residentId })
            : await residency.evictResident({ user: req.user, residentId: req.params.residentId });
        if (!resident) return res.status(404).json({ error: '常驻 Agent 不存在或无权操作。' });
        logAction(req, '驱逐 Agent Residency', `常驻实例: ${resident.resident_id}`);
        res.json({ success: true, data: resident });
    }));

    router.get('/agents/metrics', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await getAgentMetrics(req.user, req.query.days));
    }));

    router.get('/agents/evaluations/suites', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listAgentEvalSuites(req.user) });
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

    router.post('/agents/preflight', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await preflightAgentRun(req.user, req.body || {}));
    }));

    router.get('/agents/templates', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listAgentTemplates(req.user) });
    }));

    router.post('/agents/templates', authMiddleware, asyncHandler(async (req, res) => {
        const template = await createAgentTemplate(req.user, req.body || {});
        logAction(req, '创建智能体模板', `模板ID: ${template.id}，名称: ${template.name}`);
        res.status(201).json({ success: true, template });
    }));

    router.put('/agents/templates/:id', authMiddleware, asyncHandler(async (req, res) => {
        const template = await updateAgentTemplate(req.params.id, req.user, req.body || {});
        if (!template) return res.status(404).json({ error: '智能体模板不存在或无权修改。' });
        logAction(req, '更新智能体模板', `模板ID: ${template.id}，名称: ${template.name}`);
        res.json({ success: true, template });
    }));

    router.delete('/agents/templates/:id', authMiddleware, asyncHandler(async (req, res) => {
        const template = await deleteAgentTemplate(req.params.id, req.user);
        if (!template) return res.status(404).json({ error: '智能体模板不存在或无权删除。' });
        logAction(req, '删除智能体模板', `模板ID: ${template.id}，名称: ${template.name}`);
        res.json({ success: true });
    }));

    router.get('/agents/workflows', authMiddleware, asyncHandler(async (req, res) => {
        const data = await listAgentWorkflows(req.user, { query: req.query.query });
        res.json({ data, total: data.length });
    }));

    router.get('/agents/workflows/share-options', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await listAgentWorkflowShareOptions(req.user));
    }));

    router.get('/agents/workflows/:id/dependencies', authMiddleware, asyncHandler(async (req, res) => {
        const resolved = await resolveAgentWorkflowVersion(req.params.id, req.user, 'published');
        if (!resolved) return res.status(404).json({ error: '共享工作流不存在、无权访问或尚未发布。' });
        res.json(await getAgentWorkflowDependencyConfiguration(resolved, req.user));
    }));

    router.put('/agents/workflows/:id/dependencies', authMiddleware, asyncHandler(async (req, res) => {
        const resolved = await resolveAgentWorkflowVersion(req.params.id, req.user, 'published');
        if (!resolved) return res.status(404).json({ error: '共享工作流不存在、无权访问或尚未发布。' });
        const configuration = await saveAgentWorkflowDependencyConfiguration(resolved, req.user, req.body || {});
        logAction(req, '确认共享工作流依赖映射', `工作流ID: ${resolved.workflow.id}，发布版本: ${resolved.version}`);
        res.json({ success: true, ...configuration });
    }));

    router.post('/agents/workflows', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = await createAgentWorkflow(req.user, req.body || {});
        logAction(req, '保存智能体工作流', `工作流ID: ${workflow.id}，名称: ${workflow.name}，版本: ${workflow.current_version}`);
        res.status(201).json({ success: true, workflow });
    }));

    router.put('/agents/workflows/:id', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = await updateAgentWorkflow(req.params.id, req.user, req.body || {});
        if (!workflow) return res.status(404).json({ error: '智能体工作流不存在或无权修改。' });
        logAction(req, '更新智能体工作流', `工作流ID: ${workflow.id}，名称: ${workflow.name}，版本: ${workflow.current_version}`);
        res.json({ success: true, workflow });
    }));

    router.patch('/agents/workflows/:id/metadata', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = await updateAgentWorkflowMetadata(req.params.id, req.user, req.body || {});
        if (!workflow) return res.status(404).json({ error: '智能体工作流不存在或无权修改。' });
        logAction(req, '更新智能体工作流信息', `工作流ID: ${workflow.id}，名称: ${workflow.name}`);
        res.json({ success: true, workflow });
    }));

    router.patch('/agents/workflows/:id/sharing', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = await updateAgentWorkflowSharing(req.params.id, req.user, req.body || {});
        if (!workflow) return res.status(404).json({ error: '智能体工作流不存在或无权修改共享设置。' });
        logAction(req, '更新智能体工作流共享设置', `工作流ID: ${workflow.id}，范围: ${workflow.scope}，单位: ${(workflow.allowed_units || []).join(',') || '-'}，个人: ${(workflow.allowed_user_ids || []).join(',') || '-'}`);
        res.json({ success: true, workflow });
    }));

    router.post('/agents/workflows/:id/publish', authMiddleware, asyncHandler(async (req, res) => {
        const release = await publishWorkflowRelease(req.params.id, req.user, { ...(req.body || {}), version: req.body?.version || 'current', fixedEvaluationRequired: req.body?.fixedEvaluationRequired !== false });
        if (!release) return res.status(404).json({ error: '智能体工作流或目标版本不存在。' });
        const workflow = await getAgentWorkflowForUser(req.params.id, req.user);
        logAction(req, '发布智能体工作流版本', `工作流ID: ${req.params.id}，发布版本: ${workflow?.published_version || '-'}`);
        res.json({ success: true, workflow, release });
    }));

    router.get('/agents/workflows/:id/versions', authMiddleware, asyncHandler(async (req, res) => {
        const versions = await listAgentWorkflowVersions(req.params.id, req.user);
        if (!versions) return res.status(404).json({ error: '智能体工作流不存在。' });
        res.json({ data: versions });
    }));

    router.get('/agents/workflows/:id/diff', authMiddleware, asyncHandler(async (req, res) => {
        const diff = await diffAgentWorkflowVersions(req.params.id, req.user, req.query.from, req.query.to || 'current');
        if (!diff) return res.status(404).json({ error: '智能体工作流或版本不存在。' });
        res.json(diff);
    }));

    router.post('/agents/workflows/:id/versions/:version/restore', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = await restoreAgentWorkflowVersion(req.params.id, req.user, req.params.version);
        if (!workflow) return res.status(404).json({ error: '智能体工作流或目标版本不存在。' });
        logAction(req, '回滚智能体工作流版本', `工作流ID: ${workflow.id}，当前版本: ${workflow.current_version}`);
        res.json({ success: true, workflow });
    }));

    router.delete('/agents/workflows/:id', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = await deleteAgentWorkflow(req.params.id, req.user);
        if (!workflow) return res.status(404).json({ error: '智能体工作流不存在或无权删除。' });
        logAction(req, '删除智能体工作流', `工作流ID: ${workflow.id}，名称: ${workflow.name}`);
        res.json({ success: true, workflow: { id: workflow.id, name: workflow.name } });
    }));

    // 恢复已删除工作流
    router.patch('/agents/workflows/:id/restore', authMiddleware, asyncHandler(async (req, res) => {
        const workflow = await restoreAgentWorkflow(req.params.id, req.user);
        if (!workflow) return res.status(404).json({ error: '工作流不存在、未删除或已超过 30 天恢复期限。' });
        logAction(req, '恢复智能体工作流', `工作流ID: ${workflow.id}，名称: ${workflow.name}`);
        res.json({ success: true, workflow });
    }));

    // 工作流触发器：入站 Webhook、文件落地和数据变更三类触发方式的管理入口
    router.get('/agents/triggers', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listWorkflowTriggers(req.user) });
    }));

    router.post('/agents/triggers', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const { trigger, token } = await createWorkflowTrigger(req.user, req.body || {});
        logAction(req, '创建工作流触发器', `触发器ID: ${trigger.id}，名称: ${trigger.name}，方式: ${trigger.trigger_type}`);
        // 明文令牌只在创建时返回一次，之后无法再次查看
        res.status(201).json({ success: true, trigger, token });
    }));

    router.put('/agents/triggers/:id', authMiddleware, asyncHandler(async (req, res) => {
        const trigger = await updateWorkflowTrigger(req.params.id, req.user, req.body || {});
        if (!trigger) return res.status(404).json({ error: '触发器不存在或无权修改。' });
        logAction(req, '更新工作流触发器', `触发器ID: ${trigger.id}，名称: ${trigger.name}`);
        res.json({ success: true, trigger });
    }));

    router.post('/agents/triggers/:id/rotate-token', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const result = await rotateWorkflowTriggerToken(req.params.id, req.user);
        if (!result) return res.status(404).json({ error: '触发器不存在或无权操作。' });
        logAction(req, '轮换工作流触发器令牌', `触发器ID: ${result.trigger.id}，名称: ${result.trigger.name}`);
        res.json({ success: true, trigger: result.trigger, token: result.token });
    }));

    router.delete('/agents/triggers/:id', authMiddleware, asyncHandler(async (req, res) => {
        const trigger = await deleteWorkflowTrigger(req.params.id, req.user);
        if (!trigger) return res.status(404).json({ error: '触发器不存在或无权删除。' });
        logAction(req, '删除工作流触发器', `触发器ID: ${trigger.id}，名称: ${trigger.name}`);
        res.json({ success: true, trigger: { id: trigger.id, name: trigger.name } });
    }));

    // 工作流凭据库：加密落库，明文只在运行时注入，接口只返回元数据
    router.get('/agents/credentials', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listWorkflowCredentials(req.user) });
    }));

    router.post('/agents/credentials', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const credential = await createWorkflowCredential(req.user, req.body || {});
        logAction(req, '创建工作流凭据', `凭据ID: ${credential.id}，引用名: ${credential.slug}`);
        res.status(201).json({ success: true, credential });
    }));

    router.put('/agents/credentials/:id', authMiddleware, asyncHandler(async (req, res) => {
        const credential = await updateWorkflowCredential(req.params.id, req.user, req.body || {});
        if (!credential) return res.status(404).json({ error: '凭据不存在或无权修改。' });
        logAction(req, '更新工作流凭据', `凭据ID: ${credential.id}，引用名: ${credential.slug}`);
        res.json({ success: true, credential });
    }));

    router.post('/agents/credentials/:id/rotate', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const credential = await rotateWorkflowCredential(req.params.id, req.user, req.body || {});
        if (!credential) return res.status(404).json({ error: '凭据不存在或无权操作。' });
        logAction(req, '轮换工作流凭据', `凭据ID: ${credential.id}，引用名: ${credential.slug}，版本: ${credential.version}`);
        res.json({ success: true, credential });
    }));

    router.post('/agents/credentials/:id/revert', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const credential = await revertWorkflowCredentialRotation(req.params.id, req.user);
        if (!credential) return res.status(404).json({ error: '凭据不存在或无权操作。' });
        logAction(req, '撤销工作流凭据轮换', `凭据ID: ${credential.id}，引用名: ${credential.slug}，版本: ${credential.version}`);
        res.json({ success: true, credential });
    }));

    router.delete('/agents/credentials/:id', authMiddleware, asyncHandler(async (req, res) => {
        const credential = await deleteWorkflowCredential(req.params.id, req.user);
        if (!credential) return res.status(404).json({ error: '凭据不存在或无权删除。' });
        logAction(req, '删除工作流凭据', `凭据ID: ${credential.id}，引用名: ${credential.slug}`);
        res.json({ success: true, credential: { id: credential.id, slug: credential.slug } });
    }));

    router.get('/agents/schedules', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listAgentSchedules(req.user) });
    }));

    router.post('/agents/schedules', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const schedule = await createAgentSchedule(req.user, req.body || {});
        const cfg = parseJsonObject(schedule.run_config) || {};
        const isWorkflow = cfg.runMode === 'dag' || Boolean(cfg.workflowId);
        logAction(req, isWorkflow ? '创建工作流计划' : '创建智能体计划', `计划ID: ${schedule.id}，名称: ${schedule.name}${cfg.workflowId ? `，工作流ID: ${cfg.workflowId}` : ''}`);
        res.status(201).json({ success: true, schedule });
    }));

    router.put('/agents/schedules/:id', authMiddleware, asyncHandler(async (req, res) => {
        const schedule = await updateAgentSchedule(req.params.id, req.user, req.body || {});
        if (!schedule) return res.status(404).json({ error: '智能体计划不存在或无权修改。' });
        const cfg = parseJsonObject(schedule.run_config) || {};
        const isWorkflow = cfg.runMode === 'dag' || Boolean(cfg.workflowId);
        logAction(req, isWorkflow ? '更新工作流计划' : '更新智能体计划', `计划ID: ${schedule.id}，名称: ${schedule.name}${cfg.workflowId ? `，工作流ID: ${cfg.workflowId}` : ''}`);
        res.json({ success: true, schedule });
    }));

    router.post('/agents/schedules/:id/run', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const schedule = await queryOne('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [req.params.id, req.user.id]);
        const run = await runAgentScheduleNow(req.params.id, req.user, { idempotencyKey: req.get('Idempotency-Key') });
        if (!run) return res.status(404).json({ error: '智能体计划不存在。' });
        const cfg = schedule ? (parseJsonObject(schedule.run_config) || {}) : {};
        const isWorkflow = cfg.runMode === 'dag' || Boolean(cfg.workflowId);
        logAction(
            req,
            isWorkflow ? '手动运行工作流计划' : '手动运行智能体计划',
            `任务ID: ${run.id}，计划ID: ${req.params.id}${schedule?.name ? `，名称: ${schedule.name}` : ''}${cfg.workflowId ? `，工作流ID: ${cfg.workflowId}` : ''}`
        );
        res.status(202).json({ success: true, run });
    }));

    router.delete('/agents/schedules/:id', authMiddleware, asyncHandler(async (req, res) => {
        const schedule = await deleteAgentSchedule(req.params.id, req.user);
        if (!schedule) return res.status(404).json({ error: '智能体计划不存在或无权删除。' });
        const cfg = parseJsonObject(schedule.run_config) || {};
        const isWorkflow = cfg.runMode === 'dag' || Boolean(cfg.workflowId);
        logAction(req, isWorkflow ? '删除工作流计划' : '删除智能体计划', `计划ID: ${schedule.id}，名称: ${schedule.name}`);
        res.json({ success: true });
    }));

    router.get('/agents/notifications', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listAgentNotifications(req.user, normalizeLimit(req.query.limit, 20, 100)) });
    }));

    router.post('/agents/notifications/:id/read', authMiddleware, asyncHandler(async (req, res) => {
        const notification = await markAgentNotificationRead(req.params.id, req.user);
        if (!notification) return res.status(404).json({ error: '通知不存在。' });
        res.json({ success: true, notification });
    }));

    router.get('/agents/approval-requests', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listWorkflowApprovalRequests(req.user, { status: req.query.status }) });
    }));

    router.get('/agents/runs/:id/approval-requests', authMiddleware, asyncHandler(async (req, res) => {
        const requests = (await listWorkflowApprovalRequests(req.user, { status: req.query.status }))
            .filter(item => String(item.run_id || '') === String(req.params.id || ''));
        res.json({ data: requests });
    }));

    router.post('/agents/approval-requests/:id/decision', authMiddleware, asyncHandler(async (req, res) => {
        const request = await decideWorkflowApprovalRequest(req.params.id, req.user, req.body || {});
        if (!request) return res.status(404).json({ error: '审批请求不存在或已处理。' });
        logAction(
            req,
            req.body?.approve === false || String(req.body?.decision || '').toLowerCase() === 'reject'
                ? '拒绝工作流审批'
                : '批准工作流审批',
            `请求ID: ${request.id}，状态: ${request.status}`
        );
        res.json({ success: true, request });
    }));

    router.get('/agents/artifacts', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listAgentArtifacts(req.user, normalizeLimit(req.query.limit, 30, 100)) });
    }));

    router.get('/agents/artifacts/:id/versions', authMiddleware, asyncHandler(async (req, res) => {
        const result = await listAgentArtifactVersions(req.params.id, req.user);
        if (!result) return res.status(404).json({ error: '智能体结果不存在。' });
        res.json(result);
    }));

    router.post('/agents/artifacts/:id/versions', authMiddleware, asyncHandler(async (req, res) => {
        const artifact = await createAgentArtifactVersion(req.params.id, req.user, req.body || {});
        if (!artifact) return res.status(404).json({ error: '智能体结果不存在。' });
        logAction(req, '新增智能体结果版本', `结果ID: ${artifact.id}，版本: ${artifact.current_version || '-'}`);
        res.status(201).json({ success: true, artifact });
    }));

    router.get('/agents/artifacts/:id/diff', authMiddleware, asyncHandler(async (req, res) => {
        const result = await diffAgentArtifactVersions(req.params.id, req.user, req.query.from, req.query.to);
        if (!result) return res.status(404).json({ error: '智能体结果不存在。' });
        res.json(result);
    }));

    router.post('/agents/artifacts/:id/rollback', authMiddleware, asyncHandler(async (req, res) => {
        const artifact = await rollbackAgentArtifactVersion(req.params.id, req.user, req.body?.version, req.body?.note || '');
        if (!artifact) return res.status(404).json({ error: '智能体结果不存在。' });
        logAction(req, '回滚智能体结果版本', `结果ID: ${artifact.id}，目标版本: ${req.body?.version}`);
        res.json({ success: true, artifact });
    }));

    router.get('/agents/runs', authMiddleware, asyncHandler(async (req, res) => {
        const result = await listRuns(req.user, {
            page: req.query.page,
            limit: normalizeLimit(req.query.limit, 15, 100),
            status: req.query.status,
            query: req.query.query,
            runType: req.query.runType || req.query.run_type || req.query.type,
            scheduleId: req.query.scheduleId || req.query.schedule_id,
            includePreview: req.query.includePreview || req.query.include_preview
        });
        res.json(result);
    }));

    router.post('/agents/runs/:id/feedback', authMiddleware, asyncHandler(async (req, res) => {
        const feedback = await recordAgentFeedback(req.user, req.params.id, req.body || {});
        if (!feedback) return res.status(404).json({ error: '任务不存在或无权反馈。' });
        logAction(req, '提交 Agent 结果反馈', `任务ID: ${req.params.id}，结果: ${feedback.outcome}`);
        res.status(201).json({ success: true, feedback });
    }));

    // 普通聊天页面在刷新、切换设备或短暂断线后，用会话 ID 找回仍在执行的 Agent。
    // 该路由必须放在 /agents/runs/:id 之前，避免被当成运行 ID。
    router.get('/agents/runs/chat-active', authMiddleware, asyncHandler(async (req, res) => {
        const sessionId = String(req.query.sessionId || '').trim();
        if (!sessionId) return res.json({ runs: [] });
        const runs = await listChatAgentRunsForSession(sessionId, req.user.id, { limit: req.query.limit });
        res.json({ runs });
    }));

    router.get('/agents/runs/deleted/audit', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listDeletedRunsForAdmin(req.user, normalizeLimit(req.query.limit, 100, 200)) });
    }));

    router.post('/agents/runs', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const run = await createAgentRun({
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
            budgetConfig: req.body?.budgetConfig || req.body?.budget_config,
            networkPolicy: req.body?.networkPolicy || req.body?.network_policy,
            templateId: req.body?.templateId,
            scheduleId: null,
            dedupeKey: req.get('Idempotency-Key') ? `manual:${String(req.get('Idempotency-Key')).trim().slice(0, 180)}` : null,
            contextConfig: req.body?.contextConfig,
            metadata: req.body?.metadata,
            dagSpec: req.body?.dagSpec,
            dagInputs: req.body?.dagInputs || req.body?.dag_inputs,
            workflowId: req.body?.workflowId || req.body?.workflow_id,
            workflowVersion: req.body?.workflowVersion || req.body?.workflow_version,
            modelRouter: req.body?.modelRouter || req.body?.model_router
            ,forkHistory: req.body?.forkHistory || req.body?.fork_history || 'none'
            ,skillId: req.body?.skillId || req.body?.skill_id
            ,skillName: req.body?.skillName || req.body?.skill_name
        });
        logAction(req, '创建智能体任务', `任务ID: ${run.id}，目标: ${String(req.body?.goal || '').slice(0, 120)}`);
        res.status(202).json({ success: true, run });
    }));

    router.get('/agents/runs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        res.json(detail);
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

    router.get('/agents/runs/:id/collaborators', authMiddleware, asyncHandler(async (req, res) => {
        const collaborators = await listCollaboratorRuns(req.params.id, req.user);
        if (!collaborators) return res.status(404).json({ error: '父任务不存在或无权访问。' });
        res.json({ success: true, data: collaborators });
    }));

    router.post('/agents/runs/:id/delegate', authMiddleware, automationGuard, asyncHandler(async (req, res) => {
        const context = await buildDelegationContext(req.params.id, req.user);
        if (!context) return res.status(404).json({ error: '父任务不存在或无权委派。' });
        const delegation = normalizeDelegationInput(req.body || {});
        const child = await createAgentRun({
            user: req.user,
            parentRunId: context.parentRunId,
            goal: delegation.goal,
            title: delegation.title,
            maxSteps: delegation.maxSteps,
            maxTokenBudget: delegation.maxTokenBudget,
            approvalPolicy: delegation.approvalPolicy,
            toolPolicy: delegation.toolPolicy,
            forkHistory: delegation.forkHistory,
            dedupeKey: req.get('Idempotency-Key') ? `delegate:${context.parentRunId}:${String(req.get('Idempotency-Key')).slice(0, 180)}` : null,
            metadata: { source: 'delegation', parentRunId: context.parentRunId, collaboration: { parentTitle: context.parentTitle } }
        });
        logAction(req, '委派 Agent 协作子任务', `父任务ID: ${context.parentRunId}，子任务ID: ${child.id}`);
        res.status(202).json({ success: true, run: child, parent: context });
    }));

    router.get('/agents/runs/:id/events', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        const replay = String(req.query.replay || '').toLowerCase() === 'true' || String(req.query.replay || '') === '1';
        const events = await listAgentEventsForUser(req.params.id, req.user, {
            after: req.query.after || req.query.afterSeq || 0,
            limit: req.query.limit,
            types: req.query.type || req.query.types || []
        });
        const cursor = await getAgentEventCursorForUser(req.params.id, req.user);
        const nextAfter = events.length ? Number(events[events.length - 1].event_seq || 0) : Math.max(Number(req.query.after || req.query.afterSeq || 0) || 0, 0);
        res.json({ data: events, cursor, nextAfter, hasMore: nextAfter < cursor.eventSeq, replay });
    }));

    router.get('/agents/runs/:id/events/replay', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        const replay = await replayAgentEventsForUser(req.params.id, req.user, {
            after: req.query.after || req.query.afterSeq || 0,
            limit: req.query.limit,
            types: req.query.type || req.query.types || []
        });
        res.json({ data: replay.events, cursor: replay.cursor, nextAfter: replay.nextAfter, hasMore: replay.hasMore, replay: true });
    }));

    router.get('/agents/runs/:id/context-windows', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        const windows = await listAgentContextWindowsForUser(req.params.id, req.user, { limit: req.query.limit });
        res.json({ data: windows });
    }));

    router.get('/agents/runs/:id/world-states', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        const snapshots = await listAgentWorldStateSnapshotsForUser(req.params.id, req.user, {
            after: req.query.after || req.query.afterVersion || 0,
            limit: req.query.limit,
            windowId: req.query.windowId || req.query.window_id || ''
        });
        res.json({ data: snapshots });
    }));

    router.get('/agents/runs/:id/resources', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        res.json({ data: await getAgentRunResources(req.params.id, req.user.id) });
    }));

    router.get('/agents/runs/:id/control-messages', authMiddleware, asyncHandler(async (req, res) => {
        const messages = await listAgentControlMessages(req.params.id, req.user, {
            after: req.query.after || 0,
            limit: req.query.limit,
            status: req.query.status
        });
        if (!messages) return res.status(404).json({ error: '智能体任务不存在。' });
        res.json({ data: messages });
    }));

    router.post('/agents/runs/:id/control-messages', authMiddleware, asyncHandler(async (req, res) => {
        const message = await sendAgentControlMessage({
            user: req.user,
            fromRunId: req.body?.fromRunId || req.body?.from_run_id || '',
            toRunId: req.params.id,
            type: req.body?.type || req.body?.messageType || req.body?.message_type,
            payload: req.body?.payload ?? req.body?.message ?? {},
            expiresAt: req.body?.expiresAt || req.body?.expires_at || null
        });
        logAction(req, '发送 AgentControl 消息', `目标任务ID: ${req.params.id}，消息类型: ${message.message_type}`);
        res.status(202).json({ success: true, data: message });
    }));

    router.post('/agents/runs/:id/control-messages/:messageId/ack', authMiddleware, asyncHandler(async (req, res) => {
        const message = await acknowledgeAgentControlMessage(req.params.messageId, req.user, req.params.id);
        if (!message) return res.status(404).json({ error: '消息不存在、已确认或无权访问。' });
        res.json({ success: true, data: message });
    }));

    router.get('/agents/runs/:id/tool-calls', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        res.json({ data: await listAgentToolCalls(req.params.id, { limit: req.query.limit }) });
    }));

    router.post('/agents/runs/:id/trace/compile', authMiddleware, asyncHandler(async (req, res) => {
        const detail = await getRunDetailForUser(req.params.id, req.user);
        if (!detail) return res.status(404).json({ error: '智能体任务不存在。' });
        const calls = await listAgentToolCalls(req.params.id, { limit: req.body?.limit || 500 });
        const draft = compileTraceToWorkflow(calls, {
            title: req.body?.title,
            variables: req.body?.variables,
            filterExploration: req.body?.filterExploration !== false
        });
        logAction(req, '从智能体 Trace 编译工作流草稿', `任务ID: ${req.params.id}，节点数: ${draft.nodes.length}`);
        res.json({ success: true, draft });
    }));

    router.post('/agents/runs/:id/workflow-draft', authMiddleware, asyncHandler(async (req, res) => {
        const draft = await createWorkflowDraftFromRun(req.params.id, req.user);
        if (!draft) return res.status(404).json({ error: '自由任务不存在或无权访问。' });
        const traceCalls = await listAgentToolCalls(req.params.id, { limit: 500 });
        const traceDraft = compileTraceToWorkflow(traceCalls, {
            title: draft.name,
            filterExploration: true
        });
        draft.traceDraft = traceDraft;
        draft.dagSpec = draft.dagSpec?.nodes?.length ? draft.dagSpec : traceDraft.dagSpec;
        draft.traceYaml = traceDraft.yaml;
        draft.summary = { ...draft.summary, traceNodeCount: traceDraft.nodes.length, traceCompiled: true };
        logAction(req, '从自由任务生成工作流草稿', `任务ID: ${req.params.id}，节点数: ${draft.summary?.nodeCount || 0}`);
        res.json({ success: true, draft });
    }));

    router.post('/agents/runs/:id/cancel', authMiddleware, asyncHandler(async (req, res) => {
        const run = await cancelAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体任务不存在或不可取消。' });
        logAction(req, '取消智能体任务', `任务ID: ${run.id}`);
        res.json({ success: true, run });
    }));

    router.post('/agents/runs/:id/approval', authMiddleware, asyncHandler(async (req, res) => {
        const run = await approveAgentTool(req.params.id, req.user, req.body?.approve !== false);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, req.body?.approve === false ? '拒绝智能体工具审批' : '批准智能体工具审批', `任务ID: ${run.id}`);
        res.json({ success: true, run, steps: await listSteps(run.id) });
    }));

    router.get('/agents/runs/:id/export', authMiddleware, asyncHandler(async (req, res) => {
        const exported = await exportAgentRun(req.params.id, req.user, req.query.format === 'markdown' ? 'markdown' : 'json');
        if (!exported) return res.status(404).json({ error: '智能体任务不存在。' });
        res.setHeader('Content-Type', exported.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
        res.send(exported.body);
    }));

    router.post('/agents/runs/:id/rerun', authMiddleware, asyncHandler(async (req, res) => {
        const run = await rerunAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '重新运行智能体任务', `任务ID: ${run.id}，来源任务ID: ${req.params.id}`);
        res.status(202).json({ success: true, run });
    }));

    router.post('/agents/runs/:id/resume', authMiddleware, asyncHandler(async (req, res) => {
        const run = await resumeAgentRun(req.params.id, req.user);
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '断点续跑智能体任务', `任务ID: ${run.id}，来源任务ID: ${req.params.id}`);
        res.status(202).json({ success: true, run });
    }));

    router.post('/agents/runs/:id/dag/rerun', authMiddleware, asyncHandler(async (req, res) => {
        const run = await rerunAgentDagFromNode(req.params.id, req.user, req.body?.nodeId || req.body?.node_id || '');
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '重跑智能体工作流节点', `任务ID: ${run.id}，来源任务ID: ${req.params.id}，节点: ${req.body?.nodeId || req.body?.node_id || '-'}`);
        res.status(202).json({ success: true, run });
    }));

    router.post('/agents/runs/:id/artifacts', authMiddleware, asyncHandler(async (req, res) => {
        const artifact = await saveAgentRunArtifact(req.params.id, req.user, req.body || {});
        if (!artifact) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '沉淀智能体结果', `结果ID: ${artifact.id}，任务ID: ${req.params.id}`);
        res.status(201).json({ success: true, artifact });
    }));

    router.patch('/agents/runs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const run = await updateAgentRunTitleAndGoalForUser(req.params.id, req.user, {
            title: req.body?.title,
            goal: req.body?.goal
        });
        if (!run) return res.status(404).json({ error: '智能体任务不存在。' });
        logAction(req, '修改智能体任务目标与标题', `任务ID: ${run.id}，标题: ${String(run.title || '').slice(0, 60)}，目标: ${String(run.goal || '').slice(0, 100)}`);
        res.json({ success: true, run });
    }));

    router.delete('/agents/runs/:id', authMiddleware, asyncHandler(async (req, res) => {
        const run = await softDeleteAgentRun(req.params.id, req.user, req.body?.reason || '');
        if (!run) return res.status(404).json({ error: '智能体任务记录不存在。' });
        logAction(req, '移除智能体任务记录', `任务ID: ${run.id}，目标: ${String(run.goal || '').slice(0, 120)}`);
        res.json({ success: true, run });
    }));

    return router;
}

module.exports = { createAgentsRouter };
