const {
    assert,
    db,
    getBeijingTimestamp,
    test
} = require('../security-helpers');
const { preflightAgentRun } = require('../../server/services/agent-preflight');

test('agent preflight exposes readiness and capability health signals', async () => {
    const suffix = Date.now().toString(36);
    const now = getBeijingTimestamp();
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`agent_preflight_${suffix}`, 'hash', 'Agent Preflight Test', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `agent_preflight_${suffix}`, role: 'user', unit: 'QA' };
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Preflight Model', 'https://model.example/v1/chat/completions', `preflight-${suffix}`);
    const modelId = Number(modelInfo.lastInsertRowid);
    const serverInfo = db.prepare(`
        INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, last_error, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, 'active', ?, ?, ?)
    `).run(user.id, `Preflight MCP ${suffix}`, 'https://tools.example/mcp', 'preflight tool', 'tool failed', now, now);

    try {
        const result = await preflightAgentRun(user, {
            goal: '整理项目资料并生成检查建议',
            modelId,
            toolPolicy: 'all',
            approvalPolicy: 'safe_mcp_auto',
            maxSteps: 5,
            maxTokenBudget: 1000,
            contextPreviewTokens: 1500
        });
        assert.equal(result.summary.mcpErrorServers, 1);
        assert.equal(result.summary.estimatedInputTokens > 1000, true);
        assert.ok(Number.isInteger(result.summary.readinessScore));
        assert.equal(result.status, 'warning');

        const automaticAudit = await preflightAgentRun(user, {
            goal: '审查项目资料并输出完整风险清单',
            modelId,
            runMode: 'audit',
            toolPolicy: 'builtin_only',
            maxSteps: 0
        });
        assert.equal(automaticAudit.summary.maxSteps, 60);
        assert.equal(automaticAudit.summary.maxStepsAutomatic, true);
    } finally {
        db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverInfo.lastInsertRowid);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});
