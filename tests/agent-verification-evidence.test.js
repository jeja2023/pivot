'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { loadVerificationEvidence } = require('../server/services/agent-verification-evidence');
const { beginAgentToolCheckpoint, completeAgentToolCheckpoint } = require('../server/services/agent-checkpoints');
const { inspectRunKnowledgeAccess } = require('../server/services/knowledge-run-access');

test('重启和跨Run续跑核验补回早期步骤、已应用回执和未落步骤的检查点，不吞掉相同真实操作', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`, first = `evidence-first-${suffix}`, next = `evidence-next-${suffix}`;
    try {
        for (const id of [first, next]) await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,metadata) VALUES (?,?,'完整核验','核验全部交付','executing',?::jsonb)",
            [id, user.id, JSON.stringify(id === next ? { resumeContext: { sourceRunId: first } } : {})]);
        for (let index = 0; index < 30; index++) await execute(`INSERT INTO agent_steps(run_id,step_index,type,tool_name,input,output,status,created_at)
            VALUES (?,?,'tool','file.read',?,?,'success',?::timestamptz)`,
        [first, index + 1, JSON.stringify({ index }), JSON.stringify({ text: index === 0 ? '首份必要依据' : `材料${index}` }), new Date(Date.now() - 60000 + index * 1000).toISOString()]);
        for (let index = 0; index < 2; index++) {
            const key = `evidence-operation-${suffix}-${index}`;
            await beginAgentToolCheckpoint(first, { operationKey: key, stepIndex: index + 1, toolName: 'file.read', input: { index: 0 }, user });
            await completeAgentToolCheckpoint(key, { text: '首份必要依据' }, { user });
        }
        const messageId = `evidence-control-${suffix}`;
        await execute(`INSERT INTO agent_control_messages(message_id,user_id,to_run_id,message_type,status,payload,payload_hash,applied_at)
            VALUES (?,? ,?,'reply','applied','{"kind":"delegation_completion","summary":"子任务交付依据"}','fixture',NOW())`, [messageId, user.id, first]);
        await execute("INSERT INTO agent_steps(run_id,step_index,type,tool_name,input,output,status) VALUES (?,1,'tool','commit','{}','{\"committed\":true}','success')", [next]);
        const memory = Array.from({ length: 10 }, (_, index) => ({ tool: 'file.read', input: { index: index + 20 }, output: { text: `材料${index + 20}` } }));
        const result = await loadVerificationEvidence(next, user, memory);
        assert.equal(result.length, 33);
        assert.equal(result[0].output.text, '首份必要依据');
        assert.equal(result.filter(item => item.output?.text === '首份必要依据').length, 2);
        assert.equal(result.filter(item => item.output?.text === '材料29').length, 1);
        assert(result.some(item => item.messageId === messageId && item.payload.summary === '子任务交付依据'));
        assert(result.some(item => item.evidenceId?.startsWith('checkpoint:')));
        assert.equal(result.at(-1).output.committed, true);
        await assert.rejects(() => loadVerificationEvidence(next, { id: -1 }, []), /无权访问/);
        await execute('UPDATE agent_runs SET deleted_at=NOW() WHERE id=?', [first]);
        assert.equal((await inspectRunKnowledgeAccess(next, user)).current, false);
        await assert.rejects(() => loadVerificationEvidence(next, user, []), /不可访问|不存在/);
    } finally { await execute('DELETE FROM agent_runs WHERE id IN (?,?)', [next, first]); }
});

test('核验记录超量时保守拒绝，不能仅传近期窗口作完整验收', async () => {
    await assert.rejects(() => loadVerificationEvidence('bounded', { id: 1 }, [], {
        run: async () => ({ id: 'bounded', metadata: {} }), assertAccess: async () => {},
        steps: async () => Array.from({ length: 2001 }, (_, id) => ({ id, type: 'tool', tool_name: 'read', output: { id } })),
        controls: async () => [], checkpoints: async () => []
    }), error => error.code === 'VERIFICATION_CONTEXT_LIMIT');
});


test('仅存在检查点的知识读取也要求完整来源，不能绕过读取和核验撤权', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `checkpoint-knowledge-${process.pid}-${Date.now()}`, key = `${runId}-read`;
    try {
        await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,metadata) VALUES (?,?,'恢复知识结果','恢复知识结果','executing','{}')", [runId, user.id]);
        await beginAgentToolCheckpoint(runId, { operationKey: key, stepIndex: 1, toolName: 'rag.search', input: { query: '资料' }, user });
        await completeAgentToolCheckpoint(key, { text: '没有来源的历史正文' }, { user });
        assert.equal((await inspectRunKnowledgeAccess(runId, user)).current, false);
        await assert.rejects(() => loadVerificationEvidence(runId, user, []), /不可访问/);
    } finally { await execute('DELETE FROM agent_runs WHERE id=?', [runId]); }
});


test('完成型目标核验合并同版本历史交付与本次结果，不能只核对本次新增事项', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`, first = `goal-evidence-${suffix}`, next = `${first}-next`, goalId = `goal-${suffix}`;
    try {
        for (const id of [first, next]) await execute("INSERT INTO agent_runs(id,user_id,title,goal,status,metadata) VALUES (?,?,'接续验收','完成两项交付','executing',?::jsonb)",
            [id, user.id, JSON.stringify({ source: 'goal', goalKind: 'goal', goalId, goalVersion: 1, ...(id === next ? { goalContinuation: { sourceRunId: first, goalId, goalVersion: 1 } } : {}) })]);
        for (const id of [first, next]) await execute("INSERT INTO agent_steps(run_id,step_index,type,tool_name,input,output,status) VALUES (?,1,'tool','commit','{}',?,'success')",
            [id, JSON.stringify({ receipt: id === first ? '第一项已交付' : '第二项已交付' })]);
        const result = await loadVerificationEvidence(next, user, []);
        assert.deepEqual(result.map(item => item.output.receipt), ['第一项已交付', '第二项已交付']);
        await execute("UPDATE agent_runs SET metadata=jsonb_set(metadata,'{goalVersion}','2'::jsonb) WHERE id=?", [first]);
        await assert.rejects(() => loadVerificationEvidence(next, user, []), /版本不一致/);
    } finally { await execute('DELETE FROM agent_runs WHERE id IN (?,?)', [next, first]); }
});
