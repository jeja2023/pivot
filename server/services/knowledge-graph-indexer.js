'use strict';

// 图谱索引的写路径独立于查询/治理服务。每份文档最多以三类批量 SQL 写入
// 实体、mention 和关系，避免逐实体/逐关系往返放大索引时延。
const { query, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { detectDocType } = require('./rag-chunker');
const { extractKnowledgeGraph, normalizeEntityName, relationStatusForConfidence } = require('./knowledge-graph-extraction');
const { normalizeGraphRelationType } = require('./knowledge-graph-ontology');
const { syncKnowledgeEntityAliases } = require('./knowledge-entity-resolution');
const { upsertGraphClaimEvidence } = require('./knowledge-graph-facts');
const knowledgeRepository = require('../repositories/knowledge');

const EXTRACTOR_VERSION = 'rule-heuristic-v1';

function entityKey(name) {
    return normalizeEntityName(name);
}

async function bulkUpsertEntities(entities, { userId, docId }, deps = {}) {
    if (!entities.length) return [];
    const now = getBeijingTimestamp();
    const runner = deps.query || query;
    const rows = await runner(`
        INSERT INTO knowledge_entities (
            user_id, name, normalized_name, type, description, confidence, source_doc_id,
            origin, evidence_count, last_evidence_at, created_at, updated_at
        ) VALUES ${entities.map(() => '(?, ?, ?, ?, ?, ?, ?, \'auto\', 0, ?, ?, ?)').join(', ')}
        ON CONFLICT(user_id, normalized_name) DO UPDATE SET
            name = CASE WHEN knowledge_entities.frozen THEN knowledge_entities.name
                WHEN LENGTH(EXCLUDED.name) > LENGTH(knowledge_entities.name) THEN EXCLUDED.name ELSE knowledge_entities.name END,
            type = CASE WHEN knowledge_entities.frozen THEN knowledge_entities.type
                WHEN knowledge_entities.type = 'concept' THEN EXCLUDED.type ELSE knowledge_entities.type END,
            confidence = CASE WHEN knowledge_entities.frozen THEN knowledge_entities.confidence
                ELSE GREATEST(knowledge_entities.confidence, EXCLUDED.confidence) END,
            origin = CASE WHEN knowledge_entities.origin = 'manual' THEN 'manual' ELSE EXCLUDED.origin END,
            updated_at = EXCLUDED.updated_at, deleted_at = NULL
        RETURNING *
    `, entities.flatMap(entity => [
        userId, entity.name, entity.normalizedName, entity.type, '', entity.confidence, docId, now, now, now
    ]));
    for (const row of rows) await syncKnowledgeEntityAliases(row, deps);
    return rows;
}

async function bulkRecordMentions(mentions, deps = {}) {
    if (!mentions.length) return 0;
    const now = getBeijingTimestamp();
    const exec = deps.execute || execute;
    return await exec(`
        INSERT INTO knowledge_entity_mentions (
            user_id, entity_id, doc_id, chunk_id, snippet, source_state, extractor_version, created_at, updated_at
        ) VALUES ${mentions.map(() => '(?, ?, ?, ?, ?, \'active\', ?, ?, ?)').join(', ')}
        ON CONFLICT(entity_id, chunk_id) DO UPDATE
        SET doc_id = EXCLUDED.doc_id, snippet = EXCLUDED.snippet, source_state = 'active',
            extractor_version = EXCLUDED.extractor_version, updated_at = EXCLUDED.updated_at
    `, mentions.flatMap(mention => [
        mention.userId, mention.entityId, mention.docId, mention.chunkId, mention.snippet.slice(0, 500), EXTRACTOR_VERSION, now, now
    ]));
}

async function bulkUpsertRelations(relations, deps = {}) {
    if (!relations.length) return [];
    const now = getBeijingTimestamp();
    const runner = deps.query || query;
    return await runner(`
        INSERT INTO knowledge_relations (
            user_id, source_entity_id, target_entity_id, relation_type, description, confidence,
            source_doc_id, source_chunk_id, status, origin, source_state, extractor_version,
            last_evidence_at, created_at, updated_at
        ) VALUES ${relations.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'active\', ?, ?, ?, ?)').join(', ')}
        ON CONFLICT(user_id, source_entity_id, target_entity_id, relation_type, source_chunk_id) DO UPDATE SET
            description = CASE WHEN knowledge_relations.frozen OR EXCLUDED.description = ''
                THEN knowledge_relations.description ELSE EXCLUDED.description END,
            confidence = CASE WHEN knowledge_relations.frozen THEN knowledge_relations.confidence
                ELSE GREATEST(knowledge_relations.confidence, EXCLUDED.confidence) END,
            origin = CASE WHEN knowledge_relations.origin = 'manual' THEN 'manual' ELSE EXCLUDED.origin END,
            source_state = 'active', extractor_version = EXCLUDED.extractor_version,
            last_evidence_at = EXCLUDED.last_evidence_at,
            status = CASE WHEN knowledge_relations.status = 'deleted' THEN EXCLUDED.status
                WHEN knowledge_relations.status = 'active' THEN 'active' ELSE EXCLUDED.status END,
            updated_at = EXCLUDED.updated_at
        RETURNING *
    `, relations.flatMap(relation => [
        relation.userId, relation.sourceEntityId, relation.targetEntityId, relation.relationType, relation.description,
        relation.confidence, relation.docId, relation.chunkId, relationStatusForConfidence(relation.confidence), relation.origin,
        EXTRACTOR_VERSION, now, now, now
    ]));
}

async function indexKnowledgeGraphBatch({ userId, docId, chunks = [] } = {}, deps = {}) {
    if (!userId || !docId || !Array.isArray(chunks) || !chunks.length) return { entities: 0, relations: 0 };
    const doc = await (deps.getDocumentName || knowledgeRepository.getDocumentName)(docId);
    const docType = detectDocType(doc?.name || '', chunks.slice(0, 24).map(chunk => chunk.content).join('\n'));
    const uniqueEntities = new Map();
    const extractedChunks = chunks.map(chunk => {
        const graph = extractKnowledgeGraph(chunk.content, docType);
        graph.entities.forEach(entity => {
            const key = entityKey(entity.name);
            const current = uniqueEntities.get(key);
            if (!current || Number(entity.confidence) > Number(current.confidence)) uniqueEntities.set(key, { ...entity, normalizedName: key });
        });
        return { chunk, graph };
    });
    const entityRows = await bulkUpsertEntities([...uniqueEntities.values()], { userId, docId }, deps);
    const entityByName = new Map(entityRows.map(row => [entityKey(row.name), row]));
    const mentions = [];
    const relations = [];
    for (const { chunk, graph } of extractedChunks) {
        graph.entities.forEach(entity => {
            const row = entityByName.get(entityKey(entity.name));
            if (row) mentions.push({ userId, entityId: row.id, docId, chunkId: chunk.chunkId, snippet: chunk.content });
        });
        graph.relations.forEach(relation => {
            const source = entityByName.get(entityKey(relation.sourceName));
            const target = entityByName.get(entityKey(relation.targetName));
            if (!source || !target || Number(source.id) === Number(target.id)) return;
            relations.push({
                userId, sourceEntityId: source.id, targetEntityId: target.id,
                relationType: normalizeGraphRelationType(relation.relationType, { docType }), description: relation.description,
                confidence: relation.confidence, docId, chunkId: chunk.chunkId,
                origin: relation.relationType === 'related_to' ? 'heuristic' : 'rule', snippet: chunk.content,
                locator: {
                    headingPath: chunk.headingPath || '', chunkIndex: Number(chunk.chunkIndex || 0),
                    charStart: chunk.charStart ?? null, charEnd: chunk.charEnd ?? null
                }
            });
        });
    }
    await bulkRecordMentions(mentions, deps);
    const relationRows = await bulkUpsertRelations(relations, deps);
    const sourceByKey = new Map(relations.map(relation => [`${relation.sourceEntityId}:${relation.targetEntityId}:${relation.relationType}:${relation.chunkId}`, relation]));
    for (const row of relationRows) {
        const source = sourceByKey.get(`${row.source_entity_id}:${row.target_entity_id}:${row.relation_type}:${row.source_chunk_id}`);
        if (!source) continue;
        const claim = await upsertGraphClaimEvidence({
            userId, sourceEntityId: row.source_entity_id, targetEntityId: row.target_entity_id,
            relationType: row.relation_type, description: row.description, confidence: row.confidence,
            origin: source.origin, legacyRelationId: row.id, sourceDocId: docId, sourceChunkId: row.source_chunk_id,
            snippet: source.snippet, locator: source.locator, extractionMethod: source.origin === 'heuristic' ? 'co_occurrence' : 'rule_heuristic',
            extractorVersion: EXTRACTOR_VERSION
        }, deps);
        if (claim) await (deps.execute || execute)(`
            UPDATE knowledge_relations SET evidence_count = ?, last_evidence_at = ? WHERE id = ?
        `, [Number(claim.evidence_count || 0), claim.last_evidence_at || null, row.id]);
    }
    return { entities: mentions.length, relations: relations.length };
}

module.exports = { indexKnowledgeGraphBatch };
