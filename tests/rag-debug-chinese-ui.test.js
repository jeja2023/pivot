'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('知识库召回诊断不向用户直出英文检索模式和排序标签', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../client/chat/rag-documents-panels.js'), 'utf8');
    assert.match(source, /混合检索（语义与关键词融合，已进行多样性重排）/);
    assert.match(source, /语义召回排名 第/);
    assert.match(source, /关键词召回排名 第/);
    assert.match(source, /已通过多样性重排入选/);
    assert.match(source, /执行中/);
    assert.match(source, /排队中/);
    assert.match(source, /并发上限/);
    assert.doesNotMatch(source, /`rank #\$\{/);
    assert.doesNotMatch(source, /`dense-rank #\$\{/);
    assert.doesNotMatch(source, /`fts #\$\{/);
    assert.doesNotMatch(source, /MMR selected/);
});
