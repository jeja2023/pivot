const { query, queryOne } = require('../db/client');
const { updateAgentRunMetadataWithRetry } = require('./agent-run-metadata-patch');
const { normalizeJsonSchema, schemaHasRules, validateJsonSchemaDefinition, validateValueAgainstSchema } = require('./agent-dag-contracts');
const { normalizeToolAllowlist } = require('./agent-validators');

const MAX_DELEGATION_BATCH = 10;
const MAX_DELEGATION_CONTEXT_CHARS = 24000;
const MAX_COMPLETION_CHARS = 12000;

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
    const row = await query(`SELECT id, title, goal, status, metadata, model_id, chosen_model_id, tool_policy, tool_allowlist, approval_policy FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [String(parentRunId || ''), user.id]);
    if (!row.length) return null;
    return {
        parentRunId: row[0].id,
        parentTitle: row[0].title,
        parentGoal: row[0].goal,
        parentStatus: row[0].status,
        parentMetadata: parseJson(row[0].metadata, {}),
        parentModelId: row[0].chosen_model_id || row[0].model_id || null,
        parentToolPolicy: row[0].tool_policy || 'builtin_only',
        parentToolAllowlist: normalizeToolAllowlist(row[0].tool_allowlist),
        parentApprovalPolicy: row[0].approval_policy || 'safe_mcp_auto'
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
            const repair = await options.createAgentRun({
                user,
                parentRunId: run.id,
                goal: repairGoal,
                title: `修正结构化结果：${String(run.title || '').slice(0, 110)}`,
                maxSteps: Math.min(Math.max(Number(run.max_steps || 2), 1), 3),
                maxTokenBudget: Math.min(Math.max(Number(run.max_token_budget || 0), 0), 20000),
                runMode: 'standard',
                toolPolicy: 'builtin_only',
                toolAllowlist: [],
                approvalPolicy: 'safe_mcp_auto',
                modelId: run.chosen_model_id || run.model_id || null,
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
        expiresAt: null
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
    validateDelegationOutput
};
