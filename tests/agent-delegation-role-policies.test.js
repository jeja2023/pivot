'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    DEFAULT_ROLE_POLICIES,
    getDelegationRolePolicies,
    normalizeRolePolicies,
    saveDelegationRolePolicies
} = require('../server/services/agent-delegation-role-policies');

test('组织协作角色策略只能收紧为受控工具与审批边界', () => {
    const policies = normalizeRolePolicies({ reviewer: { maxSteps: 4, maxTokenBudget: 12000 } });
    assert.equal(policies.reviewer.maxSteps, 4);
    assert.equal(policies.reviewer.maxTokenBudget, 12000);
    assert.equal(policies.reviewer.toolPolicy, 'builtin_only');
    assert.throws(() => normalizeRolePolicies({ reviewer: { toolPolicy: 'all' } }), error => error.code === 'AGENT_DELEGATION_ROLE_POLICY_INVALID');
    assert.throws(() => normalizeRolePolicies({ reviewer: { approvalPolicy: 'safe_mcp_auto' } }), error => error.code === 'AGENT_DELEGATION_ROLE_POLICY_INVALID');
    assert.throws(() => normalizeRolePolicies({ reviewer: { maxSteps: 9 } }), error => error.code === 'AGENT_DELEGATION_ROLE_POLICY_INVALID');
    assert.throws(() => normalizeRolePolicies({ reviewer: { maxTokenBudget: 20001 } }), error => error.code === 'AGENT_DELEGATION_ROLE_POLICY_INVALID');
});

test('组织角色策略读取缺省时返回不可扩权的内置默认值', async () => {
    const result = await getDelegationRolePolicies(7, { queryOne: async () => null });
    assert.deepEqual(result, normalizeRolePolicies(DEFAULT_ROLE_POLICIES));
});

test('组织管理员以原子 UPSERT 写入带修订号的角色策略快照', async () => {
    const calls = [];
    const result = await saveDelegationRolePolicies({ id: 9, role: 'admin', tenant_id: 7 }, { reviewer: { maxSteps: 6 } }, {
        queryOne: async (...args) => { calls.push(['queryOne', ...args]); return { revision: 2, updated_at: '2026-10-18T00:00:00Z' }; },
        assertTenantContext: async () => ({ tenantId: 7 })
    });
    assert.equal(result.organizationId, 7);
    assert.equal(result.revision, 2);
    assert.equal(result.policies.reviewer.maxSteps, 6);
    assert.equal(calls[0][1].includes('agent_delegation_role_policies'), true);
    assert.equal(calls[0][1].includes('ON CONFLICT (organization_id)'), true);
});

test('非管理员不能写入组织角色策略', async () => {
    await assert.rejects(
        () => saveDelegationRolePolicies({ id: 9, role: 'user', tenant_id: 7 }, {}, { queryOne: async () => null, execute: async () => 1 }),
        error => error.code === 'AGENT_DELEGATION_ROLE_POLICY_ADMIN_REQUIRED'
    );
});
