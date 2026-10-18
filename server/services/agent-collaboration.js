const { query, queryOne } = require('../db/client');
const { updateAgentRunMetadataWithRetry } = require('./agent-run-metadata-patch');
const { normalizeJsonSchema, schemaHasRules, validateJsonSchemaDefinition, validateValueAgainstSchema } = require('./agent-dag-contracts');
const { normalizeMaxSteps, normalizeRunMode, normalizeToolAllowlist } = require('./agent-validators');
const { DEFAULT_ROLE_POLICIES, getDelegationRolePolicySnapshot, normalizeRolePolicies } = require('./agent-delegation-role-policies');

const MAX_DELEGATION_BATCH = 10;
const MAX_DELEGATION_CONTEXT_CHARS = 24000;
const MAX_COMPLETION_CHARS = 12000;
// 预置协作角色不是 Prompt 中的装饰标签：它们只能收紧父任务能力。
// custom 保留给已获授权的显式任务契约，绝不借“自定义角色”扩大父级边界。
const DELEGATION_ROLE_POLICIES = DEFAULT_ROLE_POLICIES;

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

async function listCollaboratorRuns(parentRunId, user) {
    const parent = await query(`SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [String(parentRunId || ''), user.id]);
    if (!parent.length) return null;
    const rows = await query(`SELECT id, parent_run_id, title, goal, status, metadata, created_at, updated_at, completed_at, error_message FROM agent_runs WHERE parent_run_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`, [String(parentRunId), user.id]);
    return rows.map(row => ({ ...row, metadata: parseJson(row.metadata, {}) }));
}

function normalizeDelegationInput(input = {}) {
    const goal = String(input.goal || '').trim().slice(0, 12000);
    if (goal.length < 4) throw Object.assign(new Error('协作委派目标不能为空。'), { status: 400, code: 'AGENT_DELEGATION_INVALID' });
    const outputSchema = normalizeJsonSchema(input.outputSchema || input.output_schema || {});
    const schemaIssues = schemaHasRules(outputSchema)
        ? validateJsonSchemaDefinition(outputSchema, '委派输出契约', [])
        : [];
    if (schemaIssues.length) throw Object.assign(new Error(`委派输出契约无效：${schemaIssues[0]}`), { status: 400, code: 'AGENT_DELEGATION_OUTPUT_SCHEMA_INVALID' });
    const responseFormat = schemaHasRules(outputSchema) ? 'json' : (['markdown', 'text', 'json'].includes(String(input.responseFormat || input.response_format || 'markdown')) ? String(input.responseFormat || input.response_format || 'markdown') : 'markdown');
    return {
        goal,
        title: String(input.title || '协作子任务').trim().slice(0, 160),
        context: String(input.context || '').trim().slice(0, MAX_DELEGATION_CONTEXT_CHARS),
        agentName: String(input.agentName || input.agent_name || '').trim().slice(0, 80),
        role: ['researcher', 'analyst', 'reviewer', 'writer', 'custom'].includes(String(input.role || '')) ? String(input.role) : 'custom',
        instructions: String(input.instructions || '').trim().slice(0, 6000),
        modelId: input.modelId ?? input.model_id ?? input.model ?? null,
        outputSchema,
        responseFormat,
        maxSteps: Math.max(1, Math.min(Number.parseInt(input.maxSteps || input.max_steps, 10) || 6, 60)),
        maxTokenBudget: Math.max(0, Math.min(Number.parseInt(input.maxTokenBudget || input.max_token_budget, 10) || 0, 10000000)),
        approvalPolicy: String(input.approvalPolicy || input.approval_policy || 'safe_mcp_auto').slice(0, 40),
        toolPolicy: String(input.toolPolicy || input.tool_policy || 'builtin_only').slice(0, 40),
        toolAllowlist: normalizeToolAllowlist(input.toolAllowlist || input.tool_allowlist),
        forkHistory: String(input.forkHistory || input.fork_history || 'none').slice(0, 20)
    };
}

function normalizeDelegationBatchInput(input = {}) {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    if (!tasks.length) throw Object.assign(new Error('批量协作至少需要一个子任务。'), { status: 400, code: 'AGENT_DELEGATION_BATCH_EMPTY' });
    if (tasks.length > MAX_DELEGATION_BATCH) throw Object.assign(new Error(`一次最多委派 ${MAX_DELEGATION_BATCH} 个子任务。`), { status: 400, code: 'AGENT_DELEGATION_BATCH_LIMIT' });
    const batchTitle = String(input.title || input.batchTitle || input.batch_title || '并行协作任务组').trim().slice(0, 160) || '并行协作任务组';
    return { batchTitle, tasks: tasks.map(normalizeDelegationInput) };
}

async function buildDelegationContext(parentRunId, user) {
    const row = await query(`SELECT id, title, goal, status, metadata, tenant_id, model_id, chosen_model_id, run_mode, max_steps, max_token_budget, timeout_ms, tool_timeout_ms, network_policy, tool_policy, tool_allowlist, approval_policy FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [String(parentRunId || ''), user.id]);
    if (!row.length) return null;
    const rolePolicySnapshot = await getDelegationRolePolicySnapshot(row[0].tenant_id || user.tenant_id || user.tenantId || 1);
    return {
        parentRunId: row[0].id,
        parentTitle: row[0].title,
        parentGoal: row[0].goal,
        parentStatus: row[0].status,
        rolePolicies: rolePolicySnapshot.policies,
        rolePolicyRevision: rolePolicySnapshot.revision,
        parentMetadata: parseJson(row[0].metadata, {}),
        parentModelId: row[0].chosen_model_id || row[0].model_id || null,
        parentRunMode: row[0].run_mode || 'standard',
        parentMaxSteps: Number(row[0].max_steps || 0),
        parentMaxTokenBudget: Number(row[0].max_token_budget || 0),
        parentTimeoutMs: Number(row[0].timeout_ms || 0),
        parentToolTimeoutMs: Number(row[0].tool_timeout_ms || 0),
        parentNetworkPolicy: parseJson(row[0].network_policy, {}),
        parentToolPolicy: row[0].tool_policy || 'builtin_only',
        parentToolAllowlist: normalizeToolAllowlist(row[0].tool_allowlist),
        parentApprovalPolicy: row[0].approval_policy || 'safe_mcp_auto'
    };
}

