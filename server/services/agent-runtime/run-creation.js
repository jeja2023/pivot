// 拆自 agent-runtime/index.js：智能体任务创建与参数校验工厂
const { queryOne, execute } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { getRunnableModelForUserAsync } = require('../models');
const { normalizeStrategy: normalizeRouterStrategy } = require('../model-router');
const { assertTemplateAccess } = require('../agent-templates');
const {
    assertWorkflowLlmNodesConfigured,
    normalizeDagInputsPayload,
    resolveAgentWorkflowVersion
} = require('../agent-workflows');
const { getRunForUser } = require('../agent-runs');
const {
    assertAgentWorkflowDependencies,
    resolveAgentWorkflowDependencyBindings
} = require('../agent-workflow-dependencies');
const {
    MAX_CHAT_AGENT_GOAL_LENGTH,
    normalizeMaxSteps,
    resolveMaxSteps,
    normalizePriority,
    normalizeRunMode,
    normalizeToolPolicy,
    normalizeApprovalPolicy,
    normalizePositiveInt,
    serializeContextConfig,
    normalizeDagSpec,
    serializeToolAllowlist,
    normalizeAgentGoal,
    normalizeAgentTitle
} = require('../agent-validators');
const {
    AGENT_DEFAULT_TIMEOUT_MS,
    AGENT_TOOL_TIMEOUT_MS,
    createRunId
} = require('./runtime-env');
const { getAgentSkillExecutionContext, findBestPersonalSkill } = require('../agent-skills');
const { getAgentLearningSettings } = require('../agent-learning');

/**
 * 调用方不得自报的 Skill 约束键。
 * 落地方案 v1.2 §6.4 第 2 条：Skill 约束必须由服务端解析后写入，
 * 其中 skillConstraints、skillLegacyUnrestricted 与 skillContextPresent 属于会放宽判定的信号，
 * 若允许请求体携带，等于把 PEP 的默认拒绝语义关掉。
 */
const SKILL_METADATA_KEYS = Object.freeze([
    'skillConstraints', 'skillPermissions', 'skillCapabilities', 'skillTools',
    'skillContextPresent', 'skillLegacyUnrestricted', 'skillLegacyUnrestrictedUntil',
    'skillReleaseId', 'skillVersionId', 'skillVersion', 'skillInstructions', 'skillTitle', 'learnedSkillAuto'
]);
const { normalizeTaskBudget } = require('../agent-budget');
const {
    buildForkHistory,
    cancelChildRunReservation,
    initializeAgentRunResources,
    normalizeForkHistory,
    reserveChildRunResources
} = require('../agent-run-resources');
const { inferDagRunGoal } = require('./dag-run-config');
const { buildAgentProfileContext, getAgentProfile } = require('../agent-profile');
const { getAgentFeedbackSignals } = require('../agent-feedback');

