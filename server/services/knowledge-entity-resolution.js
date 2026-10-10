'use strict';

const { query, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { cleanEntityName, normalizeEntityName, parseEntityAliases } = require('./knowledge-graph-extraction');

function normalizeVector(value) {
    let vector = value;
    if (typeof vector === 'string') {
        try { vector = JSON.parse(vector); } catch (_) {
            vector = String(vector).replace(/^\[|\]$/g, '').split(',').map(Number);
        }
    }
    if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) return null;
    const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
    return norm > 0 ? { vector, norm } : null;
}

function cosineSimilarity(left, right) {
    if (!left || !right || left.vector.length !== right.vector.length) return 0;
    let dot = 0;
    for (let index = 0; index < left.vector.length; index += 1) dot += left.vector[index] * right.vector[index];
    return dot / (left.norm * right.norm);
}

function bigrams(value = '') {
    const text = normalizeEntityName(value);
    if (!text) return new Set();
    if (text.length < 3) return new Set([text]);
    const result = new Set();
    for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
    return result;
}

function nameSimilarity(left, right) {
    const a = bigrams(left), b = bigrams(right);
    if (!a.size || !b.size) return 0;
    let shared = 0;
    a.forEach(item => { if (b.has(item)) shared += 1; });
    return (2 * shared) / (a.size + b.size);
}

async function syncKnowledgeEntityAliases(entity, deps = {}) {
    if (!entity?.id || !entity?.user_id) return [];
    const exec = deps.execute || execute;
    const aliases = [...new Set([entity.name, ...parseEntityAliases(entity.aliases)])]
        .map(cleanEntityName).filter(Boolean).slice(0, 21);
    const now = getBeijingTimestamp();
    for (const alias of aliases) {
        const normalized = normalizeEntityName(alias);
        if (!normalized) continue;
        await exec(`
            INSERT INTO knowledge_entity_aliases (
                user_id, entity_id, alias, normalized_alias, source_kind, confidence, approved_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (user_id, normalized_alias) DO UPDATE
            SET entity_id = CASE WHEN EXCLUDED.source_kind = 'manual' THEN EXCLUDED.entity_id ELSE knowledge_entity_aliases.entity_id END,
                alias = CASE WHEN EXCLUDED.source_kind = 'manual' OR knowledge_entity_aliases.entity_id = EXCLUDED.entity_id THEN EXCLUDED.alias ELSE knowledge_entity_aliases.alias END,
                source_kind = CASE WHEN EXCLUDED.source_kind = 'manual' OR knowledge_entity_aliases.entity_id = EXCLUDED.entity_id THEN EXCLUDED.source_kind ELSE knowledge_entity_aliases.source_kind END,
                confidence = CASE WHEN EXCLUDED.source_kind = 'manual' OR knowledge_entity_aliases.entity_id = EXCLUDED.entity_id THEN GREATEST(knowledge_entity_aliases.confidence, EXCLUDED.confidence) ELSE knowledge_entity_aliases.confidence END,
                approved_at = CASE WHEN EXCLUDED.source_kind = 'manual' OR knowledge_entity_aliases.entity_id = EXCLUDED.entity_id THEN EXCLUDED.approved_at ELSE knowledge_entity_aliases.approved_at END,
                updated_at = EXCLUDED.updated_at
        `, [entity.user_id, entity.id, alias, normalized, entity.origin === 'manual' ? 'manual' : 'auto',
            Number(entity.confidence || 0.7), entity.origin === 'manual' ? now : null, now, now]);
    }
    return aliases;
}

async function scoreKnowledgeEntityResolutionCandidates(rows = [], { limit = 20 } = {}, deps = {}) {
    const data = Array.isArray(rows) ? rows : [];
    if (data.length < 2) return [];
    const ids = data.map(row => Number(row.id)).filter(Number.isSafeInteger).slice(0, 250);
    const embeddings = new Map();
    if (ids.length) {
        const vectors = await (deps.query || query)(`
            SELECT mention.entity_id, chunk.embedding::text AS embedding
            FROM knowledge_entity_mentions mention
            JOIN knowledge_chunks chunk ON chunk.id = mention.chunk_id
            WHERE mention.entity_id IN (${ids.map(() => '?').join(',')})
              AND COALESCE(mention.source_state, 'active') = 'active'
              AND chunk.embedding IS NOT NULL
            ORDER BY mention.entity_id, chunk.id DESC
        `, ids).catch(() => []);
        for (const row of vectors) {
            if (embeddings.has(Number(row.entity_id))) continue;
            const vector = normalizeVector(row.embedding);
            if (vector) embeddings.set(Number(row.entity_id), vector);
        }
    }
    const candidates = [];
    for (let leftIndex = 0; leftIndex < data.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < data.length; rightIndex += 1) {
            const left = data[leftIndex];
            const right = data[rightIndex];
            if ((left.type || 'concept') !== (right.type || 'concept')) continue;
            const leftNames = [left.name, ...parseEntityAliases(left.aliases)];
            const rightNames = [right.name, ...parseEntityAliases(right.aliases)];
            let lexical = 0;
            for (const a of leftNames) for (const b of rightNames) lexical = Math.max(lexical, nameSimilarity(a, b));
            const semantic = cosineSimilarity(embeddings.get(Number(left.id)), embeddings.get(Number(right.id)));
            if (lexical < 0.6 && semantic < 0.86) continue;
            const score = Math.min(1, lexical * 0.45 + semantic * 0.55);
            candidates.push({
                entities: [left, right], lexicalSimilarity: Number(lexical.toFixed(3)), semanticSimilarity: Number(semantic.toFixed(3)),
                similarity: Number(score.toFixed(3)),
                reason: semantic >= 0.86 ? '名称/别名与来源分块向量均相近' : '名称或别名 n-gram 相似度较高',
                suggestedTargetId: [left, right].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0].id
            });
        }
    }
    return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
}

module.exports = {
    scoreKnowledgeEntityResolutionCandidates,
    syncKnowledgeEntityAliases
};
