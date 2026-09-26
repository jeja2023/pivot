'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { pickAutoQuality } = require('../server/services/model-router');
const { inferTaskType } = require('../server/services/agent-model-quality');

test('quality-aware routing selects the best eligible verified profile', () => {
    const choice = pickAutoQuality([
        { id: 1, max_input_tokens: 32000, input_price_per_million: 1, output_price_per_million: 1 },
        { id: 2, max_input_tokens: 32000, input_price_per_million: 2, output_price_per_million: 2 }
    ], [
        { modelId: 1, eligible: true, verifiedRate: 0.8, incompleteRate: 0.2, samples: 12 },
        { modelId: 2, eligible: true, verifiedRate: 0.9, incompleteRate: 0.1, samples: 8 }
    ], 100);
    assert.equal(choice.id, 2);
    assert.equal(pickAutoQuality([{ id: 1 }], [{ modelId: 1, eligible: false }], 1), null);
});

test('task type inference separates research and data analysis from general tasks', () => {
    assert.equal(inferTaskType({ goal: '检索知识库并给出引用' }), 'research');
    assert.equal(inferTaskType({ goal: '分析数据库 SQL 数据' }), 'analysis');
    assert.equal(inferTaskType({ goal: '普通问答' }), 'general');
});