function createAgentRunFactory(deps = {}) {
    const {
        assertRunUserActive,
        enqueueAgentRun,
        publishAgentRunEvent
    } = deps;

    return async function createAgentRun({
        user,
        goal,
        modelId,
        sessionId = null,
        title = '',
        maxSteps = 0,
        parentRunId = null,
        priority = 0,
        runMode = 'standard',
        toolPolicy = 'all',
        toolAllowlist = [],
        approvalPolicy = 'safe_mcp_auto',
        timeoutMs = AGENT_DEFAULT_TIMEOUT_MS,
        toolTimeoutMs = AGENT_TOOL_TIMEOUT_MS,
        retryLimit = 1,
        maxTokenBudget = 0,
        budgetConfig = {},
        networkPolicy = {},
        templateId = null,
        scheduleId = null,
        contextConfig = {},
        resumeFromStep = 0,
        metadata = {},
        dagSpec = null,
        dagInputs = null,
        workflowId = null,
        workflowVersion = null,
        modelRouter = 'fixed',
        dedupeKey = null,
        skillId = null,
        skillName = null,
        forkHistory = 'none',
        chatAgent = false
    }) {
        if (typeof assertRunUserActive === 'function') {
            await assertRunUserActive(user);
        }
        const normalizedScheduleId = scheduleId === null || scheduleId === '' ? null : Number(scheduleId);
        if (normalizedScheduleId !== null && (!Number.isInteger(normalizedScheduleId) || normalizedScheduleId <= 0)) {
            const err = new Error('计划标识无效。');
            err.status = 400;
            throw err;
        }
        if (normalizedScheduleId !== null && !(await queryOne('SELECT id FROM agent_schedules WHERE id = ? AND user_id = ?', [normalizedScheduleId, user.id]))) {
            const err = new Error('计划不存在或无权使用。');
            err.status = 403;
            throw err;
        }
        const normalizedTemplateId = templateId === null || templateId === '' ? null : Number(templateId);
        if (normalizedTemplateId !== null && (!Number.isInteger(normalizedTemplateId) || normalizedTemplateId <= 0)) {
            const err = new Error('任务模板标识无效。');
            err.status = 400;
            throw err;
        }
        if (normalizedTemplateId !== null) {
            const template = await queryOne('SELECT * FROM agent_templates WHERE id = ?', [normalizedTemplateId]);
            if (!assertTemplateAccess(template, user, false)) {
                const err = new Error('任务模板不存在或无权使用。');
                err.status = 403;
                throw err;
            }
        }
        const normalizedDedupeKey = dedupeKey ? String(dedupeKey).trim().slice(0, 240) : null;
        if (normalizedDedupeKey) {
            const existing = await queryOne('SELECT * FROM agent_runs WHERE user_id = ? AND dedupe_key = ? AND deleted_at IS NULL', [user.id, normalizedDedupeKey]);
            if (existing) return existing;
        }
        const normalizedToolPolicy = normalizeToolPolicy(toolPolicy);
        const normalizedRunMode = normalizeRunMode(runMode);
        const normalizedRouter = normalizeRouterStrategy(modelRouter);
        const runMetadata = metadata && typeof metadata === 'object' ? { ...metadata } : {};
        // 档案与反馈只作为可审计的运行上下文快照保存；它们不会修改工具权限或审批策略。
        try {
            const profile = await getAgentProfile(user.id);
            runMetadata.agentProfileContext = buildAgentProfileContext(profile);
            runMetadata.agentProfileVersion = profile.version;
            runMetadata.feedbackSignals = await getAgentFeedbackSignals(user.id, { days: 30 });
        } catch (_) {
            // 新库迁移尚未完成时仍允许创建任务，运行时按旧上下文继续。
        }
        const normalizedForkHistory = normalizeForkHistory(forkHistory || runMetadata.forkHistory || runMetadata.fork_history || 'none');
        let resourceReservation = null;
        let effectiveChildTokenBudget = normalizePositiveInt(maxTokenBudget, 0, 0, 10000000);
        let skillReference = skillId || skillName || runMetadata.skillId || runMetadata.skillName || '';
        // Skill 约束是 PEP 的判定输入，而 metadata 是调用方可写字段。
        // 因此先剥离调用方自报的全部 skill 相关键（尤其是 skillConstraints 与 legacy 兜底标记），
        // 再只由服务端解析结果写回，避免通过请求体关掉默认拒绝语义。
        SKILL_METADATA_KEYS.forEach(key => { delete runMetadata[key]; });
        const learningSettings = await getAgentLearningSettings(user.id).catch(() => ({ autoLearning: true }));
        if (!skillReference && learningSettings.autoLearning !== false && runMetadata.autoPersonalSkill !== false && runMode !== 'dag') {
            const learned = await findBestPersonalSkill(user, goal, { minScore: 2 });
            if (learned?.name) {
                skillReference = learned.name;
                runMetadata.learnedSkillAuto = true;
            }
        }
        if (skillReference) {
            const skillContext = await getAgentSkillExecutionContext(user, skillReference);
            runMetadata.skillId = skillContext.skillId;
            runMetadata.skillName = skillContext.skillName;
            runMetadata.skillVersion = skillContext.skillVersion;
            runMetadata.skillPermissions = skillContext.skillPermissions;
            runMetadata.skillCapabilities = skillContext.skillCapabilities;
            runMetadata.skillTools = skillContext.skillTools;
            runMetadata.skillReleaseId = skillContext.releaseId || null;
            runMetadata.skillVersionId = skillContext.skillVersionId || null;
            runMetadata.skillConstraints = skillContext.skillConstraints;
            runMetadata.skillTitle = skillContext.skillTitle || skillContext.skillName;
            runMetadata.skillInstructions = skillContext.skillInstructions || '';
        }
        const goalMaxLength = chatAgent === true ? MAX_CHAT_AGENT_GOAL_LENGTH : undefined;
        const cleanGoal = normalizeAgentGoal(normalizedRunMode === 'dag'
            ? await inferDagRunGoal({ goal, title, workflowId, runMetadata, dagSpec, user })
            : goal, goalMaxLength ? { maxLength: goalMaxLength } : undefined);
        const runId = createRunId();
        const now = getBeijingTimestamp();
        const normalizedDagInputs = normalizeDagInputsPayload(dagInputs || runMetadata.dagInputs || runMetadata.inputs || {});
        if (Object.keys(normalizedDagInputs).length) {
            runMetadata.dagInputs = normalizedDagInputs;
        }
        let effectiveModelId = modelId;
        const effectiveMaxSteps = resolveMaxSteps(maxSteps, normalizedRunMode);
        if (normalizedRunMode === 'dag') {
            const requestedWorkflowId = workflowId || runMetadata.workflowId || runMetadata.workflow_id || null;
            const requestedWorkflowVersion = workflowVersion || runMetadata.workflowVersion || runMetadata.workflow_version || null;
            if (requestedWorkflowId && requestedWorkflowVersion) {
                const sourceWorkflow = await resolveAgentWorkflowVersion(requestedWorkflowId, user, requestedWorkflowVersion || 'current');
                if (!sourceWorkflow) {
                    const err = new Error('工作流版本不可用。');
                    err.status = 404;
                    throw err;
                }
                const resolvedWorkflow = await resolveAgentWorkflowDependencyBindings(sourceWorkflow, user);
                runMetadata.dagSpec = resolvedWorkflow.dagSpec;
                runMetadata.workflowId = resolvedWorkflow.workflow.id;
                runMetadata.workflowName = resolvedWorkflow.workflow.name;
                runMetadata.workflowVersion = resolvedWorkflow.version;
                runMetadata.workflowVersionMode = resolvedWorkflow.mode;
                runMetadata.workflowVersionId = resolvedWorkflow.version_id;
                runMetadata.workflowDependencyBinding = {
                    required: Boolean(resolvedWorkflow.dependency_binding?.required),
                    versionId: resolvedWorkflow.dependency_binding?.bound_version_id || null,
                    updatedAt: resolvedWorkflow.dependency_binding?.updated_at || ''
                };
            } else {
                runMetadata.dagSpec = normalizeDagSpec(dagSpec || runMetadata.dagSpec || {});
            }
            assertWorkflowLlmNodesConfigured(runMetadata.dagSpec);
            await assertAgentWorkflowDependencies(runMetadata.dagSpec, user);
        }
        const modelCfg = await getRunnableModelForUserAsync(effectiveModelId, user);
        if (!modelCfg && normalizedRunMode !== 'dag') throw new Error('请选择当前账号可用的模型。');
        if (parentRunId) {
            const inherited = await reserveChildRunResources({
                parentRunId,
                userId: user.id,
                requestedTokenBudget: effectiveChildTokenBudget,
                forkHistory: normalizedForkHistory
            });
            effectiveChildTokenBudget = inherited.tokenBudget;
            resourceReservation = inherited.reservation;
            runMetadata.resourceInheritance = {
                parentRunId: String(parentRunId),
                tokenBudget: effectiveChildTokenBudget,
                forkHistory: inherited.forkHistory
            };
            if (inherited.forkHistory.mode !== 'none') {
                try {
                    runMetadata.parentHistory = await buildForkHistory(parentRunId, user.id, inherited.forkHistory);
                } catch (error) {
                    try { await cancelChildRunReservation({ parentRunId, userId: user.id, tokenBudget: effectiveChildTokenBudget }); } catch (_) {}
                    throw error;
                }
            }
        }
        try {
            await execute(`
                INSERT INTO agent_runs (
                    id, user_id, session_id, model_id, title, goal, status, max_steps, parent_run_id,
                    priority, run_mode, tool_policy, tool_allowlist, approval_policy, timeout_ms, tool_timeout_ms,
                    retry_limit, max_token_budget, template_id, schedule_id, dedupe_key, context_config, resume_from_step,
                    metadata, model_router, budget_config, usage_stats, network_policy, tenant_id, created_at, updated_at
                )
                VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
            `, [
                runId,
                user.id,
                sessionId || null,
                modelCfg?.id || null,
                normalizeAgentTitle(title, cleanGoal),
                cleanGoal,
                'queued',
                normalizeMaxSteps(effectiveMaxSteps, normalizedRunMode),
                parentRunId || null,
                normalizePriority(priority),
                normalizedRunMode,
                normalizedToolPolicy,
                serializeToolAllowlist(toolAllowlist),
                normalizeApprovalPolicy(approvalPolicy),
                normalizePositiveInt(timeoutMs, AGENT_DEFAULT_TIMEOUT_MS, 60000, 24 * 60 * 60 * 1000),
                normalizePositiveInt(toolTimeoutMs, AGENT_TOOL_TIMEOUT_MS, 30000, 10 * 60 * 1000),
                normalizePositiveInt(retryLimit, 1, 0, 5),
                effectiveChildTokenBudget,
                normalizedTemplateId,
                normalizedScheduleId,
                normalizedDedupeKey,
                serializeContextConfig(contextConfig),
                normalizePositiveInt(resumeFromStep, 0, 0, 999),
                JSON.stringify(runMetadata),
                normalizedRouter,
                JSON.stringify(normalizeTaskBudget(budgetConfig)),
                JSON.stringify({}),
                JSON.stringify(networkPolicy || {}),
                user.tenant_id || user.tenantId || null,
                now,
                now
            ]);
        } catch (err) {
            if (resourceReservation) {
                try { await cancelChildRunReservation({ parentRunId, userId: user.id, tokenBudget: effectiveChildTokenBudget }); } catch (_) {}
            }
            if (normalizedDedupeKey && (String(err.code || '').includes('CONSTRAINT') || String(err.code || '').includes('23505'))) {
                const existing = await queryOne('SELECT * FROM agent_runs WHERE user_id = ? AND dedupe_key = ? AND deleted_at IS NULL', [user.id, normalizedDedupeKey]);
                if (existing) return existing;
            }
            throw err;
        }
        await initializeAgentRunResources({
            runId,
            userId: user.id,
            parentRunId,
            tokenBudget: effectiveChildTokenBudget,
            forkHistory: normalizedForkHistory
        });
        if (normalizedRunMode === 'dag' && Array.isArray(runMetadata.dagSpec?.nodes) && runMetadata.dagSpec.nodes.length > 0) {
            const { upsertDagNode } = require('../agent-dag-runtime');
            for (const node of runMetadata.dagSpec.nodes) {
                await upsertDagNode(runId, node, { status: 'pending' });
            }
        }
        if (typeof enqueueAgentRun === 'function') {
            enqueueAgentRun(runId, user);
        }
        const run = await getRunForUser(runId, user);
        if (typeof publishAgentRunEvent === 'function') {
            await publishAgentRunEvent(runId, 'created');
        }
        return run;
    };
}

module.exports = {
    createAgentRunFactory
};
