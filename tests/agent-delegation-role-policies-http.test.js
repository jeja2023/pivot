'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'pivot-delegation-role-policy-http-secret-012345678901234567890123';

const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const { authMiddleware, login, register } = require('../server/auth');
const { execute, queryOne } = require('../server/db/client');
const { createAgentsRouter } = require('../server/routes/agents');
const { executeAgentSpawn } = require('../server/services/agent-tools-collaboration');

test('组织协作角色策略 HTTP 接口隔离租户且只允许管理员收紧策略', async () => {
    const suffix = `${process.pid}${Date.now()}`;
    const password = 'RolePolicy123';
    const adminName = `role_admin_${suffix}`;
    const memberName = `role_member_${suffix}`;
    const admin = await register(adminName, password, '角色管理员', 'QA', 'user');
    const member = await register(memberName, password, '角色成员', 'QA', 'user');
    const organization = await queryOne("INSERT INTO organizations (name, slug, status) VALUES (?, ?, 'active') RETURNING id", [`协作策略 ${suffix}`, `delegation-role-${suffix}`]);
    const team = await queryOne("INSERT INTO teams (organization_id, name, slug, status) VALUES (?, ?, ?, 'active') RETURNING id", [organization.id, '协作团队', `role-team-${suffix}`]);
    await execute("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    await execute("INSERT INTO team_members (team_id, user_id, role, status) VALUES (?, ?, 'admin', 'active'), (?, ?, 'member', 'active')", [team.id, admin.id, team.id, member.id]);
    const adminSession = await login(adminName, password, { clientIp: '127.0.0.1' });
    const memberSession = await login(memberName, password, { clientIp: '127.0.0.1' });
    const app = express();
    app.use(express.json());
    app.use('/api', createAgentsRouter({ authMiddleware, logAction: () => {} }));
    app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: error.message, code: error.code }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/agents/delegation/role-policies`;
    const request = (token, options = {}) => fetch(base, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
    try {
        assert.equal((await fetch(base)).status, 401);
        const before = await request(memberSession.accessToken);
        assert.equal(before.status, 200);
        assert.equal((await before.json()).data.organizationId, Number(organization.id));
        const forbidden = await request(memberSession.accessToken, { method: 'PUT', body: JSON.stringify({ policies: { reviewer: { maxSteps: 5, maxTokenBudget: 10000 } } }) });
        assert.equal(forbidden.status, 403);
        const saved = await request(adminSession.accessToken, { method: 'PUT', body: JSON.stringify({ policies: { reviewer: { maxSteps: 5, maxTokenBudget: 10000 } } }) });
        assert.equal(saved.status, 200);
        const savedBody = await saved.json();
        assert.equal(savedBody.data.revision, 1);
        assert.equal(savedBody.data.policies.reviewer.maxSteps, 5);
        const visible = await request(memberSession.accessToken);
        const visibleBody = await visible.json();
        assert.equal(visibleBody.data.revision, 1);
        assert.equal(visibleBody.data.policies.reviewer.maxSteps, 5);
        assert.equal(visibleBody.data.policies.reviewer.maxTokenBudget, 10000);
        let childInput = null;
        await executeAgentSpawn({ goal: '审阅组织协作策略是否正确收紧。', role: 'reviewer', maxSteps: 30, maxTokenBudget: 50000 }, { id: admin.id, role: 'admin', tenant_id: organization.id }, {
            run: {
                id: `role-policy-parent-${suffix}`, user_id: admin.id, tenant_id: organization.id, model_id: 1,
                run_mode: 'standard', max_steps: 40, max_token_budget: 80000, tool_policy: 'all', tool_allowlist: [],
                approval_policy: 'approve_all_mcp', network_policy: { enabled: false }
            },
            collaborationRuntime: { createAgentRun: async input => { childInput = input; return { id: `role-policy-child-${suffix}`, title: input.title, status: 'queued' }; } }
        });
        assert.equal(childInput.maxSteps, 5);
        assert.equal(childInput.maxTokenBudget, 10000);
        assert.equal(childInput.toolPolicy, 'builtin_only');
        assert.equal(childInput.approvalPolicy, 'approve_all_mcp');
        const expanded = await request(adminSession.accessToken, { method: 'PUT', body: JSON.stringify({ policies: { reviewer: { maxSteps: 9, maxTokenBudget: 10000 } } }) });
        assert.equal(expanded.status, 400);
        assert.equal((await expanded.json()).code, 'AGENT_DELEGATION_ROLE_POLICY_INVALID');
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await execute('DELETE FROM agent_delegation_role_policies WHERE organization_id = ?', [organization.id]);
        await execute('DELETE FROM team_members WHERE team_id = ?', [team.id]);
        await execute('DELETE FROM teams WHERE id = ?', [team.id]);
        await execute('DELETE FROM organizations WHERE id = ?', [organization.id]);
        await execute('DELETE FROM refresh_tokens WHERE user_id IN (?, ?)', [admin.id, member.id]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [admin.id, member.id]);
    }
});
