const crypto = require('crypto');
const { query, execute } = require('../db/client');
const knowledgeRepository = require('../repositories/knowledge');
const { buildDocumentAccessFilter } = require('./knowledge-access');
const { generateEmbeddingsAdaptive } = require('./rag-index/embedding-client');
const { getEmbeddingConfig } = require('./rag-config');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');

const MAX_CATALOG_ENTRIES = 500;
const MAX_VECTOR_DIMENSIONS = 8192;

function normalizeCollectionId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeTags(value, max = 20) {
    const values = Array.isArray(value) ? value : [];
    return [...new Set(values
        .map(item => String(item || '').trim().replace(/\s+/g, ' ').slice(0, 40))
        .filter(Boolean))]
        .slice(0, max);
}

function parseJsonArray(value, max = MAX_VECTOR_DIMENSIONS) {
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch (_) { parsed = []; }
    }
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > max) return [];
    return parsed.map(Number).every(Number.isFinite) ? parsed.map(Number) : [];
}

function parseJsonStringArray(value, max = 20) {
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch (_) { parsed = []; }
    }
    return normalizeTags(Array.isArray(parsed) ? parsed : [], max);
}

function embeddingKeyForConfig(config = {}) {
    const http = config.http || config.cloud || {};
    const digest = crypto.createHash('sha256').update(JSON.stringify({
        mode: String(config.mode || ''),
        url: String(http.url || ''),
        model: String(http.model || '')
    })).digest('hex');
    return `emb:${digest}`;
}

function sourceVersionForCollection(collection = {}, tags = []) {
    return crypto.createHash('sha256').update(JSON.stringify({
        id: normalizeCollectionId(collection.id),
        name: String(collection.name || ''),
        description: String(collection.description || ''),
        tags: normalizeTags(tags),
        docCount: Number(collection.doc_count || 0),
        readyCount: Number(collection.ready_count || 0),
        chunkCount: Number(collection.chunk_count || 0),
        updatedAt: String(collection.updated_at || '')
    })).digest('hex');
}

function buildSemanticSummary(collection = {}, tags = []) {
    return [
        `知识库：${String(collection.name || '').trim()}`,
        String(collection.description || '').trim(),
        normalizeTags(tags).length ? `主题：${normalizeTags(tags).join('、')}` : '',
        Number(collection.ready_count || 0) > 0 ? `已就绪文档：${Number(collection.ready_count || 0)}` : ''
    ].filter(Boolean).join('\n').slice(0, 1600);
}

