// RAG 结果的无模型排序增强：反馈校正、引用可信度和稳定的并列排序。
// 该模块只处理已经召回的候选，不发起任何模型或外部网络请求。

function clamp(value, min = 0, max = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(Math.max(number, min), max);
}

function normalizeFeedbackSignal(signal) {
    if (!signal) return null;
    const helpful = Math.max(0, Number(signal.helpful || 0));
    const unhelpful = Math.max(0, Number(signal.unhelpful || 0));
    const total = helpful + unhelpful;
    if (total <= 0) return null;
    return {
        helpful,
        unhelpful,
        total,
        helpfulRate: helpful / total,
        scope: signal.scope || 'query'
    };
}

function resolveFeedbackSignal(feedbackSignals, item) {
    if (!(feedbackSignals instanceof Map)) return null;
    const chunkId = Number.parseInt(item?.chunkId, 10);
    const chunkSignal = Number.isSafeInteger(chunkId)
        ? normalizeFeedbackSignal(feedbackSignals.get(`chunk:${chunkId}`))
        : null;
    if (chunkSignal) return { ...chunkSignal, scope: 'chunk' };

    const documentName = String(item?.documentName || item?.source || '').trim();
    if (!documentName) return null;
    const documentSignal = normalizeFeedbackSignal(feedbackSignals.get(`doc:${documentName}`));
    return documentSignal ? { ...documentSignal, scope: 'document' } : null;
}

function feedbackAdjustment(signal) {
    const normalized = normalizeFeedbackSignal(signal);
    if (!normalized) return 0;
    // 贝叶斯式小样本收缩：单次误点不会大幅改变排序，反馈积累后最多影响 ±18%。
    const confidence = normalized.total / (normalized.total + 3);
    const signedRate = (normalized.helpful - normalized.unhelpful) / normalized.total;
    return clamp(signedRate * confidence * 0.18, -0.18, 0.18);
}

function applyFeedbackRanking(items, feedbackSignals = null) {
    return (Array.isArray(items) ? items : [])
        .map(item => {
            const baseScore = Number.isFinite(Number(item?.fused))
                ? Number(item.fused)
                : (Number.isFinite(Number(item?.score)) ? Number(item.score) : 0);
            const feedback = resolveFeedbackSignal(feedbackSignals, item);
            const adjustment = feedbackAdjustment(feedback);
            return {
                ...item,
                feedback,
                feedbackAdjustment: adjustment,
                rankScore: baseScore * (1 + adjustment)
            };
        })
        .sort((a, b) => (
            Number(b.rankScore || 0) - Number(a.rankScore || 0)
            || Number(b.fused || b.score || 0) - Number(a.fused || a.score || 0)
            || Number(a.chunkId || 0) - Number(b.chunkId || 0)
        ));
}

function calculateCitationConfidence(item, scoreThreshold = 0, maxRankScore = null) {
    const denseScore = Number(item?.denseScore ?? item?.score);
    const denseQuality = Number.isFinite(denseScore)
        ? clamp((denseScore - Number(scoreThreshold || 0)) / Math.max(1 - Number(scoreThreshold || 0), 0.1))
        : 0;
    const rankScore = Number(item?.rankScore ?? item?.fused ?? item?.score);
    const maxScore = Number(maxRankScore);
    const rankQuality = Number.isFinite(rankScore) && maxScore > 0 ? clamp(rankScore / maxScore) : 0;
    const ftsRank = Number.isInteger(item?.ftsRank) ? item.ftsRank : null;
    const lexicalQuality = ftsRank == null ? 0 : clamp(1 - ftsRank / 10);
    const sourceQuality = String(item?.headingPath || '').trim() ? 1 : 0.55;
    const feedback = normalizeFeedbackSignal(item?.feedback);
    const feedbackQuality = feedback ? (feedback.helpful + 1) / (feedback.total + 2) : 0.5;
    return clamp(
        denseQuality * 0.4
        + rankQuality * 0.3
        + lexicalQuality * 0.15
        + sourceQuality * 0.1
        + feedbackQuality * 0.05
    );
}

function attachCitationConfidence(items, scoreThreshold = 0) {
    const list = Array.isArray(items) ? items : [];
    const maxRankScore = list.reduce((max, item) => Math.max(max, Number(item?.rankScore ?? item?.fused ?? item?.score) || 0), 0);
    return list.map(item => ({
        ...item,
        citationConfidence: calculateCitationConfidence(item, scoreThreshold, maxRankScore)
    }));
}

module.exports = {
    applyFeedbackRanking,
    attachCitationConfidence,
    calculateCitationConfidence,
    feedbackAdjustment
};
