const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { normalizeStrategy: normalizeRouterStrategy } = require('./model-router');
const { normalizeDagInputsPayload } = require('./agent-workflows');
const {
    MAX_GOAL_LENGTH,
    normalizeMaxSteps,
    normalizeRunMode,
    normalizeToolPolicy,
    normalizeApprovalPolicy,
    normalizePositiveInt,
    serializeContextConfig,
    normalizeDagSpec,
    serializeToolAllowlist
} = require('./agent-validators');
const { isSuperAdmin } = require('../permissions');

function assertTemplateAccess(template, user, write = false) {
    if (!template || template.deleted_at) return false;
    if (template.user_id === user.id) return true;
    if (write) return false;
    if (template.scope !== 'shared') return false;
    const allowedUnits = String(template.allowed_units || '').split(',').map(item => item.trim()).filter(Boolean);
    return allowedUnits.length === 0 || allowedUnits.includes(user.unit || '');
}

function normalizeTemplatePayload(body = {}, user = {}) {
    const name = String(body.name || '').trim().slice(0, 80);
    const goalTemplate = String(body.goalTemplate || body.goal_template || body.goal || '').trim();
    if (!name || goalTemplate.length < 4) {
        const err = new Error('请填写模板名称和明确的任务目标。');
        err.status = 400;
        throw err;
    }
    const shared = body.scope === 'shared' && isSuperAdmin(user);
    const runMode = normalizeRunMode(body.runMode || body.run_mode);
    const dagSpec = runMode === 'dag' ? normalizeDagSpec(body.dagSpec || body.dag_spec || {}) : { nodes: [] };
    const workflowId = body.workflowId || body.workflow_id || null;
    return {
        name,
        scope: shared ? 'shared' : 'personal',
        description: String(body.description || '').trim().slice(0, 300),
        goalTemplate: goalTemplate.slice(0, MAX_GOAL_LENGTH),
        runMode,
        toolPolicy: normalizeToolPolicy(body.toolPolicy || body.tool_policy),
        toolAllowlist: serializeToolAllowlist(body.toolAllowlist || body.tool_allowlist),
        approvalPolicy: normalizeApprovalPolicy(body.approvalPolicy || body.approval_policy),
        maxSteps: normalizeMaxSteps(body.maxSteps || body.max_steps),
        maxTokenBudget: normalizePositiveInt(body.maxTokenBudget || body.max_token_budget, 0, 0, 10000000),
        retryLimit: normalizePositiveInt(body.retryLimit || body.retry_limit, 1, 0, 5),
        contextConfig: serializeContextConfig(body.contextConfig || body.context_config),
        allowedUnits: shared ? String(body.allowedUnits || body.allowed_units || '').trim().slice(0, 500) : '',
        modelRouter: normalizeRouterStrategy(body.modelRouter || body.model_router),
        dagSpec: runMode === 'dag' && dagSpec.nodes.length ? JSON.stringify(dagSpec) : '',
        dagInputs: runMode === 'dag' ? JSON.stringify(normalizeDagInputsPayload(body.dagInputs || body.dag_inputs || {})) : '',
        workflowId: runMode === 'dag' && workflowId ? Number.parseInt(workflowId, 10) || null : null,
        workflowVersion: runMode === 'dag' ? String(body.workflowVersion || body.workflow_version || '').trim().slice(0, 40) : ''
    };
}

function listAgentTemplates(user) {
    return db.prepare(`
        SELECT *
        FROM agent_templates
        WHERE deleted_at IS NULL
          AND (user_id = ? OR scope = 'shared')
        ORDER BY scope DESC, updated_at DESC, id DESC
        LIMIT 100
    `).all(user.id).filter(template => assertTemplateAccess(template, user, false));
}

function createAgentTemplate(user, body = {}) {
    const data = normalizeTemplatePayload(body, user);
    const now = getBeijingTimestamp();
    const info = db.prepare(`
        INSERT INTO agent_templates (
            user_id, scope, name, description, goal_template, run_mode, tool_policy, tool_allowlist,
            approval_policy, max_steps, max_token_budget, retry_limit, context_config, allowed_units,
            model_router, dag_spec, dag_inputs, workflow_id, workflow_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        user.id, data.scope, data.name, data.description, data.goalTemplate, data.runMode,
        data.toolPolicy, data.toolAllowlist, data.approvalPolicy, data.maxSteps,
        data.maxTokenBudget, data.retryLimit, data.contextConfig, data.allowedUnits,
        data.modelRouter, data.dagSpec, data.dagInputs, data.workflowId, data.workflowVersion, now, now
    );
    return db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(info.lastInsertRowid);
}

function updateAgentTemplate(templateId, user, body = {}) {
    const template = db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(templateId);
    if (!assertTemplateAccess(template, user, true)) return null;
    const data = normalizeTemplatePayload(body, user);
    db.prepare(`
        UPDATE agent_templates
        SET scope = ?, name = ?, description = ?, goal_template = ?, run_mode = ?, tool_policy = ?,
            tool_allowlist = ?, approval_policy = ?, max_steps = ?, max_token_budget = ?, retry_limit = ?,
            context_config = ?, allowed_units = ?, model_router = ?, dag_spec = ?, dag_inputs = ?,
            workflow_id = ?, workflow_version = ?, updated_at = ?
        WHERE id = ?
    `).run(
        data.scope, data.name, data.description, data.goalTemplate, data.runMode, data.toolPolicy,
        data.toolAllowlist, data.approvalPolicy, data.maxSteps, data.maxTokenBudget, data.retryLimit,
        data.contextConfig, data.allowedUnits, data.modelRouter, data.dagSpec, data.dagInputs,
        data.workflowId, data.workflowVersion, getBeijingTimestamp(), templateId
    );
    return db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(templateId);
}

function deleteAgentTemplate(templateId, user) {
    const template = db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(templateId);
    if (!assertTemplateAccess(template, user, true)) return null;
    const now = getBeijingTimestamp();
    db.prepare('UPDATE agent_templates SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, templateId);
    return { ...template, deleted_at: now };
}

module.exports = {
    createAgentTemplate,
    deleteAgentTemplate,
    listAgentTemplates,
    updateAgentTemplate
};
