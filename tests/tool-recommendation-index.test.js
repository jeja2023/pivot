const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolRecommendationIndex } = require('../server/services/agent-runtime/tool-recommendation-index');

test('轻量工具索引匹配中英文且对无关工具给出零分', () => {
    const index = new ToolRecommendationIndex();
    index.addDocument('读取本地文件 read file');
    index.addDocument('查询天气 weather forecast');
    const scores = [];
    index.tfidfs('读取文件 read file', (i, score) => { scores[i] = score; });
    assert.ok(scores[0] > 0);
    assert.equal(scores[1], 0);
});