function delegationConstraintError(message, code = 'AGENT_DELEGATION_CONSTRAINT_ESCALATION') {
    const error = new Error(message);
    error.code = code;
    error.status = 409;
    error.category = 'policy';
    return error;
}

function resolveChildDelegationConstraints(parent = {}, task = {}) {
    const parentModelId = Number(parent.parentModelId ?? parent.chosen_model_id ?? parent.model_id ?? 0) || null;
    const requestedModelId = Number(task.modelId ?? task.model_id ?? 0) || null;
    if (parentModelId && requestedModelId && requestedModelId !== parentModelId) {
        throw delegationConstraintError('子任务不能切换到与父任务不同的模型；如需升级模型，请先由父任务重新路由并记录原因。', 'AGENT_DELEGATION_MODEL_ESCALATION');
    }
    const parentMode = normalizeRunMode(parent.parentRunMode ?? parent.run_mode ?? 'standard');
    const requestedMode = task.runMode || task.run_mode;
    if (requestedMode && normalizeRunMode(requestedMode) !== parentMode) {
        throw delegationConstraintError('子任务不能改变父任务的运行模式。', 'AGENT_DELEGATION_RUN_MODE_ESCALATION');
    }
    const parentLimit = Number(parent.parentMaxSteps ?? parent.max_steps ?? 0);
    const requestedSteps = Number(task.maxSteps ?? task.max_steps ?? 0);
    const defaultSteps = parentLimit > 0 ? parentLimit : 6;
    let maxSteps = parentLimit > 0
        ? Math.min(Math.max(requestedSteps || defaultSteps, 1), normalizeMaxSteps(parentLimit, parentMode))
        : Math.max(Math.min(requestedSteps || defaultSteps, 60), 1);
    const rolePolicies = parent.rolePolicies && typeof parent.rolePolicies === 'object'
        ? normalizeRolePolicies(parent.rolePolicies)
        : DELEGATION_ROLE_POLICIES;
    const rolePolicy = rolePolicies[String(task.role || 'custom').trim().toLowerCase()] || null;
    if (rolePolicy) maxSteps = Math.min(maxSteps, rolePolicy.maxSteps);
    const parentAllowlist = normalizeToolAllowlist(parent.parentToolAllowlist ?? parent.tool_allowlist ?? []);
    const requestedAllowlist = normalizeToolAllowlist(task.toolAllowlist || task.tool_allowlist || []);
    const toolAllowlist = parentAllowlist.length
        ? (requestedAllowlist.length ? parentAllowlist.filter(name => requestedAllowlist.includes(name)) : parentAllowlist)
        : requestedAllowlist;
    // 任务策略把空白名单解释为“不额外限制”，因此交集为空绝不能传给子任务，
    // 否则反而由最小权限扩大为无限制。明确拒绝，要求调用方重新选择工具。
    if (parentAllowlist.length && requestedAllowlist.length && !toolAllowlist.length) {
        throw delegationConstraintError('子任务请求的工具与父任务允许列表没有交集，不能创建委派。', 'AGENT_DELEGATION_TOOL_ALLOWLIST_DISJOINT');
    }
    const parentToolPolicy = String(parent.parentToolPolicy ?? parent.tool_policy ?? 'builtin_only');
    const requestedToolPolicy = String(task.toolPolicy ?? task.tool_policy ?? parentToolPolicy);
    let toolPolicy = parentToolPolicy === 'builtin_only' || requestedToolPolicy === 'builtin_only' ? 'builtin_only' : 'all';
    const parentApprovalPolicy = String(parent.parentApprovalPolicy ?? parent.approval_policy ?? 'safe_mcp_auto');
    const requestedApprovalPolicy = String(task.approvalPolicy ?? task.approval_policy ?? parentApprovalPolicy);
    let approvalPolicy = parentApprovalPolicy === 'approve_all_mcp' || requestedApprovalPolicy === 'approve_all_mcp'
        ? 'approve_all_mcp' : 'safe_mcp_auto';
    if (rolePolicy) {
        toolPolicy = 'builtin_only';
        approvalPolicy = rolePolicy.approvalPolicy;
    }
    const parentTokenBudget = Number(parent.parentMaxTokenBudget ?? parent.max_token_budget ?? 0) || 0;
    const requestedTokenBudget = Math.max(0, Number(task.maxTokenBudget ?? task.max_token_budget ?? 0) || 0);
    let maxTokenBudget = parentTokenBudget > 0
        ? Math.min(requestedTokenBudget || parentTokenBudget, parentTokenBudget)
        : requestedTokenBudget;
    if (rolePolicy) maxTokenBudget = Math.min(maxTokenBudget || rolePolicy.maxTokenBudget, rolePolicy.maxTokenBudget);
    return {
        modelId: parentModelId || requestedModelId || null,
        runMode: parentMode,
        maxSteps,
        maxTokenBudget,
        timeoutMs: Number(parent.parentTimeoutMs ?? parent.timeout_ms ?? 0) || 0,
        toolTimeoutMs: Number(parent.parentToolTimeoutMs ?? parent.tool_timeout_ms ?? 0) || 0,
        approvalPolicy,
        toolPolicy,
        toolAllowlist,
        networkPolicy: parseJson(parent.parentNetworkPolicy ?? parent.network_policy, {}),
        rolePolicy: rolePolicy ? { ...rolePolicy } : null
    };
}

