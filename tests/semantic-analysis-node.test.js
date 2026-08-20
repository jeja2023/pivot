const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSemanticSegments, normalizeBatchTokenBudget } = require('../server/services/data-analysis/semantic-analysis');

test('全量语义分析按 token 预算切分并保留全部文本', () => {
    const source = '第一段内容。'.repeat(9000);
    const rows = [
        { rowNo: 1, rowId: 'row-1', text: source },
        { rowNo: 2, rowId: 'row-2', text: '第二行' },
        { rowNo: 3, rowId: 'row-3', text: '' }
    ];
    const batches = buildSemanticSegments(rows, 8000);
    const segments = batches.flatMap(batch => batch.segments);
    assert.equal(segments.map(item => item.text).join(''), rows.map(item => item.text).join(''));
    assert.equal(new Set(segments.map(item => item.rowNo)).size, 3);
    assert.ok(segments.some(item => item.chunkCount > 1));
    assert.equal(batches[0].segmentStart, 0);
    assert.equal(batches.at(-1).segmentEnd, segments.length - 1);
});

test('全量语义分析批次预算有明确上下界', () => {
    assert.equal(normalizeBatchTokenBudget('invalid'), 24000);
    assert.equal(normalizeBatchTokenBudget(100), 8000);
    assert.equal(normalizeBatchTokenBudget(999999), 60000);
});
