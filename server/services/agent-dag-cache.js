const crypto = require('crypto');

/**
 * Agent DAG 节点级输出智能缓存管理模块
 * 基于节点工具类型、入参及上游依赖输出生成 SHA-256 稳态指纹。
 * 支持 TTL 过期与 LRU 驱逐，避免重复消耗 LLM token 与高耗时工具重算。
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 默认 15 分钟
const MAX_CACHE_ENTRIES = 1000;

// 内存 LRU 缓存表: key -> { output, createdAt, expiresAt, hits }
const nodeCacheStore = new Map();

// 不可缓存的工具清单（具有写操作、副作用或人工交互特性）
const UNCACHEABLE_TOOL_PATTERNS = [
    'workflow.approval',
    'workflow.delay',
    'delete',
    'remove',
    'create_order',
    'send_email',
    'publish'
];

function isCacheableDagTool(toolName) {
    if (!toolName || typeof toolName !== 'string') return false;
    const lower = toolName.toLowerCase();
    return !UNCACHEABLE_TOOL_PATTERNS.some(pat => lower.includes(pat));
}

/**
 * 稳态深度排序序列化（保证对象键顺序不影响哈希结果）
 */
function stableStringify(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * 计算 DAG 节点的执行指纹 Cache Key
 */
function computeDagNodeCacheKey({ tool = '', input = {}, dependsOnOutputs = {}, workflowId = '', nodeKey = '' } = {}) {
    const serializedPayload = stableStringify({
        workflowId: String(workflowId || ''),
        tool: String(tool || ''),
        input,
        dependsOnOutputs
    });
    return crypto.createHash('sha256').update(serializedPayload).digest('hex');
}

/**
 * 获取节点缓存输出
 */
function getCachedNodeOutput(cacheKey) {
    if (!cacheKey || !nodeCacheStore.has(cacheKey)) {
        return { hit: false };
    }
    const entry = nodeCacheStore.get(cacheKey);
    const now = Date.now();
    if (now > entry.expiresAt) {
        nodeCacheStore.delete(cacheKey);
        return { hit: false };
    }
    // 更新 LRU 顺序与访问统计
    entry.hits = (entry.hits || 0) + 1;
    nodeCacheStore.delete(cacheKey);
    nodeCacheStore.set(cacheKey, entry);

    return {
        hit: true,
        output: entry.output,
        cachedAt: entry.createdAt,
        hits: entry.hits
    };
}

/**
 * 设置节点缓存输出
 */
function setCachedNodeOutput(cacheKey, output, ttlMs = DEFAULT_TTL_MS) {
    if (!cacheKey || output === undefined) return;
    const now = Date.now();
    const expiresAt = now + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS);

    // LRU 限制淘汰
    if (nodeCacheStore.size >= MAX_CACHE_ENTRIES && !nodeCacheStore.has(cacheKey)) {
        const oldestKey = nodeCacheStore.keys().next().value;
        if (oldestKey) nodeCacheStore.delete(oldestKey);
    }

    nodeCacheStore.set(cacheKey, {
        output,
        createdAt: now,
        expiresAt,
        hits: 0
    });
}

/**
 * 清除缓存
 */
function clearDagNodeCache() {
    nodeCacheStore.clear();
}

/**
 * 缓存状态度量
 */
function getDagCacheStats() {
    let activeCount = 0;
    const now = Date.now();
    for (const [key, entry] of nodeCacheStore.entries()) {
        if (now <= entry.expiresAt) activeCount += 1;
        else nodeCacheStore.delete(key);
    }
    return {
        size: activeCount,
        maxSize: MAX_CACHE_ENTRIES
    };
}

module.exports = {
    isCacheableDagTool,
    stableStringify,
    computeDagNodeCacheKey,
    getCachedNodeOutput,
    setCachedNodeOutput,
    clearDagNodeCache
};
