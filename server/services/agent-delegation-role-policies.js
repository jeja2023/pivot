'use strict';

const { queryOne } = require('../db/client');
const { assertTenantContext } = require('./agent-tenant-context');
const { isTenantAdmin } = require('./agent-skill-access');

const ROLE_KEYS = Object.freeze(['researcher', 'analyst', 'reviewer', 'writer']);
const DEFAULT_ROLE_POLICIES = Object.freeze({
    researcher: Object.freeze({ id: 'researcher-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 12, maxTokenBudget: 30000 }),
    analyst: Object.freeze({ id: 'analyst-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 12, maxTokenBudget: 30000 }),
    reviewer: Object.freeze({ id: 'reviewer-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 8, maxTokenBudget: 20000 }),
    writer: Object.freeze({ id: 'writer-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 8, maxTokenBudget: 20000 })
});

function rolePolicyError(message, code = 'AGENT_DELEGATION_ROLE_POLICY_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function normalizeRolePolicies(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const result = {};
    for (const key of ROLE_KEYS) {
        const base = DEFAULT_ROLE_POLICIES[key];
        const item = source[key] && typeof source[key] === 'object' ? source[key] : {};
        const maxSteps = Number.parseInt(item.maxSteps ?? item.max_steps ?? base.maxSteps, 10);
        const maxTokenBudget = Number.parseInt(item.maxTokenBudget ?? item.max_token_budget ?? base.maxTokenBudget, 10);
        if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > base.maxSteps) throw rolePolicyError(`角色 ${key} 的步数上限只能收紧到 1–${base.maxSteps}。`);
        if (!Number.isSafeInteger(maxTokenBudget) || maxTokenBudget < 1000 || maxTokenBudget > base.maxTokenBudget) throw rolePolicyError(`角色 ${key} 的 Token 上限只能收紧到 1000–${base.maxTokenBudget}。`);
        const toolPolicy = item.toolPolicy || item.tool_policy || base.toolPolicy;
        const approvalPolicy = item.approvalPolicy || item.approval_policy || base.approvalPolicy;
        if (toolPolicy !== 'builtin_only') throw rolePolicyError(`角色 ${key} 只能使用 builtin_only 工具策略。`);
        if (approvalPolicy !== 'approve_all_mcp') throw rolePolicyError(`角色 ${key} 必须使用 approve_all_mcp 审批策略。`);
        result[key] = { id: `${key}-org-v1`, toolPolicy, approvalPolicy, maxSteps, maxTokenBudget };
    }
    return result;
}

async function getDelegationRolePolicySnapshot(organizationId, deps = {}) {
    const read = deps.queryOne || queryOne;
    const safeOrganizationId = Number.parseInt(organizationId, 10);
    if (!Number.isSafeInteger(safeOrganizationId) || safeOrganizationId <= 0) throw rolePolicyError('组织标识无效。', 'AGENT_DELEGATION_ROLE_POLICY_ORGANIZATION_INVALID', 409);
    const row = await read('SELECT policy_json, revision, updated_at FROM agent_delegation_role_policies WHERE organization_id = ?', [safeOrganizationId]);
    if (!row) return { organizationId: safeOrganizationId, revision: 0, updatedAt: null, policies: normalizeRolePolicies(DEFAULT_ROLE_POLICIES) };
    let parsed = {};
    try { parsed = typeof row.policy_json === 'object' ? row.policy_json : JSON.parse(row.policy_json || '{}'); } catch (_) { throw rolePolicyError('组织角色策略 JSON 无效。', 'AGENT_DELEGATION_ROLE_POLICY_CORRUPT', 409); }
    return { organizationId: safeOrganizationId, revision: Number(row.revision || 0), updatedAt: row.updated_at || null, policies: normalizeRolePolicies(parsed) };
}

async function getDelegationRolePolicies(organizationId, deps = {}) {
    return (await getDelegationRolePolicySnapshot(organizationId, deps)).policies;
}

async function getDelegationRolePoliciesForUser(user, deps = {}) {
    const tenant = await (deps.assertTenantContext || assertTenantContext)(user);
    return await getDelegationRolePolicySnapshot(tenant.tenantId, deps);
}

async function saveDelegationRolePolicies(user, value, deps = {}) {
    if (!isTenantAdmin(user)) throw rolePolicyError('只有组织管理员可以修改协作角色策略。', 'AGENT_DELEGATION_ROLE_POLICY_ADMIN_REQUIRED', 403);
    const tenant = await (deps.assertTenantContext || assertTenantContext)(user);
    const policies = normalizeRolePolicies(value);
    const runQueryOne = deps.queryOne || queryOne;
    const now = new Date().toISOString();
    const stored = await runQueryOne(`
        INSERT INTO agent_delegation_role_policies (organization_id, policy_json, revision, updated_by, created_at, updated_at)
        VALUES (?, ?::jsonb, 1, ?, ?, ?)
        ON CONFLICT (organization_id) DO UPDATE SET
            policy_json = EXCLUDED.policy_json,
            revision = agent_delegation_role_policies.revision + 1,
            updated_by = EXCLUDED.updated_by,
            updated_at = EXCLUDED.updated_at
        RETURNING revision, updated_at
    `, [tenant.tenantId, JSON.stringify(policies), user.id, now, now]);
    return { organizationId: tenant.tenantId, revision: Number(stored?.revision || 0), updatedAt: stored?.updated_at || now, policies };
}

module.exports = { DEFAULT_ROLE_POLICIES, getDelegationRolePolicies, getDelegationRolePolicySnapshot, getDelegationRolePoliciesForUser, normalizeRolePolicies, saveDelegationRolePolicies };
