'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('知识使用与治理的质量评测页以中文展示状态和指标', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../client/chat/knowledge-product.js'), 'utf8');
    assert.match(source, /completed: '已完成'/);
    assert.match(source, /recallAt3: \{ label: '前 3 条召回率'/);
    assert.match(source, /mrr: \{ label: '平均倒数排名'/);
    assert.match(source, /ndcgAt5: \{ label: '前 5 条排序质量'/);
    assert.match(source, /citationF1: \{ label: '引用综合得分'/);
    assert.match(source, /groundingAcceptanceRate: \{ label: '依据核验通过率'/);
    assert.match(source, /预期片段编号（可选，逗号分隔）/);
    assert.match(source, /回答评测模型编号（可选）/);
    assert.doesNotMatch(source, /Recall@3/);
    assert.doesNotMatch(source, /\bMRR\b/);
    assert.doesNotMatch(source, /nDCG@5/);
    assert.doesNotMatch(source, /引用 F1/);
    assert.match(source, /confidence_rejected: '候选未通过相关性与可信度校验'/);
    assert.match(source, /已隐藏未通过相关性与可信度校验的候选/);
});
