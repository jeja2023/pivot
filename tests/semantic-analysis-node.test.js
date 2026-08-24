const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildSemanticSegments,
    normalizeBatchTokenBudget,
    normalizeSemanticBatchConcurrency,
    resolveSemanticBatchConcurrency,
    normalizeBatchResult,
    semanticBatchOutputLimit
} = require('../server/services/data-analysis/semantic-analysis');

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

test('全量语义分析批次并发有上限并尊重额度安全边界', () => {
    assert.equal(normalizeSemanticBatchConcurrency('invalid'), 2);
    assert.equal(normalizeSemanticBatchConcurrency(0), 2);
    assert.equal(normalizeSemanticBatchConcurrency(99), 4);
    assert.equal(resolveSemanticBatchConcurrency({ max_concurrent: 8 }, 4), 4);
    assert.equal(resolveSemanticBatchConcurrency({ max_concurrent: 1 }, 4), 1);
    assert.equal(resolveSemanticBatchConcurrency({ max_concurrent: 4, daily_token_limit: 100000 }, 4), 1);
});

test('全量语义分析识别缺失分块并暴露可恢复信息', () => {
    const expected = [
        { rowId: 'row-1', chunkIndex: 0 },
        { rowId: 'row-2', chunkIndex: 0 },
        { rowId: 'row-3', chunkIndex: 1 }
    ];
    assert.throws(
        () => normalizeBatchResult(JSON.stringify({ items: [{ row_id: 'row-1', chunk: '1/1', result: 'ok' }] }), expected),
        error => {
            assert.equal(error.code, 'SEMANTIC_BATCH_INCOMPLETE');
            assert.equal(error.missingSegments.length, 2);
            assert.equal(error.partial.items.length, 1);
            return true;
        }
    );
});

test('全量语义分析兼容常见结果字段和原始标识回传', () => {
    const expected = [
        { rowNo: 7, rowId: '订单-7#7', chunkIndex: 0 },
        { rowNo: 8, rowId: '订单-8#8', chunkIndex: 1 }
    ];
    const normalized = normalizeBatchResult(JSON.stringify({
        summary: 'ok',
        results: [
            { row_id: '订单-7', chunk: '1/1', result: 'a' },
            { row_no: 8, chunk_index: 1, result: 'b' }
        ]
    }), expected);
    assert.equal(normalized.itemCount, 2);
    assert.equal(normalized.parsed.items.length, 2);
});

test('全量语义分析输出预算会限制子批次大小', () => {
    assert.ok(semanticBatchOutputLimit(2400) < 30);
    assert.equal(semanticBatchOutputLimit(6000), 30);
});

test('全量语义分析单分块单对象格式及顶层数组格式健壮解析', () => {
    const expectedSingle = [
        { rowNo: 1, rowId: 'row-1', chunkIndex: 0, chunkCount: 1 }
    ];
    const normalizedSingle = normalizeBatchResult(JSON.stringify({
        batch_summary: '单条摘要',
        result: '单条分析结论'
    }), expectedSingle);
    assert.equal(normalizedSingle.itemCount, 1);
    assert.equal(normalizedSingle.parsed.items[0].result, '单条分析结论');
    assert.equal(normalizedSingle.parsed.items[0].row_id, 'row-1');

    const expectedMulti = [
        { rowNo: 1, rowId: 'r-1', chunkIndex: 0, chunkCount: 1 },
        { rowNo: 2, rowId: 'r-2', chunkIndex: 0, chunkCount: 1 }
    ];
    const normalizedArray = normalizeBatchResult(JSON.stringify([
        { row_id: 'r-1', chunk: '1/1', result: '第一条' },
        { row_id: 'r-2', chunk: '1/1', result: '第二条' }
    ]), expectedMulti);
    assert.equal(normalizedArray.itemCount, 2);
    assert.equal(normalizedArray.parsed.items[1].result, '第二条');
});

test('全量语义分析支持 AbortController 任务级断流注册与中止', () => {
    const { getActiveJobControllers } = require('../server/services/data-analysis/semantic-analysis');
    const controllers = getActiveJobControllers();
    const testJobId = 'test-job-abort-1';
    const controller = new AbortController();
    controllers.set(testJobId, controller);

    assert.equal(controller.signal.aborted, false);
    assert.ok(controllers.has(testJobId));

    // 模拟中断
    controller.abort();
    assert.equal(controller.signal.aborted, true);
    controllers.delete(testJobId);
    assert.equal(controllers.has(testJobId), false);
});
