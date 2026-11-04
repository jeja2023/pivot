'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { getRunDetailForUser } = require('../server/services/agent-runs');
const { runWithRequestContext } = require('../server/services/request-context');

test('详情首屏限制步骤与字段体积，权限保护继续生效且诊断可独立读取', async () => {
    const suffix = `${process.pid}-${Date.now()}`, runId = `detail-overview-${suffix}`;
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,role", [`detail-overview-${suffix}`]);
    try {
        await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,run_mode,max_steps,metadata,created_at,updated_at) VALUES (?,?,'任务标题','概念解释','partial','standard',30,?,NOW(),NOW())", [runId, user.id,
            JSON.stringify({ chatHistory: [{ content: '超长会话内容'.repeat(5000) }], chatBridge: { memoryContext: '未用于首屏的长文'.repeat(3000) }, taskVerification: { outcomeStatus: 'partial' } })]);
        for (let index = 1; index <= 103; index++) await execute("INSERT INTO agent_steps(run_id,step_index,type,title,tool_name,input,output,status,created_at) VALUES (?,?,'tool','读取信息','example.read','{}',?,'success',NOW())", [runId, index, JSON.stringify({ text: index === 100 ? '超大输出'.repeat(6000) : '摘要' })]);
        const overview = await runWithRequestContext({ requestId: suffix }, () => getRunDetailForUser(runId, user, { view: 'overview' }));
        assert.equal(overview.detailLevel, 'overview'); assert.equal(overview.diagnosticsDeferred, true); assert.equal(overview.steps.length, 100);
        assert.equal(overview.truncated, true); assert.equal(overview.trace, null); assert.equal(overview.verification.outcomeStatus, 'partial');
        assert.doesNotMatch(JSON.stringify(overview), /超长会话内容|未用于首屏的长文|超大输出/);
        assert.equal(await getRunDetailForUser(runId, { id: Number(user.id) + 999999 }, { view: 'overview' }), null);
        await execute("UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
        const blocked = await getRunDetailForUser(runId, user, { view: 'overview' });
        assert.equal(blocked.knowledgeAccess.current, false); assert.deepEqual(blocked.steps, []); assert.doesNotMatch(JSON.stringify(blocked), /任务标题/);
    } finally {
        await execute('DELETE FROM agent_steps WHERE run_id = ?', [runId]);
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
});
