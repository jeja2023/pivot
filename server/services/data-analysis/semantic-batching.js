const { estimateTokens } = require('../../llm');
const { getModelContextBudget } = require('../context-budget');
const { splitTextByTokenBudget } = require('../agent-content-review');

/**
 * 全量语义分析的批次切分与预算职责。
 * 只回答"一次请求该装多少内容、能并发多少请求"，不涉及任务状态与模型调用，
 * 因此可以被单元测试直接驱动，也让 semantic-analysis.js 专注任务编排。
 */

const DEFAULT_BATCH_TOKEN_BUDGET = 24000;
const MAX_BATCH_TOKEN_BUDGET = 60000;
const MAX_BATCH_SEGMENTS = Math.max(5, Math.min(60, Number.parseInt(process.env.DATA_ANALYSIS_SEMANTIC_MAX_SEGMENTS || '30', 10) || 30));
// 每个结果项都需要 row_id、chunk 和 result。为输出 JSON 预留固定空间后，
// 按每个分块的保守输出成本限制子批次大小，避免分块数在有限输出上限下被模型截断。
// 实际响应仍会经过完整性校验和递归拆分。
const SEMANTIC_OUTPUT_RESERVE_TOKENS = 512;
const SEMANTIC_OUTPUT_TOKENS_PER_SEGMENT = 160;
const DEFAULT_BATCH_CONCURRENCY = 2;
const MAX_BATCH_CONCURRENCY = Math.max(1, Math.min(16, Number.parseInt(process.env.DATA_ANALYSIS_SEMANTIC_MAX_BATCH_CONCURRENCY || '8', 10) || 8));

function clampText(value, max = 4000) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

function normalizeBatchTokenBudget(value) {
    const parsed = Number.parseInt(value, 10);
    return Math.max(8000, Math.min(MAX_BATCH_TOKEN_BUDGET, Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_TOKEN_BUDGET));
}

function normalizeMaxOutputTokens(value) {
    const parsed = Number.parseInt(value, 10);
    return Math.max(256, Math.min(8192, Number.isFinite(parsed) && parsed > 0 ? parsed : 4096));
}

function normalizeSemanticBatchConcurrency(value) {
    const parsed = Number.parseInt(value, 10);
    return Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_CONCURRENCY));
}

function resolveSemanticBatchConcurrency(model, requested) {
    const configured = normalizeSemanticBatchConcurrency(requested);
    // 并发批次的每日额度安全已由 ensureSemanticQuota 的进程内预留量兜底，
    // 因此不再把额度受限模型压成串行，只受模型端点自身的并发能力约束。
    const endpointLimit = Number.parseInt(model?.max_concurrent, 10);
    const fallbackLimit = Number.parseInt(process.env.MODEL_ENDPOINT_DEFAULT_CONCURRENCY || '2', 10) || 2;
    const limit = Number.isFinite(endpointLimit) && endpointLimit > 0 ? endpointLimit : fallbackLimit;
    return Math.max(1, Math.min(configured, limit));
}

function resolveEffectiveBatchTokens(model, requested, maxOutputTokens) {
    const configured = normalizeBatchTokenBudget(requested);
    const budget = getModelContextBudget(model, { maxOutputTokens });
    if (budget.unbounded) return configured;
    const safe = Math.floor(Number(budget.inputBudget || 0) * 0.65);
    if (safe < 8000) {
        const err = new Error('当前模型可用上下文不足以执行全量语义分析，请为模型配置至少 16K 上下文窗口。');
        err.status = 400;
        err.code = 'SEMANTIC_CONTEXT_TOO_SMALL';
        throw err;
    }
    return Math.min(configured, safe);
}

/**
 * 一次请求最多能覆盖多少个分块，由模型输出上限反推。
 * 超过这个数量的批次在分析阶段必然被二分，因此切分阶段就应该按它对齐。
 */
function semanticBatchOutputLimit(maxOutputTokens) {
    const outputBudget = Math.max(256, Number.parseInt(maxOutputTokens, 10) || 2400);
    const available = outputBudget - SEMANTIC_OUTPUT_RESERVE_TOKENS;
    return Math.max(1, Math.min(MAX_BATCH_SEGMENTS, Math.floor(available / SEMANTIC_OUTPUT_TOKENS_PER_SEGMENT)));
}

function normalizeMaxSegmentsPerBatch(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return MAX_BATCH_SEGMENTS;
    return Math.max(1, Math.min(MAX_BATCH_SEGMENTS, parsed));
}

