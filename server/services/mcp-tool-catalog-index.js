const crypto = require('crypto');
const { generateEmbeddingsAdaptive } = require('./rag-index/embedding-client');
const { getEmbeddingConfig } = require('./rag-config');
const { logger } = require('../logger');

const MAX_TOOL_VECTOR_DIMENSIONS = 8192;
const MAX_TOOL_CATALOG_CACHE_ENTRIES = 2048;

function parseVector(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOL_VECTOR_DIMENSIONS) return [];
    return value.map(Number).every(Number.isFinite) ? value.map(Number) : [];
}

function toolSignature(tool = {}) {
    const name = String(tool.name || tool.fullName || '').trim();
    const displayName = String(tool.displayTitle || tool.title || '').trim();
    const server = String(tool.serverName || '').trim();
    const type = String(tool.serverType || '').trim();
    const description = String(tool.displayDescription || tool.description || '').trim();
    return [
        displayName ? `工具：${displayName}` : '',
        `内部标识：${name}`,
        server ? `服务：${server}` : '',
        type ? `类型：${type}` : '',
        description
    ].filter(Boolean).join('\n').slice(0, 1800);
}

function toolFingerprint(tool = {}) {
    return crypto.createHash('sha256').update(JSON.stringify({
        fullName: String(tool.fullName || ''),
        name: String(tool.name || ''),
        displayTitle: String(tool.displayTitle || tool.title || ''),
        displayDescription: String(tool.displayDescription || ''),
        serverName: String(tool.serverName || ''),
        serverType: String(tool.serverType || ''),
        description: String(tool.description || ''),
        schema: tool.input_schema || tool.inputSchema || null
    })).digest('hex');
}

function embeddingKey(config = {}) {
    const http = config.http || config.cloud || {};
    return crypto.createHash('sha256').update(JSON.stringify({
        mode: String(config.mode || ''),
        url: String(http.url || ''),
        model: String(http.model || '')
    })).digest('hex');
}

function createMcpToolCatalogIndex(deps = {}) {
    const generateEmbeddings = deps.generateEmbeddingsAdaptive || generateEmbeddingsAdaptive;
    const getConfig = deps.getEmbeddingConfig || getEmbeddingConfig;
    const cache = new Map();
    const inFlight = new Map();

    function getEntries(tools = [], { embeddingConfig = null, userId = null } = {}) {
        const config = embeddingConfig || getConfig(userId);
        const key = embeddingKey(config);
        return (Array.isArray(tools) ? tools : []).map(tool => {
            const fingerprint = toolFingerprint(tool);
            const cached = cache.get(`${key}:${fingerprint}`);
            return {
                tool,
                fingerprint,
                semanticSignature: toolSignature(tool),
                vector: cached?.vector || [],
                embeddingKey: key
            };
        });
    }

    async function refreshEntries(entries = [], { user = null, embeddingConfig = null, signal = null } = {}) {
        const config = embeddingConfig || getConfig(user?.id || null);
        if (!config?.http?.url) return entries;
        const missing = entries.filter(entry => entry && !parseVector(entry.vector).length);
        if (!missing.length) return entries;
        const key = `${embeddingKey(config)}:${missing.map(entry => entry.fingerprint).join('|')}`;
        if (inFlight.has(key)) return await inFlight.get(key);
        const work = (async () => {
            const vectors = await generateEmbeddings(
                missing.map(entry => entry.semanticSignature),
                null,
                config.http,
                user?.id || null,
                { source: 'chat_route_tool_catalog', allowPartial: true, signal }
            );
            const refreshed = new Map();
            missing.forEach((entry, index) => {
                const vector = parseVector(vectors[index]);
                if (!vector.length) return;
                while (cache.size >= MAX_TOOL_CATALOG_CACHE_ENTRIES) {
                    const oldest = cache.keys().next().value;
                    if (oldest === undefined) break;
                    cache.delete(oldest);
                }
                cache.set(`${entry.embeddingKey}:${entry.fingerprint}`, { vector, updatedAt: Date.now() });
                refreshed.set(entry.fingerprint, vector);
            });
            return entries.map(entry => refreshed.has(entry.fingerprint)
                ? { ...entry, vector: refreshed.get(entry.fingerprint) }
                : entry);
        })().finally(() => inFlight.delete(key));
        inFlight.set(key, work);
        return await work;
    }

    function scheduleRefresh(entries = [], options = {}) {
        setImmediate(() => {
            refreshEntries(entries, options).catch(error => {
                logger.warn({ err: error.message }, 'MCP 工具目录后台刷新失败，将在后续请求重试');
            });
        });
    }

    function invalidate(_fullName = '') {
        // 缓存键含 Schema 指纹，工具刷新后旧条目天然不可命中；这里主动清空
        // 以限制高频编辑工具配置时的内存驻留，并避免保留过期语义描述。
        cache.clear();
        return true;
    }

    return { getEntries, refreshEntries, scheduleRefresh, invalidate };
}

const defaultIndex = createMcpToolCatalogIndex();

module.exports = {
    ...defaultIndex
};
