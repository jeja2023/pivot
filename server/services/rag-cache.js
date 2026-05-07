const ragCache = new Map();

const RAG_CACHE_TTL = Math.max(parseInt(process.env.RAG_CACHE_TTL_MS || String(5 * 60 * 1000), 10) || 0, 0);
const RAG_CACHE_MAX = Math.max(parseInt(process.env.RAG_CACHE_MAX || '1000', 10) || 1000, 1);

function normalizeCacheQuery(query) {
    return String(query || '').trim().replace(/\s+/g, ' ').slice(0, 1000);
}

function getCacheKey(userId, query, topK) {
    return `${userId}:${topK}:${normalizeCacheQuery(query)}`;
}

function getFromCache(userId, query, topK) {
    if (RAG_CACHE_TTL === 0) return null;
    const key = getCacheKey(userId, query, topK);
    const cached = ragCache.get(key);
    if (cached && Date.now() - cached.at < RAG_CACHE_TTL) return cached.value;
    if (cached) ragCache.delete(key);
    return null;
}

function setToCache(userId, query, topK, value) {
    if (RAG_CACHE_TTL === 0) return;
    const key = getCacheKey(userId, query, topK);
    while (ragCache.size >= RAG_CACHE_MAX) {
        const firstKey = ragCache.keys().next().value;
        ragCache.delete(firstKey);
    }
    ragCache.set(key, { value, at: Date.now() });
}

function clearRagCacheForUser(userId) {
    const prefix = `${userId}:`;
    for (const key of ragCache.keys()) {
        if (key.startsWith(prefix)) ragCache.delete(key);
    }
}

function getRagCacheSnapshot() {
    return {
        enabled: RAG_CACHE_TTL > 0,
        ttlMs: RAG_CACHE_TTL,
        maxEntries: RAG_CACHE_MAX,
        entries: ragCache.size
    };
}

module.exports = {
    normalizeCacheQuery,
    getFromCache,
    setToCache,
    clearRagCacheForUser,
    getRagCacheSnapshot
};