function createKnowledgeCatalogIndex(deps = {}) {
    const queryFn = deps.query || query;
    const executeFn = deps.execute || execute;
    const listCollections = deps.listCollections || (user => knowledgeRepository.listCollections(user));
    const generateEmbeddings = deps.generateEmbeddingsAdaptive || generateEmbeddingsAdaptive;
    const getConfig = deps.getEmbeddingConfig || getEmbeddingConfig;
    const now = deps.getBeijingTimestamp || getBeijingTimestamp;
    const cache = new Map();
    const inFlight = new Map();

    async function listCollectionTags(collectionIds, user) {
        const ids = [...new Set((collectionIds || []).map(normalizeCollectionId).filter(Boolean))].slice(0, MAX_CATALOG_ENTRIES);
        if (!ids.length) return new Map();
        const access = buildDocumentAccessFilter(user, 'd', 'c');
        const rows = await queryFn(`
            SELECT d.collection_id, t.tag
            FROM knowledge_doc_tags t
            JOIN knowledge_docs d ON d.id = t.doc_id AND d.user_id = t.user_id
            LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
            WHERE d.deleted_at IS NULL
              AND d.collection_id IN (${ids.map(() => '?').join(', ')})
              AND ${access.sql}
            GROUP BY d.collection_id, t.tag
            ORDER BY d.collection_id ASC, t.tag ASC
        `, [...ids, ...access.params]).catch(error => {
            logger.warn({ err: error.message }, '加载知识库目录标签失败，继续使用集合名称与描述路由');
            return [];
        });
        const grouped = new Map();
        for (const row of rows || []) {
            const collectionId = normalizeCollectionId(row.collection_id);
            const tag = String(row.tag || '').trim();
            if (!collectionId || !tag) continue;
            const values = grouped.get(collectionId) || [];
            values.push(tag);
            grouped.set(collectionId, values);
        }
        for (const [id, tags] of grouped) grouped.set(id, normalizeTags(tags));
        return grouped;
    }

    async function loadVisibleSources(user) {
        const collections = (await listCollections(user) || []).slice(0, MAX_CATALOG_ENTRIES);
        const tagMap = await listCollectionTags(collections.map(collection => collection.id), user);
        return collections.map(collection => {
            const collectionId = normalizeCollectionId(collection.id);
            const domainTags = tagMap.get(collectionId) || [];
            return {
                collectionId,
                userId: Number(collection.user_id || 0) || null,
                name: String(collection.name || '').trim(),
                description: String(collection.description || '').trim(),
                documentCount: Number(collection.doc_count || 0),
                readyDocumentCount: Number(collection.ready_count || 0),
                chunkCount: Number(collection.chunk_count || 0),
                domainTags,
                semanticSummary: buildSemanticSummary(collection, domainTags),
                sourceVersion: sourceVersionForCollection(collection, domainTags),
                sourceUpdatedAt: String(collection.updated_at || '')
            };
        }).filter(entry => entry.collectionId && entry.name && entry.readyDocumentCount > 0 && entry.chunkCount > 0);
    }

    async function loadStoredVectors(sources, embeddingKey) {
        const ids = sources.map(source => source.collectionId).filter(Boolean);
        if (!ids.length) return new Map();
        const rows = await queryFn(`
            SELECT collection_id, semantic_summary, domain_tags, embedding_vector,
                   embedding_dimensions, source_version, updated_at
            FROM knowledge_collection_catalog
            WHERE embedding_key = ?
              AND collection_id IN (${ids.map(() => '?').join(', ')})
        `, [embeddingKey, ...ids]).catch(error => {
            logger.warn({ err: error.message }, '读取知识库目录向量失败，将使用内存或词法路由');
            return [];
        });
        const stored = new Map();
        for (const row of rows || []) {
            const collectionId = normalizeCollectionId(row.collection_id);
            const vector = parseJsonArray(row.embedding_vector);
            if (!collectionId || !vector.length) continue;
            stored.set(collectionId, {
                vector,
                sourceVersion: String(row.source_version || ''),
                semanticSummary: String(row.semantic_summary || ''),
                domainTags: parseJsonStringArray(row.domain_tags, 20),
                updatedAt: String(row.updated_at || '')
            });
        }
        return stored;
    }

    async function getVisibleEntries({ user, embeddingConfig = null } = {}) {
        const config = embeddingConfig || getConfig(user?.id || null);
        const embeddingKey = embeddingKeyForConfig(config);
        const sources = await loadVisibleSources(user);
        const stored = await loadStoredVectors(sources, embeddingKey);
        return sources.map(source => {
            const cacheKey = `${source.collectionId}:${embeddingKey}`;
            const cached = cache.get(cacheKey);
            const persisted = stored.get(source.collectionId);
            const record = cached?.sourceVersion === source.sourceVersion
                ? cached
                : persisted?.sourceVersion === source.sourceVersion ? persisted : null;
            return {
                ...source,
                embeddingKey,
                vector: record?.vector || [],
                embeddingDimensions: Number(record?.vector?.length || 0),
                indexUpdatedAt: record?.updatedAt || ''
            };
        });
    }

    async function persistEntry(entry, vector) {
        const safeVector = parseJsonArray(vector);
        if (!safeVector.length) return null;
        const timestamp = now();
        await executeFn(`
            INSERT INTO knowledge_collection_catalog (
                collection_id, embedding_key, semantic_summary, domain_tags, embedding_vector,
                embedding_dimensions, source_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (collection_id, embedding_key) DO UPDATE SET
                semantic_summary = EXCLUDED.semantic_summary,
                domain_tags = EXCLUDED.domain_tags,
                embedding_vector = EXCLUDED.embedding_vector,
                embedding_dimensions = EXCLUDED.embedding_dimensions,
                source_version = EXCLUDED.source_version,
                updated_at = EXCLUDED.updated_at
        `, [
            entry.collectionId,
            entry.embeddingKey,
            entry.semanticSummary,
            JSON.stringify(entry.domainTags || []),
            JSON.stringify(safeVector),
            safeVector.length,
            entry.sourceVersion,
            timestamp,
            timestamp
        ]);
        const cached = { vector: safeVector, sourceVersion: entry.sourceVersion, updatedAt: timestamp };
        cache.set(`${entry.collectionId}:${entry.embeddingKey}`, cached);
        return cached;
    }

    async function refreshEntries(entries = [], { user, embeddingConfig = null, signal = null } = {}) {
        const config = embeddingConfig || getConfig(user?.id || null);
        const embeddingKey = embeddingKeyForConfig(config);
        if (!config?.http?.url) return [];
        const missing = entries
            .filter(entry => entry && entry.collectionId && !parseJsonArray(entry.vector).length)
            .map(entry => ({ ...entry, embeddingKey }))
            .slice(0, MAX_CATALOG_ENTRIES);
        if (!missing.length) return entries;
        const dedupeKey = `${embeddingKey}:${missing.map(entry => `${entry.collectionId}:${entry.sourceVersion}`).join('|')}`;
        if (inFlight.has(dedupeKey)) return await inFlight.get(dedupeKey);
        const refresh = (async () => {
            const vectors = await generateEmbeddings(
                missing.map(entry => entry.semanticSummary),
                null,
                config.http,
                user?.id || null,
                { source: 'chat_route_catalog', allowPartial: true, signal }
            );
            const refreshed = new Map();
            for (let index = 0; index < missing.length; index += 1) {
                const vector = parseJsonArray(vectors[index]);
                if (!vector.length) continue;
                try {
                    const saved = await persistEntry(missing[index], vector);
                    if (saved) refreshed.set(missing[index].collectionId, saved);
                } catch (error) {
                    logger.warn({ err: error.message, collectionId: missing[index].collectionId }, '保存知识库目录向量失败，已保留本轮内存索引');
                    const saved = { vector, sourceVersion: missing[index].sourceVersion, updatedAt: now() };
                    cache.set(`${missing[index].collectionId}:${embeddingKey}`, saved);
                    refreshed.set(missing[index].collectionId, saved);
                }
            }
            return entries.map(entry => {
                const saved = refreshed.get(entry.collectionId);
                return saved ? { ...entry, vector: saved.vector, embeddingDimensions: saved.vector.length, indexUpdatedAt: saved.updatedAt } : entry;
            });
        })().finally(() => inFlight.delete(dedupeKey));
        inFlight.set(dedupeKey, refresh);
        return await refresh;
    }

    function scheduleRefresh(entries = [], options = {}) {
        const work = () => refreshEntries(entries, options).catch(error => {
            logger.warn({ err: error.message }, '知识库目录后台刷新失败，将在后续请求重试');
        });
        setImmediate(work);
    }

    function invalidateCollection(collectionId) {
        const normalized = normalizeCollectionId(collectionId);
        if (!normalized) return false;
        for (const key of cache.keys()) {
            if (key.startsWith(`${normalized}:`)) cache.delete(key);
        }
        return true;
    }

    return {
        embeddingKeyForConfig,
        getVisibleEntries,
        invalidateCollection,
        loadVisibleSources,
        refreshEntries,
        scheduleRefresh
    };
}

const defaultIndex = createKnowledgeCatalogIndex();

module.exports = {
    ...defaultIndex
};