function parseJsonOutput(value) {
    const source = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!source) return null;
    try { return JSON.parse(source); } catch (_) {}
    const objectStart = source.indexOf('{');
    const objectEnd = source.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
        try { return JSON.parse(source.slice(objectStart, objectEnd + 1)); } catch (_) {}
    }
    const arrayStart = source.indexOf('[');
    const arrayEnd = source.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
        try { return JSON.parse(source.slice(arrayStart, arrayEnd + 1)); } catch (_) {}
    }
    return null;
}

function validateDelegationOutput(content, outputSchema = {}) {
    const schema = normalizeJsonSchema(outputSchema);
    if (!schemaHasRules(schema)) return { schemaValid: true, value: null, issues: [] };
    const value = parseJsonOutput(content);
    if (value === null) return { schemaValid: false, value: null, issues: ['结果不是合法 JSON。'] };
    const issues = validateValueAgainstSchema(value, schema, { allowTemplates: false }, '委派结果', []);
    return { schemaValid: issues.length === 0, value, issues };
}

function completionPayload(run, status, metadata, validation, extra = {}) {
    const collaboration = metadata.collaboration || {};
    return {
        kind: 'delegation_completion',
        batchId: collaboration.batchId || '',
        taskIndex: Number(collaboration.taskIndex || 0),
        taskCount: Number(collaboration.taskCount || 1),
        childRunId: run.id,
        title: run.title || '',
        status,
        schemaValid: validation.schemaValid,
        schemaIssues: validation.issues.slice(0, 5),
        output: validation.schemaValid && validation.value !== null ? validation.value : undefined,
        summary: String(run.final_answer || run.error_message || '').slice(0, MAX_COMPLETION_CHARS),
        completedAt: run.completed_at || run.updated_at || null,
        ...extra
    };
}

