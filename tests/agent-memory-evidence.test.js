'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { captureMemoryReferences, resolveRunMemoryEvidence } = require('../server/services/agent-memory-evidence');
const { verifyAutomaticTask } = require('../server/services/chat-task-verification');

const memory = { id: 7, content: '松鹤项目折扣率0.83。', origin: 'explicit', assertedBy: 'user' };
const run = { id: 'memory-verification', user_id: 1, model_id: 1, goal: '按松鹤项目规则计算折后金额', session_id: 'session', context_config: { projectId: 'project' } };
test('核验只使用实际注入的内容版本，并按当前用户和作用域重新检索', async () => {
    const references = captureMemoryReferences([memory]);
    const deps = { references: async (id, userId) => { assert.equal(id, run.id); assert.equal(userId, 1); return references; },
        retrieve: async (userId, goal, options) => { assert.equal(userId, 1); assert.equal(goal, run.goal); assert.equal(options.sessionId, 'session'); assert.equal(options.projectId, 'project'); return [memory]; } };
    const result = await resolveRunMemoryEvidence(run, { id: 1 }, deps);
    assert.equal(result.current, true); assert.equal(result.memories[0].content, memory.content);
    for (const current of [[], [{ ...memory, content: '规则已经更正' }]]) {
        assert.deepEqual(await resolveRunMemoryEvidence(run, { id: 1 }, { ...deps, retrieve: async () => current }), { current: false, memories: [] });
    }
    assert.deepEqual(await resolveRunMemoryEvidence(run, { id: 2 }, { references: async () => [], retrieve: async () => { throw new Error('不能查询无注入证据的记忆'); } }), { current: true, memories: [] });
});

test('独立核验接收记忆依据，核验期间撤销或变化仍拒绝发布', async () => {
    const contract = { deliverables: [], acceptance: {} };
    let checks = 0, modelCalls = 0;
    const base = { getModel: async () => ({ id: 1 }), resolveMemoryEvidence: async () => ({ current: true, memories: [memory] }),
        callModelJson: async (_model, messages, options) => { modelCalls++; const payload = JSON.parse(messages[1].content); assert.equal(payload.memoryEvidence.memories[0].id, 7);
            assert(options.timeoutMs > 20000 && options.timeoutMs <= 60000); assert(options.signal instanceof AbortSignal);
            assert.match(payload.memoryEvidence.purpose, /不能证明工具操作/);
            return JSON.stringify({ passed: true, needsInput: false, coveredDeliverables: [], missing: [] }); } };
    const result = await verifyAutomaticTask({ run, user: { id: 1 }, contract, answer: '166' }, base);
    assert.equal(result.passed, true);
    const revoked = await verifyAutomaticTask({ run, user: { id: 1 }, contract, answer: '166' }, {
        ...base, resolveMemoryEvidence: async () => ({ current: ++checks === 1, memories: [memory] })
    });
    assert.equal(revoked.passed, false); assert.equal(revoked.reason, 'source_revoked');
    const before = modelCalls;
    const changed = await verifyAutomaticTask({ run, user: { id: 1 }, contract, answer: '166' }, { ...base, resolveMemoryEvidence: async () => ({ current: false, memories: [] }) });
    assert.equal(changed.reason, 'source_revoked'); assert.equal(modelCalls, before);
});
