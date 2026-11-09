'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { upsertMemory, getMemoryById, updateMemory, softDeleteMemory, recordMemoryUsage, setLongTermMemoryEnabled } = require('../server/services/long-term-memory');
const { captureMemoryReferences, resolveRunMemoryEvidence } = require('../server/services/agent-memory-evidence');
const { injectedRunMemoryReferences } = require('../server/repositories/agent-memory-evidence');

test('真实注入事件才能成为记忆核验依据，跨用户、内容更正、停用和遗忘均不能沿用旧快照', async () => {
    const user = await queryOne('SELECT id,role FROM users ORDER BY id LIMIT 1');
    const id = `memory-evidence-${process.pid}-${Date.now()}`;
    const created = await upsertMemory(user.id, { content: '松鹤项目结算规则：折扣率0.83，代号松鹤翠竹。', type: 'preference', scope: 'user', origin: 'explicit', assertedBy: 'user', salience: 0.8 }, { user, confirmed: true, explicit: true, skipEmbedding: true });
    assert.ok(created.id, JSON.stringify(created));
    const memory = await getMemoryById(user.id, created.id);
    const references = captureMemoryReferences([memory]);
    await execute("INSERT INTO agent_runs (id,user_id,title,goal,status,metadata,created_at,updated_at) VALUES (?,?,'记忆核验','按松鹤项目规则计算折后金额','running',?::jsonb,NOW(),NOW())", [id, user.id, JSON.stringify({ memoryUsage: { references } })]);
    const run = { id, user_id: user.id, goal: '按松鹤项目规则计算折后金额' };
    try {
        assert.deepEqual(await injectedRunMemoryReferences(id, user.id), [], '调用方自报metadata不等于实际注入');
        await recordMemoryUsage(user.id, [memory], { runId: id, eventType: 'candidate' });
        assert.deepEqual(await injectedRunMemoryReferences(id, user.id), []);
        await recordMemoryUsage(user.id, [memory], { runId: id, eventType: 'injected' });
        assert.deepEqual(await injectedRunMemoryReferences(id, user.id), references);
        assert.deepEqual(await injectedRunMemoryReferences(id, user.id + 1000000), []);
        assert.equal((await resolveRunMemoryEvidence(run, user)).current, true);
        await setLongTermMemoryEnabled(user.id, false);
        assert.equal((await resolveRunMemoryEvidence(run, user)).current, false);
        await setLongTermMemoryEnabled(user.id, true);
        await updateMemory(user.id, memory.id, { content: '松鹤项目结算规则：折扣率0.91，代号松鹤柏叶。' }, { user, skipEmbedding: true });
        assert.equal((await resolveRunMemoryEvidence(run, user)).current, false);
        await softDeleteMemory(user.id, memory.id, { reason: 'test_forget' });
        assert.equal((await resolveRunMemoryEvidence(run, user)).current, false);
    } finally {
        await setLongTermMemoryEnabled(user.id, true);
        await execute('DELETE FROM memory_usage_events WHERE run_id=?', [id]);
        await execute('DELETE FROM memories WHERE id=? AND user_id=?', [memory.id, user.id]);
        await execute('DELETE FROM agent_runs WHERE id=? AND user_id=?', [id, user.id]);
    }
});