async function recordCollaboratorCompletion(runId, status, options = {}) {
    const run = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [String(runId || '')]);
    if (!run) return null;
    const metadata = parseJson(run.metadata, {});
    const collaboration = metadata.collaboration && typeof metadata.collaboration === 'object' ? metadata.collaboration : {};
    if (metadata.source !== 'delegation' || !collaboration.supervisorRunId) return null;
    if (collaboration.completionNotified === true) return { skipped: true, reason: 'already_notified' };
    const validation = validateDelegationOutput(run.final_answer || '', collaboration.outputSchema || {});
    const user = { id: run.user_id };

    if (!validation.schemaValid && schemaHasRules(normalizeJsonSchema(collaboration.outputSchema || {})) && Number(collaboration.repairAttempt || 0) < 1 && typeof options.createAgentRun === 'function') {
        const repairGoal = [
            '请修复以下协作子任务的最终结果，只输出合法 JSON，不要添加解释或 Markdown 代码块。',
            `原任务：${run.goal}`,
            `输出 JSON Schema：${JSON.stringify(collaboration.outputSchema)}`,
            `原始结果：${String(run.final_answer || run.error_message || '').slice(0, MAX_COMPLETION_CHARS)}`,
            `校验问题：${validation.issues.join('；')}`
        ].join('\n\n');
        try {
            const repairConstraints = resolveChildDelegationConstraints(run, {
                maxSteps: 3,
                maxTokenBudget: 20000,
                toolPolicy: 'builtin_only',
                approvalPolicy: 'approve_all_mcp'
            });
            const repair = await options.createAgentRun({
                user,
                parentRunId: run.id,
                goal: repairGoal,
                title: `修正结构化结果：${String(run.title || '').slice(0, 110)}`,
                maxSteps: repairConstraints.maxSteps,
                maxTokenBudget: repairConstraints.maxTokenBudget,
                runMode: repairConstraints.runMode,
                toolPolicy: repairConstraints.toolPolicy,
                toolAllowlist: repairConstraints.toolAllowlist,
                approvalPolicy: repairConstraints.approvalPolicy,
                networkPolicy: repairConstraints.networkPolicy,
                timeoutMs: repairConstraints.timeoutMs,
                toolTimeoutMs: repairConstraints.toolTimeoutMs,
                modelId: repairConstraints.modelId,
                dedupeKey: `delegation-repair:${run.id}`,
                metadata: {
                    source: 'delegation',
                    collaboration: {
                        ...collaboration,
                        repairAttempt: 1,
                        repairedFromRunId: run.id,
                        outputSchema: collaboration.outputSchema || {},
                        supervisorRunId: collaboration.supervisorRunId
                    }
                }
            });
            await updateAgentRunMetadataWithRetry(run.id, current => ({
                ...current,
                collaboration: { ...(current.collaboration || {}), completionNotified: true, repairRunId: repair.id, schemaIssues: validation.issues.slice(0, 5) }
            }), { userId: run.user_id });
            return { repairRunId: repair.id, schemaValid: false, issues: validation.issues };
        } catch (error) {
            // 修正任务不能创建时仍要把不合格结果显式上报给主管，而不是静默丢失。
        }
    }

    const { sendAgentControlMessage } = require('./agent-control');
    const payload = completionPayload(run, status, metadata, validation);
    await sendAgentControlMessage({
        user,
        fromRunId: run.id,
        toRunId: collaboration.supervisorRunId,
        type: 'reply',
        payload,
        expiresAt: null,
        idempotencyKey: `delegation-completion:${run.id}`
    });
    await updateAgentRunMetadataWithRetry(run.id, current => ({
        ...current,
        collaboration: { ...(current.collaboration || {}), completionNotified: true, schemaValid: validation.schemaValid, schemaIssues: validation.issues.slice(0, 5) }
    }), { userId: run.user_id });
    return payload;
}

module.exports = {

    MAX_DELEGATION_BATCH,
    buildDelegationContext,
    listCollaboratorRuns,
    normalizeDelegationBatchInput,
    normalizeDelegationInput,
    recordCollaboratorCompletion,

    resolveChildDelegationConstraints,
    validateDelegationOutput
};
