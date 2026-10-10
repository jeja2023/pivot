'use strict';

const { query, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { parseEntityAliases } = require('./knowledge-graph-extraction');
const { mergeGraphClaims, upsertGraphClaimEvidence } = require('./knowledge-graph-facts');

const GRAPH_EXTRACTOR_VERSION = 'rule-heuristic-v1';

async function mergeKnowledgeGraphEntities({ userId, sourceEntityId, targetEntityId } = {}) {
    const sourceId = Number.parseInt(sourceEntityId, 10);
    const targetId = Number.parseInt(targetEntityId, 10);
    if (!Number.isSafeInteger(sourceId) || !Number.isSafeInteger(targetId) || sourceId <= 0 || targetId <= 0 || sourceId === targetId) return null;
    return await transaction(async trx => {
        const source = await trx.queryOne('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE', [sourceId, userId]);
        const target = await trx.queryOne('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE', [targetId, userId]);
        if (!source || !target) return null;
        const now = getBeijingTimestamp();
        const legacyRelations = await trx.query(`
            SELECT * FROM knowledge_relations
            WHERE user_id = ? AND (source_entity_id IN (?, ?) OR target_entity_id IN (?, ?))
        `, [userId, sourceId, targetId, sourceId, targetId]);
        const mentionRows = await trx.query('SELECT * FROM knowledge_entity_mentions WHERE entity_id IN (?, ?)', [sourceId, targetId]);
        await trx.execute(`
            UPDATE knowledge_entity_mentions SET entity_id = ?
            WHERE entity_id = ? AND NOT EXISTS (
                SELECT 1 FROM knowledge_entity_mentions m2
                WHERE m2.entity_id = ? AND m2.chunk_id = knowledge_entity_mentions.chunk_id
            )
        `, [targetId, sourceId, targetId]);
        await trx.execute('DELETE FROM knowledge_entity_mentions WHERE entity_id = ?', [sourceId]);
        await trx.execute(`
            UPDATE knowledge_relations SET source_entity_id = ?, updated_at = ?
            WHERE source_entity_id = ? AND NOT EXISTS (
                SELECT 1 FROM knowledge_relations r2
                WHERE r2.source_entity_id = ? AND r2.target_entity_id = knowledge_relations.target_entity_id
                  AND r2.relation_type = knowledge_relations.relation_type
                  AND COALESCE(r2.source_chunk_id, 0) = COALESCE(knowledge_relations.source_chunk_id, 0)
            )
        `, [targetId, now, sourceId, targetId]);
        await trx.execute('DELETE FROM knowledge_relations WHERE source_entity_id = ?', [sourceId]);
        await trx.execute(`
            UPDATE knowledge_relations SET target_entity_id = ?, updated_at = ?
            WHERE target_entity_id = ? AND NOT EXISTS (
                SELECT 1 FROM knowledge_relations r2
                WHERE r2.source_entity_id = knowledge_relations.source_entity_id AND r2.target_entity_id = ?
                  AND r2.relation_type = knowledge_relations.relation_type
                  AND COALESCE(r2.source_chunk_id, 0) = COALESCE(knowledge_relations.source_chunk_id, 0)
            )
        `, [targetId, now, sourceId, targetId]);
        await trx.execute('DELETE FROM knowledge_relations WHERE target_entity_id = ?', [sourceId]);
        await trx.execute('DELETE FROM knowledge_relations WHERE source_entity_id = target_entity_id');
        await mergeGraphClaims({ userId, sourceEntityId: sourceId, targetEntityId: targetId }, {
            query: trx.query.bind(trx), queryOne: trx.queryOne.bind(trx), execute: trx.execute.bind(trx)
        });
        const aliases = new Set(parseEntityAliases(target.aliases));
        aliases.add(source.name);
        await trx.execute(`
            UPDATE knowledge_entities SET aliases = ?, origin = 'manual', frozen = TRUE, updated_at = ?, deleted_at = ?
            WHERE id = ? AND user_id = ?
        `, [JSON.stringify([...aliases].slice(0, 20)), now, now, sourceId, userId]);
        await trx.execute(`UPDATE knowledge_entities SET origin = 'manual', frozen = TRUE, updated_at = ? WHERE id = ? AND user_id = ?`, [now, targetId, userId]);
        await trx.execute(`
            INSERT INTO knowledge_graph_merge_audits (user_id, source_entity_id, target_entity_id, payload_json, created_at)
            VALUES (?, ?, ?, ?::jsonb, ?)
        `, [userId, sourceId, targetId, JSON.stringify({ source, target, mentions: mentionRows, relations: legacyRelations }), now]);
        return { sourceId, targetId };
    });
}

async function revertKnowledgeGraphEntityMerge({ userId, auditId } = {}) {
    const safeAuditId = Number.parseInt(auditId, 10);
    if (!Number.isSafeInteger(safeAuditId) || safeAuditId <= 0) return null;
    const restored = await transaction(async trx => {
        const audit = await trx.queryOne(`
            SELECT * FROM knowledge_graph_merge_audits
            WHERE id = ? AND user_id = ? AND reverted_at IS NULL FOR UPDATE
        `, [safeAuditId, userId]);
        let payload = null;
        try { payload = typeof audit?.payload_json === 'object' ? audit.payload_json : JSON.parse(audit?.payload_json || '{}'); } catch (_) {}
        if (!audit || !payload?.source || !payload?.target) return null;
        const { source, target } = payload;
        const now = getBeijingTimestamp();
        await trx.execute(`
            UPDATE knowledge_entities
            SET name = ?, normalized_name = ?, type = ?, description = ?, aliases = ?::jsonb,
                confidence = ?, source_doc_id = ?, origin = ?, frozen = ?, evidence_count = ?,
                last_evidence_at = ?, deleted_at = NULL, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [source.name, source.normalized_name, source.type, source.description || '', JSON.stringify(parseEntityAliases(source.aliases)),
            source.confidence, source.source_doc_id, source.origin || 'auto', Boolean(source.frozen), source.evidence_count || 0,
            source.last_evidence_at || null, now, source.id, userId]);
        await trx.execute(`UPDATE knowledge_entities SET aliases = ?::jsonb, origin = ?, frozen = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
            JSON.stringify(parseEntityAliases(target.aliases)), target.origin || 'auto', Boolean(target.frozen), now, target.id, userId
        ]);
        await trx.execute('DELETE FROM knowledge_entity_mentions WHERE entity_id IN (?, ?)', [source.id, target.id]);
        for (const mention of Array.isArray(payload.mentions) ? payload.mentions : []) {
            await trx.execute(`
                INSERT INTO knowledge_entity_mentions (user_id, entity_id, doc_id, chunk_id, snippet, source_state, extractor_version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(entity_id, chunk_id) DO NOTHING
            `, [mention.user_id, mention.entity_id, mention.doc_id, mention.chunk_id, mention.snippet || '', mention.source_state || 'active',
                mention.extractor_version || GRAPH_EXTRACTOR_VERSION, mention.created_at || now, mention.updated_at || now]);
        }
        await trx.execute(`DELETE FROM knowledge_relations WHERE user_id = ? AND (source_entity_id IN (?, ?) OR target_entity_id IN (?, ?))`, [
            userId, source.id, target.id, source.id, target.id
        ]);
        for (const relation of Array.isArray(payload.relations) ? payload.relations : []) {
            await trx.execute(`
                INSERT INTO knowledge_relations (
                    user_id, source_entity_id, target_entity_id, relation_type, description, confidence, source_doc_id, source_chunk_id,
                    status, origin, frozen, source_state, evidence_count, last_evidence_at, extractor_version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, source_entity_id, target_entity_id, relation_type, source_chunk_id) DO NOTHING
            `, [relation.user_id, relation.source_entity_id, relation.target_entity_id, relation.relation_type, relation.description || '',
                relation.confidence, relation.source_doc_id, relation.source_chunk_id, relation.status || 'pending', relation.origin || 'rule',
                Boolean(relation.frozen), relation.source_state || 'active', relation.evidence_count || 0, relation.last_evidence_at || null,
                relation.extractor_version || GRAPH_EXTRACTOR_VERSION, relation.created_at || now, relation.updated_at || now]);
        }
        await trx.execute(`DELETE FROM knowledge_graph_claims WHERE user_id = ? AND (source_entity_id IN (?, ?) OR target_entity_id IN (?, ?))`, [
            userId, source.id, target.id, source.id, target.id
        ]);
        await trx.execute('UPDATE knowledge_graph_merge_audits SET reverted_at = ?, reverted_by = ? WHERE id = ?', [now, userId, audit.id]);
        return { sourceId: Number(source.id), targetId: Number(target.id), relations: Array.isArray(payload.relations) ? payload.relations.length : 0 };
    });
    if (!restored) return null;
    const relations = await query(`
        SELECT * FROM knowledge_relations WHERE user_id = ? AND (source_entity_id IN (?, ?) OR target_entity_id IN (?, ?))
    `, [userId, restored.sourceId, restored.targetId, restored.sourceId, restored.targetId]);
    for (const relation of relations) {
        await upsertGraphClaimEvidence({
            userId, sourceEntityId: relation.source_entity_id, targetEntityId: relation.target_entity_id,
            relationType: relation.relation_type, description: relation.description, confidence: relation.confidence,
            origin: relation.origin || 'rule', legacyRelationId: relation.id, sourceDocId: relation.source_doc_id,
            sourceChunkId: relation.source_chunk_id, snippet: relation.description,
            extractionMethod: relation.origin === 'manual' ? 'manual' : 'rule_heuristic',
            extractorVersion: relation.extractor_version || GRAPH_EXTRACTOR_VERSION
        });
    }
    return restored;
}

async function listKnowledgeGraphMergeAudits({ userId, limit = 50 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const rows = await query(`
        SELECT id, source_entity_id, target_entity_id, payload_json, reverted_at, reverted_by, created_at
        FROM knowledge_graph_merge_audits WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `, [userId, safeLimit]);
    return rows.map(row => {
        let payload = {};
        try { payload = typeof row.payload_json === 'object' ? row.payload_json : JSON.parse(row.payload_json || '{}'); } catch (_) {}
        return {
            id: Number(row.id), sourceEntityId: Number(row.source_entity_id), targetEntityId: Number(row.target_entity_id),
            sourceName: payload?.source?.name || '', targetName: payload?.target?.name || '',
            revertedAt: row.reverted_at || null, revertedBy: row.reverted_by || null, createdAt: row.created_at
        };
    });
}

module.exports = {
    listKnowledgeGraphMergeAudits,
    mergeKnowledgeGraphEntities,
    revertKnowledgeGraphEntityMerge
};
