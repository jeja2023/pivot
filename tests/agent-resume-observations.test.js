'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveResumeObservations } = require('../server/services/agent-runtime/resume-observations');

test('同任务崩溃安全回队从真实检查点恢复先前观察，保留原修复原因', async () => {
    const current = { checkpointCount: 3, latestStepIndex: 4, observations: [{ tool: 'read', output: { value: 9 } }] };
    const result = await resolveResumeObservations({ id: 'resume', started_at: '2026-11-09 14:00:00' }, { resumeContext: { previousError: '先前错误', latestStepIndex: 2 } }, async id => { assert.equal(id, 'resume'); return current; });
    assert.deepEqual(result.observations, current.observations); assert.equal(result.latestStepIndex, 4);
    assert.equal(result.previousError, '先前错误');
});

test('新任务不额外读取检查点，新续跑Run不能用空快照覆盖原任务观察，读取失败不静默重头执行', async () => {
    const stored = { sourceRunId: 'prior', latestStepIndex: 6, observations: [{ tool: 'read' }] };
    assert.equal(await resolveResumeObservations({ id: 'fresh' }, { resumeContext: stored }, async () => { throw new Error('新运行不应读取'); }), stored);
    for (const current of [{ checkpointCount: 0 }, { checkpointCount: 1, latestStepIndex: 1 }]) assert.equal(await resolveResumeObservations({ id: 'resume', started_at: 'prior' }, { resumeContext: stored }, async () => current), stored);
    await assert.rejects(resolveResumeObservations({ id: 'resume', started_at: 'prior' }, {}, async () => { throw new Error('存储不可用'); }), /存储不可用/);
});
