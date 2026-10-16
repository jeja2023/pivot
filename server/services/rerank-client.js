const { safeJsonPost } = require('./safe-http-client');
const { getRerankConfig } = require('./rag-config');
const { logger } = require('../logger');

const MAX_RERANK_TEXT_CHARS = 6000;
const rerankCircuitStates = new Map();

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function getRerankCircuitSettings() {
    return {
        failureThreshold: clampInteger(process.env.RERANK_CIRCUIT_FAILURE_THRESHOLD, 3, 1, 20),
        cooldownMs: clampInteger(process.env.RERANK_CIRCUIT_COOLDOWN_MS, 30_000, 1_000, 300_000)
    };
}

function rerankCircuitKey(config = {}) {
    return `${resolveRerankUrl(config?.http?.url)}|${String(config?.http?.model || '').trim().toLowerCase()}`;
}

function getRerankCircuitState(config = {}, now = Date.now()) {
    const key = rerankCircuitKey(config);
    const state = rerankCircuitStates.get(key);
    if (!state || state.openUntil <= now) return { key, open: false };
    return { key, open: true, openUntil: state.openUntil, failures: state.failures };
}

function recordRerankFailure(config = {}, now = Date.now()) {
    const settings = getRerankCircuitSettings();
    const key = rerankCircuitKey(config);
    const previous = rerankCircuitStates.get(key) || { failures: 0, openUntil: 0 };
    const failures = previous.failures + 1;
    const next = {
        failures,
        openUntil: failures >= settings.failureThreshold ? now + settings.cooldownMs : 0
    };
    rerankCircuitStates.set(key, next);
    return { key, ...next };
}

function clearRerankCircuit(config = {}) {
    rerankCircuitStates.delete(rerankCircuitKey(config));
}

function resolveRerankUrl(url) {
    const raw = String(url || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/\/rerank$/i.test(raw)) return raw;
    return raw.replace(/\/v1$/i, '') + '/rerank';
}

function normalizeRerankScore(value) {
    const score = Number(value);
    if (!Number.isFinite(score)) return null;
    if (score >= 0 && score <= 1) return score;
    if (score > 30) return 1;
    if (score < -30) return 0;
    return 1 / (1 + Math.exp(-score));
}

function normalizeRerankResults(data) {
    const rows = Array.isArray(data) ? data
        : Array.isArray(data?.results) ? data.results
        : Array.isArray(data?.data) ? data.data
        : [];
    return rows.map((row, fallbackIndex) => ({
        index: Number.parseInt(row?.index ?? row?.text_index ?? fallbackIndex, 10),
        score: normalizeRerankScore(row?.score ?? row?.relevance_score ?? row?.rerank_score)
    })).filter(row => Number.isSafeInteger(row.index) && row.index >= 0 && row.score !== null);
}

function getCandidateText(candidate) {
    const heading = String(candidate?.headingPath || candidate?.heading_path || candidate?.article_label || '').trim();
    const title = String(candidate?.article_title || candidate?.document_title || candidate?.documentName || '').trim();
    const content = String(candidate?.text || candidate?.content || candidate?.excerpt || '').trim();
    return [heading, title, content].filter(Boolean).join('\n').slice(0, MAX_RERANK_TEXT_CHARS);
}

function buildRerankPayload(query, texts, config = {}) {
    const protocol = String(config?.http?.protocol || 'tei').trim().toLowerCase();
    const base = { query: String(query || '').trim(), model: config?.http?.model || '' };
    if (protocol === 'llama_cpp') {
        return { ...base, documents: texts, top_n: texts.length };
    }
    return { ...base, texts, raw_scores: false };
}