function buildSemanticSegments(rows, batchTokens, maxSegmentsPerBatch) {
    const batchBudget = normalizeBatchTokenBudget(batchTokens);
    const segmentBudget = Math.max(1024, Math.floor(batchBudget * 0.72));
    // 缺省沿用历史上限，保证改造前创建的任务恢复后批次边界不发生位移。
    const segmentLimit = normalizeMaxSegmentsPerBatch(maxSegmentsPerBatch);
    const segments = [];
    rows.forEach(row => {
        const source = row.text;
        const chunks = source ? splitTextByTokenBudget(source, segmentBudget, 0) : [''];
        chunks.forEach((text, chunkIndex) => {
            segments.push({
                rowNo: row.rowNo,
                rowId: row.rowId,
                chunkIndex,
                chunkCount: chunks.length,
                text,
                charCount: text.length,
                tokenEstimate: estimateTokens(text)
            });
        });
    });
    const contentBudget = Math.max(1024, batchBudget - 1800);
    const batches = [];
    let current = [];
    let currentTokens = 0;
    const flush = () => {
        if (!current.length) return;
        const rowNumbers = Array.from(new Set(current.map(item => item.rowNo)));
        batches.push({
            segments: current,
            segmentStart: segments.indexOf(current[0]),
            segmentEnd: segments.indexOf(current[current.length - 1]),
            rowStart: Math.min(...rowNumbers),
            rowEnd: Math.max(...rowNumbers),
            rowCount: rowNumbers.length,
            charCount: current.reduce((sum, item) => sum + item.charCount, 0)
        });
        current = [];
        currentTokens = 0;
    };
    segments.forEach(segment => {
        const entryTokens = estimateTokens(JSON.stringify({ row_id: segment.rowId, chunk: `${segment.chunkIndex + 1}/${segment.chunkCount}`, text: segment.text }));
        if (current.length && (currentTokens + entryTokens > contentBudget || current.length >= segmentLimit)) flush();
        current.push(segment);
        currentTokens += entryTokens;
    });
    flush();
    // Array.indexOf 上面按对象引用定位，批次切片范围需要全局序号，避免同值文本造成边界歧义。
    let cursor = 0;
    return batches.map(batch => {
        const segmentStart = cursor;
        cursor += batch.segments.length;
        return { ...batch, segmentStart, segmentEnd: cursor - 1 };
    });
}

function buildSemanticSubBatch(batch, segments) {
    const rows = Array.from(new Set(segments.map(segment => segment.rowNo)));
    return {
        ...batch,
        segments,
        segment_count: segments.length,
        row_count: rows.length,
        char_count: segments.reduce((sum, segment) => sum + segment.charCount, 0)
    };
}

function mergeSemanticBatchResults(left, right) {
    const items = [
        ...(Array.isArray(left?.parsed?.items) ? left.parsed.items : []),
        ...(Array.isArray(right?.parsed?.items) ? right.parsed.items : [])
    ];
    const summary = [left?.summary, right?.summary].filter(Boolean).join('\n');
    const usage = {
        inputTokens: Number(left?.usage?.inputTokens || 0) + Number(right?.usage?.inputTokens || 0),
        outputTokens: Number(left?.usage?.outputTokens || 0) + Number(right?.usage?.outputTokens || 0),
        totalTokens: Number(left?.usage?.totalTokens || 0) + Number(right?.usage?.totalTokens || 0)
    };
    const parsed = { batch_summary: summary, items };
    return {
        parsed,
        summary: clampText(summary || '模型未返回批次摘要。', 1800),
        itemCount: items.length,
        responseText: JSON.stringify(parsed),
        usage,
        contextBudget: left?.contextBudget || right?.contextBudget || null
    };
}

module.exports = {
    DEFAULT_BATCH_TOKEN_BUDGET,
    MAX_BATCH_TOKEN_BUDGET,
    MAX_BATCH_SEGMENTS,
    DEFAULT_BATCH_CONCURRENCY,
    MAX_BATCH_CONCURRENCY,
    clampText,
    normalizeBatchTokenBudget,
    normalizeMaxOutputTokens,
    normalizeSemanticBatchConcurrency,
    resolveSemanticBatchConcurrency,
    resolveEffectiveBatchTokens,
    semanticBatchOutputLimit,
    normalizeMaxSegmentsPerBatch,
    buildSemanticSegments,
    buildSemanticSubBatch,
    mergeSemanticBatchResults
};
