'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { describeSkillForUser, searchSkillsForUser } = require('../server/services/agent-skill-discovery');

function release(overrides = {}) {
    return {
        id: 7, name: 'invoice-review', version: '1.0.0', digest: 'digest-one', status: 'published', rollout_scope: 'personal',
        manifest_json: JSON.stringify({ title: '票据检查', description: '检查票据', tags: ['财务'], capabilities: ['data.sql.query'], tools: ['data.query'], inputs: { amount: { type: 'number' } }, outputs: { result: { type: 'string' } } }),
        instructions_md: '内部指令不进入搜索结果', ...overrides
    };
}

test('skill discovery filters authorized published candidates by domain and capability without exposing contracts or instructions', async () => {
    const deps = { listSkillCatalogForUser: async (user, options) => {
        assert.equal(options.useOnly, true);
        return user.id === 1 ? [release(), release({ id: 8, name: 'paused', status: 'paused' })] : [];
    } };
    const result = await searchSkillsForUser({ id: 1 }, { query: '票据', domain: '财务', capability: 'data.sql.query' }, deps);
    assert.equal(result.total, 1);
    assert.equal(result.candidates[0].reference.releaseId, '7');
    assert.equal(result.candidates[0].inputs, undefined);
    assert.equal(JSON.stringify(result).includes('内部指令'), false);
    assert.equal((await searchSkillsForUser({ id: 2 }, {}, deps)).total, 0);
    assert.equal((await searchSkillsForUser({ id: 1 }, { capability: 'other' }, deps)).total, 0);
});

test('skill description rechecks access and rejects changed releases', async () => {
    let visible = [release()];
    const deps = { listSkillCatalogForUser: async () => visible };
    const reference = (await searchSkillsForUser({ id: 1 }, {}, deps)).candidates[0].reference;
    const detail = await describeSkillForUser({ id: 1 }, reference, deps);
    assert.deepEqual(detail.tools, ['data.query']);
    assert.equal(detail.inputs.amount.type, 'number');
    visible = [release({ digest: 'digest-two' })];
    await assert.rejects(() => describeSkillForUser({ id: 1 }, reference, deps), error => error.code === 'SKILL_REFERENCE_STALE');
    visible = [release({ id: 9, version: '1.1.0' })];
    await assert.rejects(() => describeSkillForUser({ id: 1 }, reference, deps), error => error.code === 'SKILL_REFERENCE_STALE');
    visible = [];
    await assert.rejects(() => describeSkillForUser({ id: 1 }, reference, deps), error => error.code === 'SKILL_NOT_AVAILABLE');
    await assert.rejects(() => describeSkillForUser({ id: 1 }, { name: reference.name }, deps), error => error.code === 'SKILL_REFERENCE_REQUIRED');
});