function applyRerankResults(candidates, ranks) {
    const byIndex = new Map(ranks.map(rank => [rank.index, rank.score]));
    const ranked = [];
    const remaining = [];
    candidates.forEach((candidate, index) => {
        if (!byIndex.has(index)) {
            remaining.push(candidate);
            return;
        }
        const externalRerankScore = byIndex.get(index);
        // 精确词面命中的原文保留部分本地相关性，避免跨模型分数标定差异把它直接清零。
        const lexicalFloor = candidate.phraseMatch && Number.isInteger(candidate.ftsRank)
            ? Number(candidate.rerankScore || 0) * 0.7 : 0;
        const effectiveScore = Math.max(externalRerankScore, lexicalFloor);
        ranked.push({ ...candidate, externalRerankScore, rerankScore: effectiveScore, rankScore: effectiveScore });
    });
    ranked.sort((left, right) => Number(right.rankScore) - Number(left.rankScore)
        || Number(right.externalRerankScore) - Number(left.externalRerankScore));
    return [...ranked, ...remaining];
}

// 仅接收已经过权限过滤和初步召回的有限候选；失败时返回原顺序，不能中断检索。
async function rerankCandidates(query, candidates, { config = getRerankConfig(), source = 'rag', request = safeJsonPost } = {}) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!config?.enabled || !config?.http?.url || !String(query || '').trim() || !list.length) {
        return { candidates: list, applied: false, reason: 'not_configured' };
    }
    const circuit = getRerankCircuitState(config);
    if (circuit.open) return { candidates: list, applied: false, reason: 'circuit_open' };
    const limit = Math.min(Math.max(Number(config.http.candidateLimit) || 30, 1), 100, list.length);
    const selected = list.slice(0, limit);
    const texts = selected.map(getCandidateText);
    if (!texts.some(Boolean)) return { candidates: list, applied: false, reason: 'empty_candidates' };
    try {
        const response = await request(resolveRerankUrl(config.http.url), buildRerankPayload(query, texts, config), {
            user: { role: 'admin' },
            headers: {
                Authorization: config.http.apiKey ? `Bearer ${config.http.apiKey}` : undefined,
                'Content-Type': 'application/json'
            },
            timeout: config.http.timeoutMs
        });
        const ranks = normalizeRerankResults(response?.data);
        if (!ranks.length) throw new Error('重排序服务未返回有效候选分数');
        clearRerankCircuit(config);
        return {
            candidates: [...applyRerankResults(selected, ranks), ...list.slice(limit)],
            applied: true,
            count: ranks.length
        };
    } catch (error) {
        const failure = recordRerankFailure(config);
        logger.warn({ err: error.message, source, candidates: limit, failures: failure.failures, openUntil: failure.openUntil || undefined }, '外部重排序不可用，保留现有检索排序');
        return { candidates: list, applied: false, reason: 'request_failed', error: String(error.message || error).slice(0, 500) };
    }
}

async function testRerankConnection({ apiUrl = '', apiKey = '', model = '', protocol = 'tei', candidateLimit = 3, timeoutMs = 5000 } = {}) {
    const config = {
        enabled: true,
        http: {
            url: String(apiUrl || '').trim(),
            apiKey: String(apiKey || '').trim(),
            model: String(model || '').trim() || 'BAAI/bge-reranker-v2-m3',
            protocol: String(protocol || '').trim().toLowerCase() === 'llama_cpp' ? 'llama_cpp' : 'tei',
            candidateLimit: Math.min(Math.max(Number.parseInt(candidateLimit, 10) || 3, 1), 10),
            timeoutMs: Math.min(Math.max(Number.parseInt(timeoutMs, 10) || 3000, 200), 30000)
        }
    };
    if (!config.http.url) return { success: false, error: '请填写重排序服务地址。' };
    clearRerankCircuit(config);
    const result = await rerankCandidates('劳动合同试用期最长多久', [
        { text: '劳动合同试用期最长不得超过六个月。' },
        { text: '用人单位应当按月支付工资。' }
    ], { config, source: 'rerank_connection_test' });
    return result.applied
        ? { success: true, ranked: result.count, protocol: config.http.protocol }
        : { success: false, error: result.error || '重排序服务未返回有效结果。' };
}

module.exports = {
    applyRerankResults,
    buildRerankPayload,
    clearRerankCircuit,
    normalizeRerankResults,
    resolveRerankUrl,
    rerankCandidates,
    testRerankConnection
};
