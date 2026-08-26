const assert = require('node:assert/strict');
const test = require('node:test');

// 这两个桩必须在 semantic-* 模块首次加载前装好：
// semantic-analysis 与 semantic-quota 在模块顶层解构依赖，加载后再替换就失效了。
const modelTextCallPath = require.resolve('../server/services/model-text-call');
const modelsPath = require.resolve('../server/services/models');
require(modelTextCallPath);
require(modelsPath);

const modelCalls = { active: 0, peak: 0, total: 0 };
let stubDailyUsage = 0;

function parseBatchEntries(messages) {
    const userContent = String(messages?.[1]?.content || '');
    const jsonStart = userContent.indexOf('[');
    return JSON.parse(userContent.slice(jsonStart));
}

require.cache[modelTextCallPath].exports = {
    callModelTextWithBudget: async ({ messages }) => {
        modelCalls.active += 1;
        modelCalls.total += 1;
        modelCalls.peak = Math.max(modelCalls.peak, modelCalls.active);
        try {
            // 让并发请求有机会重叠，串行实现的峰值只会停留在 1。
            await new Promise(resolve => setTimeout(resolve, 20));
            const entries = parseBatchEntries(messages);
            return {
                content: JSON.stringify({
                    batch_summary: `覆盖 ${entries.length} 个分块`,
                    items: entries.map(entry => ({
                        row_id: entry.row_id,
                        row_no: entry.row_no,
                        chunk: entry.chunk,
                        result: `结论-${entry.row_id}`
                    }))
                }),
                usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
                contextBudget: null
            };
        } finally {
            modelCalls.active -= 1;
        }
    }
};

const realModels = require.cache[modelsPath].exports;
require.cache[modelsPath].exports = {
    ...realModels,
    getModelDailyUsageAsync: async () => stubDailyUsage
};

const { analyzeSemanticBatchSegments, semanticBatchOutputLimit } = require('../server/services/data-analysis/semantic-analysis');
const { ensureSemanticQuota } = require('../server/services/data-analysis/semantic-quota');

function makeSegments(count) {
    return Array.from({ length: count }, (_, index) => ({
        rowNo: index + 1,
        rowId: `row-${index + 1}`,
        chunkIndex: 0,
        chunkCount: 1,
        text: `第 ${index + 1} 条记录内容`,
        charCount: 12,
        tokenEstimate: 24
    }));
}

test('超出输出上限的批次并行二分且结果覆盖全部分块', async () => {
    modelCalls.active = 0;
    modelCalls.peak = 0;
    modelCalls.total = 0;
    const maxOutputTokens = 2400;
    const outputLimit = semanticBatchOutputLimit(maxOutputTokens);
    const segments = makeSegments(40);
    assert.ok(segments.length > outputLimit * 2, '用例需要至少两层二分才能验证并行');

    const result = await analyzeSemanticBatchSegments({
        job: { instruction: '判断每条记录的风险等级', id_field: '' },
        batch: { batch_index: 0 },
        segments,
        options: { maxOutputTokens, totalBatches: 1 },
        user: { id: 1 },
        model: { id: 1, daily_token_limit: 0 }
    });

    // 二分后的两半互不依赖，必须并行发出；串行实现的并发峰值只会是 1。
    assert.ok(modelCalls.peak >= 2, `并发峰值应大于 1，实际为 ${modelCalls.peak}`);
    assert.ok(modelCalls.total >= 4, `40 个分块在上限 ${outputLimit} 下至少需要 4 次请求，实际 ${modelCalls.total} 次`);
    // 拆分与合并不得丢结果：每个分块都要有独立结论。
    assert.equal(result.itemCount, segments.length);
    assert.equal(result.parsed.items.length, segments.length);
    assert.deepEqual(
        result.parsed.items.map(item => item.row_id).sort(),
        segments.map(segment => segment.rowId).sort()
    );
    assert.equal(result.usage.totalTokens, 30 * modelCalls.total);
});

test('并发批次的每日额度由进程内预留量兜底，不会超发', async () => {
    const user = { id: 42 };
    const messages = [{ role: 'system', content: '系统提示' }, { role: 'user', content: '数据内容' }];
    // 单次调用的预估消耗约为 1200 输出预算加上极短的提示词，
    // 因此 1800 的额度只够一次调用，两次并发必然超发。
    const model = { id: 7, daily_token_limit: 1800 };
    stubDailyUsage = 0;

    // 第一次调用通过并登记预留量；此时用量表还没有落账。
    const releaseFirst = await ensureSemanticQuota(user, model, messages, 1200);
    assert.equal(typeof releaseFirst, 'function');
    // 第二次调用只看数据库用量会误判额度充足，计入预留量后必须直接拒绝。
    await assert.rejects(
        () => ensureSemanticQuota(user, model, messages, 1200),
        error => error.code === 'INSUFFICIENT_QUOTA' && error.status === 429
    );
    // 释放预留（真实链路中此时用量已同步入队）后，额度重新可用。
    releaseFirst();
    const releaseSecond = await ensureSemanticQuota(user, model, messages, 1200);
    releaseSecond();
    // 重复释放必须幂等，否则预留量会被扣成负数而放宽后续检查。
    releaseSecond();
    releaseSecond();
    const releaseThird = await ensureSemanticQuota(user, model, messages, 1200);
    releaseThird();

    // 已落账的用量同样计入，额度接近耗尽时第一次调用就该被拒绝。
    stubDailyUsage = 1700;
    await assert.rejects(
        () => ensureSemanticQuota(user, model, messages, 1200),
        error => error.code === 'INSUFFICIENT_QUOTA'
    );
    stubDailyUsage = 0;
});

test('未配置每日额度的模型跳过预留并返回空释放器', async () => {
    const release = await ensureSemanticQuota({ id: 1 }, { id: 2, daily_token_limit: 0 }, [], 1200);
    assert.equal(typeof release, 'function');
    release();
});
