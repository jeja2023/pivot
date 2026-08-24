// RAG 热路径和全局指标渲染共同使用的轻量内存计数器。
// 本模块保持为无业务依赖的叶子节点，避免 metrics -> maintenance ->
// document-processing -> rag-index -> metrics 的 CommonJS 循环依赖。
const ragStats = {
    retrievals: 0,
    retrievalErrors: 0,
    hits: 0,
    cacheHits: 0,
    cacheMisses: 0,
    emptyResults: 0,
    totalRetrievalMs: 0,
    totalCandidates: 0,
    totalMatches: 0,
    topScoreSum: 0,
    topScoreCount: 0,
    ingests: 0,
    ingestErrors: 0,
    totalIngestMs: 0,
    chunksIndexed: 0
};

function recordRagRetrieval({
    status = 'unknown',
    durationMs = 0,
    candidates = 0,
    matches = 0,
    topScore = null,
    cacheHit = false
} = {}) {
    ragStats.retrievals += 1;
    ragStats.totalRetrievalMs += Math.max(Number(durationMs) || 0, 0);
    ragStats.totalCandidates += Math.max(Number(candidates) || 0, 0);
    ragStats.totalMatches += Math.max(Number(matches) || 0, 0);
    if (cacheHit || status === 'cache_hit') {
        ragStats.cacheHits += 1;
    } else {
        ragStats.cacheMisses += 1;
    }
    if (status === 'hit' || (status === 'cache_hit' && Number(matches) > 0)) {
        ragStats.hits += 1;
    }
    if (status === 'error') ragStats.retrievalErrors += 1;
    if (status === 'empty' || status === 'no_match') ragStats.emptyResults += 1;
    if (Number.isFinite(topScore)) {
        ragStats.topScoreSum += topScore;
        ragStats.topScoreCount += 1;
    }
}

function recordRagIngest({
    status = 'unknown',
    chunks = 0,
    durationMs = 0
} = {}) {
    ragStats.ingests += 1;
    ragStats.totalIngestMs += Math.max(Number(durationMs) || 0, 0);
    ragStats.chunksIndexed += Math.max(Number(chunks) || 0, 0);
    if (status === 'error') ragStats.ingestErrors += 1;
}

function getRagMetricsSnapshot() {
    return {
        retrievals: ragStats.retrievals,
        retrievalErrors: ragStats.retrievalErrors,
        hits: ragStats.hits,
        cacheHits: ragStats.cacheHits,
        cacheMisses: ragStats.cacheMisses,
        hitRate: ragStats.retrievals > 0 ? ragStats.hits / ragStats.retrievals : 0,
        cacheHitRate: ragStats.retrievals > 0 ? ragStats.cacheHits / ragStats.retrievals : 0,
        emptyResults: ragStats.emptyResults,
        avgRetrievalMs: ragStats.retrievals > 0 ? ragStats.totalRetrievalMs / ragStats.retrievals : 0,
        avgCandidates: ragStats.retrievals > 0 ? ragStats.totalCandidates / ragStats.retrievals : 0,
        avgMatches: ragStats.retrievals > 0 ? ragStats.totalMatches / ragStats.retrievals : 0,
        avgTopScore: ragStats.topScoreCount > 0 ? ragStats.topScoreSum / ragStats.topScoreCount : 0,
        ingests: ragStats.ingests,
        ingestErrors: ragStats.ingestErrors,
        chunksIndexed: ragStats.chunksIndexed,
        avgIngestMs: ragStats.ingests > 0 ? ragStats.totalIngestMs / ragStats.ingests : 0
    };
}

module.exports = {
    recordRagRetrieval,
    recordRagIngest,
    getRagMetricsSnapshot
};
