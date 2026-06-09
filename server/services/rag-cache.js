const ragCache = new Map();

const RAG_CACHE_TTL = Math.max(parseInt(process.env.RAG_CACHE_TTL_MS || String(5 * 60 * 1000), 10) || 0, 0);
const RAG_CACHE_MAX = Math.max(parseInt(process.env.RAG_CACHE_MAX || '1000', 10) || 1000, 1);

function normalizeCacheQuery(query) {
    return String(query || '').trim().replace(/\s+/g, ' ').slice(0, 1000);
}

function normalizeCacheScope(scope) {
    return String(scope || '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

function getCacheKey(userId, query, topK, scope = '') {
    const normalizedScope = normalizeCacheScope(scope);
    const scopePart = normalizedScope ? `${normalizedScope}:` : '';
    return `${userId}:${topK}:${scopePart}${normalizeCacheQuery(query)}`;
}

function getFromCache(userId, query, topK, scope = '') {
    if (RAG_CACHE_TTL === 0) return null;
    const key = getCacheKey(userId, query, topK, scope);
    const cached = ragCache.get(key);
    if (cached && Date.now() - cached.at < RAG_CACHE_TTL) return cached.value;
    if (cached) ragCache.delete(key);
    return null;
}

function setToCache(userId, query, topK, value, scope = '') {
    if (RAG_CACHE_TTL === 0) return;
    const key = getCacheKey(userId, query, topK, scope);
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

function clearAllRagCache() {
    ragCache.clear();
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
    normalizeCacheScope,
    getFromCache,
    setToCache,
    clearRagCacheForUser,
    clearAllRagCache,
    getRagCacheSnapshot
};
