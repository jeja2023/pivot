const { query, queryOne, execute, transaction } = require('../db/client');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { buildRagSearchTerms } = require('./rag-tokenizer');
const knowledgeRepository = require('../repositories/knowledge');
const { isSuperAdmin } = require('../permissions');
const { normalizeKnowledgeUser } = require('./knowledge-access');
const { normalizeGraphRelationType } = require('./knowledge-graph-ontology');
const {
    invalidateGraphClaimEvidenceForDocument,
    rejectGraphClaimEvidenceByRelation,
    setGraphClaimManualReview,
    upsertGraphClaimEvidence
} = require('./knowledge-graph-facts');
const {
    listKnowledgeGraphMergeAudits,
    mergeKnowledgeGraphEntities,
    revertKnowledgeGraphEntityMerge
} = require('./knowledge-graph-merge');
const {
    scoreKnowledgeEntityResolutionCandidates,
    syncKnowledgeEntityAliases
} = require('./knowledge-entity-resolution');
const { indexKnowledgeGraphBatch } = require('./knowledge-graph-indexer');

const GRAPH_CONTEXT_ENTITY_LIMIT = 6;
const GRAPH_CONTEXT_RELATION_LIMIT = 12;
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const GRAPH_EXTRACTION_MODE = 'rule_heuristic';
const GRAPH_EXTRACTOR_VERSION = 'rule-heuristic-v1';
const GRAPH_QUALITY_NOTICE = '知识图谱由规则和启发式抽取生成，适合作为 Graph-RAG 辅助线索；生产问答前建议确认低可信关系、合并重复实体，并结合来源文档校验。';

function buildGraphEntityAccessFilter(userOrId, alias = 'e') {
    const user = normalizeKnowledgeUser(userOrId);
    if (isSuperAdmin(userOrId)) return { sql: '1 = 1', params: [] };
    return {
        sql: `${alias}.user_id = ?`,
        params: [user.id]
    };
}

function buildGraphRelationAccessFilter(userOrId, alias = 'r') {
    const user = normalizeKnowledgeUser(userOrId);
    if (isSuperAdmin(userOrId)) return { sql: '1 = 1', params: [] };
    return {
        sql: `${alias}.user_id = ?`,
        params: [user.id]
    };
}

function buildGraphMentionAccessFilter(userOrId, alias = 'm') {
    const user = normalizeKnowledgeUser(userOrId);
    if (isSuperAdmin(userOrId)) return { sql: '1 = 1', params: [] };
    return {
        sql: `${alias}.user_id = ?`,
        params: [user.id]
    };
}

function buildGraphDocumentAccessFilter(userOrId, alias = 'd') {
    const user = normalizeKnowledgeUser(userOrId);
    if (isSuperAdmin(userOrId)) return { sql: '1 = 1', params: [] };
    return {
        sql: `${alias}.user_id = ?`,
        params: [user.id]
    };
}

function graphDocumentReadySql(alias = 'd') {
    return `${alias}.deleted_at IS NULL
        AND COALESCE(${alias}.is_enabled, 1) = 1
        AND ${alias}.status IN ('ready', 'lexical_ready')
        AND COALESCE(${alias}.lifecycle_status, 'published') NOT IN ('expired', 'archived')`;
}

function graphRelationEvidenceReadySql(relationAlias = 'r', docAlias = 'd') {
    return `COALESCE(${relationAlias}.source_state, 'active') = 'active'
        AND ${relationAlias}.source_doc_id IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM knowledge_docs ${docAlias}
            WHERE ${docAlias}.id = ${relationAlias}.source_doc_id
              AND ${graphDocumentReadySql(docAlias)}
        )`;
}

function graphEntityEvidenceReadySql(entityAlias = 'e', mentionAlias = 'm', docAlias = 'd') {
    return `EXISTS (
        SELECT 1 FROM knowledge_entity_mentions ${mentionAlias}
        JOIN knowledge_docs ${docAlias} ON ${docAlias}.id = ${mentionAlias}.doc_id
        WHERE ${mentionAlias}.entity_id = ${entityAlias}.id
          AND COALESCE(${mentionAlias}.source_state, 'active') = 'active'
          AND ${graphDocumentReadySql(docAlias)}
    )`;
}

function normalizeGraphScopeIds(value, max = 50) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isSafeInteger(item) && item > 0))]
        .slice(0, max);
}

function normalizeGraphScopeTags(value, max = 20) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .flatMap(item => String(item || '').split(/[,，;；\s\n]+/))
        .map(item => item.trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 40))
        .filter(Boolean))]
        .slice(0, max);
}

function normalizeGraphScope(scope = {}) {
    const raw = scope && typeof scope === 'object' ? scope : {};
    return {
        docIds: normalizeGraphScopeIds(raw.docIds ?? raw.docId),
        collectionIds: normalizeGraphScopeIds(raw.collectionIds ?? raw.collectionId),
        tagNames: normalizeGraphScopeTags(raw.tagNames ?? raw.tagName ?? raw.tag)
    };
}

function buildGraphDocScopeClauses(normalized, docAlias, ownerExpression = 'e.user_id') {
    const clauses = [`${docAlias}.user_id = ${ownerExpression}`, `${docAlias}.deleted_at IS NULL`];
    const params = [];
    if (normalized.docIds.length) {
        clauses.push(`${docAlias}.id IN (${normalized.docIds.map(() => '?').join(',')})`);
        params.push(...normalized.docIds);
    }
    if (normalized.collectionIds.length) {
        clauses.push(`${docAlias}.collection_id IN (${normalized.collectionIds.map(() => '?').join(',')})`);
        params.push(...normalized.collectionIds);
    }
    if (normalized.tagNames.length) {
        clauses.push(`EXISTS (
            SELECT 1
            FROM knowledge_doc_tags tag_scope
            WHERE tag_scope.doc_id = ${docAlias}.id
              AND tag_scope.user_id = ${docAlias}.user_id
              AND tag_scope.tag IN (${normalized.tagNames.map(() => '?').join(',')})
        )`);
        params.push(...normalized.tagNames);
    }
    return { clauses, params };
}

function buildGraphEntityScopeSql(scope) {
    const normalized = normalizeGraphScope(scope);
    if (!normalized.docIds.length && !normalized.collectionIds.length && !normalized.tagNames.length) return { sql: '', params: [] };
    const mentionDocScope = buildGraphDocScopeClauses(normalized, 'd_scope');
    const sourceDocScope = buildGraphDocScopeClauses(normalized, 'sd_scope');
    return {
        sql: ` AND (EXISTS (SELECT 1 FROM knowledge_entity_mentions m_scope JOIN knowledge_docs d_scope ON d_scope.id = m_scope.doc_id WHERE m_scope.entity_id = e.id AND COALESCE(m_scope.source_state, 'active') = 'active' AND ${graphDocumentReadySql('d_scope')} AND ${mentionDocScope.clauses.join(' AND ')}) OR EXISTS (SELECT 1 FROM knowledge_docs sd_scope WHERE sd_scope.id = e.source_doc_id AND ${graphDocumentReadySql('sd_scope')} AND ${sourceDocScope.clauses.join(' AND ')}))`,
        params: [...mentionDocScope.params, ...sourceDocScope.params]
    };
}

function buildGraphRelationScopeSql(scope, docAlias = 'd', relationAlias = 'r') {
    const normalized = normalizeGraphScope(scope);
    if (!normalized.docIds.length && !normalized.collectionIds.length && !normalized.tagNames.length) return { sql: '', params: [] };
    const scoped = buildGraphDocScopeClauses(normalized, docAlias, `${relationAlias}.user_id`);
    return { sql: ` AND ${scoped.clauses.join(' AND ')}`, params: scoped.params };
}

function buildGraphRelationRecordScopeSql(scope, relationAlias = 'r') {
    const normalized = normalizeGraphScope(scope);
    if (!normalized.docIds.length && !normalized.collectionIds.length && !normalized.tagNames.length) return { sql: '', params: [] };
    const scoped = buildGraphDocScopeClauses(normalized, 'd_scope', `${relationAlias}.user_id`);
    return { sql: ` AND EXISTS (SELECT 1 FROM knowledge_docs d_scope WHERE d_scope.id = ${relationAlias}.source_doc_id AND ${scoped.clauses.join(' AND ')})`, params: scoped.params };
}

function buildGraphMentionScopeSql(scope, mentionAlias = 'm') {
    const normalized = normalizeGraphScope(scope);
    if (!normalized.docIds.length && !normalized.collectionIds.length && !normalized.tagNames.length) return { sql: '', params: [] };
    const scoped = buildGraphDocScopeClauses(normalized, 'd_scope', `${mentionAlias}.user_id`);
    return { sql: ` AND EXISTS (SELECT 1 FROM knowledge_docs d_scope WHERE d_scope.id = ${mentionAlias}.doc_id AND ${scoped.clauses.join(' AND ')})`, params: scoped.params };
}

function hasGraphScope(scope) {
    const normalized = normalizeGraphScope(scope);
    return normalized.docIds.length > 0 || normalized.collectionIds.length > 0 || normalized.tagNames.length > 0;
}

const { buildAliasList, cleanEntityName, extractEntitiesFromText, extractKnowledgeGraph, extractRelationsFromText, normalizeEntityName, relationStatusForConfidence } = require('./knowledge-graph-extraction');
async function upsertEntity({ userId, name, type = 'concept', confidence = 0.7, sourceDocId = null, description = '', origin = 'auto' }, deps = {}) {
    const normalized = normalizeEntityName(name);
    if (!normalized) return null;
    const now = getBeijingTimestamp();
    const row = await (deps.queryOne || queryOne)(`
        INSERT INTO knowledge_entities (
            user_id, name, normalized_name, type, description, confidence, source_doc_id,
            origin, evidence_count, last_evidence_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(user_id, normalized_name) DO UPDATE SET
            name = CASE WHEN knowledge_entities.frozen THEN knowledge_entities.name
                WHEN LENGTH(EXCLUDED.name) > LENGTH(knowledge_entities.name) THEN EXCLUDED.name ELSE knowledge_entities.name END,
            type = CASE WHEN knowledge_entities.frozen THEN knowledge_entities.type
                WHEN knowledge_entities.type = 'concept' THEN EXCLUDED.type ELSE knowledge_entities.type END,
            confidence = CASE WHEN knowledge_entities.frozen THEN knowledge_entities.confidence
                ELSE GREATEST(knowledge_entities.confidence, EXCLUDED.confidence) END,
            origin = CASE WHEN knowledge_entities.origin = 'manual' THEN 'manual' ELSE EXCLUDED.origin END,
            updated_at = EXCLUDED.updated_at,
            deleted_at = NULL
        RETURNING *
    `, [userId, cleanEntityName(name), normalized, type, description, confidence, sourceDocId,
        String(origin || 'auto').slice(0, 40), now, now, now]);
    if (row) await syncKnowledgeEntityAliases(row, deps);
    return row;
}

async function _recordMention({ userId, entityId, docId, chunkId, snippet = '' }, deps = {}) {
    const now = getBeijingTimestamp();
    await (deps.execute || execute)(`
        INSERT INTO knowledge_entity_mentions (
            user_id, entity_id, doc_id, chunk_id, snippet, source_state, extractor_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(entity_id, chunk_id) DO UPDATE
        SET doc_id = EXCLUDED.doc_id, snippet = EXCLUDED.snippet, source_state = 'active',
            extractor_version = EXCLUDED.extractor_version, updated_at = EXCLUDED.updated_at
    `, [userId, entityId, docId, chunkId, String(snippet || '').slice(0, 500), GRAPH_EXTRACTOR_VERSION, now, now]);
}

async function _upsertRelation({
    userId, sourceEntityId, targetEntityId, relationType, description = '', confidence = 0.6,
    sourceDocId = null, sourceChunkId = null, origin = 'rule', snippet = '', locator = {}
}, deps = {}) {
    if (!sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId) return null;
    const now = getBeijingTimestamp();
    const normalizedRelationType = normalizeGraphRelationType(relationType);
    const status = relationStatusForConfidence(confidence);
    const row = await (deps.queryOne || queryOne)(`
        INSERT INTO knowledge_relations (
            user_id, source_entity_id, target_entity_id, relation_type, description,
            confidence, source_doc_id, source_chunk_id, status, origin, source_state,
            extractor_version, last_evidence_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
        ON CONFLICT(user_id, source_entity_id, target_entity_id, relation_type, source_chunk_id) DO UPDATE SET
            description = CASE WHEN knowledge_relations.frozen OR EXCLUDED.description = ''
                THEN knowledge_relations.description ELSE EXCLUDED.description END,
            confidence = CASE WHEN knowledge_relations.frozen THEN knowledge_relations.confidence
                ELSE GREATEST(knowledge_relations.confidence, EXCLUDED.confidence) END,
            origin = CASE WHEN knowledge_relations.origin = 'manual' THEN 'manual' ELSE EXCLUDED.origin END,
            source_state = 'active', extractor_version = EXCLUDED.extractor_version,
            last_evidence_at = EXCLUDED.last_evidence_at,
            status = CASE
                WHEN knowledge_relations.status = 'deleted' THEN EXCLUDED.status
                WHEN knowledge_relations.status = 'active' THEN 'active'
                ELSE EXCLUDED.status
            END,
            updated_at = EXCLUDED.updated_at
        RETURNING *
    `, [userId, sourceEntityId, targetEntityId, normalizedRelationType, description, confidence, sourceDocId, sourceChunkId,
        status, String(origin || 'rule').slice(0, 40), GRAPH_EXTRACTOR_VERSION, now, now, now]);
    if (!row) return null;
    const claim = await upsertGraphClaimEvidence({
        userId, sourceEntityId, targetEntityId, relationType: normalizedRelationType, description, confidence, origin,
        legacyRelationId: row.id, sourceDocId, sourceChunkId, snippet: snippet || description,
        locator, extractorVersion: GRAPH_EXTRACTOR_VERSION,
        extractionMethod: origin === 'heuristic' ? 'co_occurrence' : 'rule_heuristic'
    }, deps);
    if (claim) await (deps.execute || execute)(`
        UPDATE knowledge_relations SET evidence_count = ?, last_evidence_at = ? WHERE id = ?
    `, [Number(claim.evidence_count || 0), claim.last_evidence_at || null, row.id]);
    return row;
}

async function indexKnowledgeGraphForChunks({ userId, docId, chunks, deps = {} }) {
    const result = await indexKnowledgeGraphBatch({ userId, docId, chunks }, deps);
    await refreshGraphEntityEvidenceForDocument(docId, deps);
    return result;
}

async function clearKnowledgeGraphForDocument(docId, deps = {}) {
    const q = deps.query || query;
    const exec = deps.execute || execute;
    await invalidateKnowledgeGraphSources({ docId, reason: 'source_rebuilt' }, deps);
    const chunkRows = await q('SELECT id FROM knowledge_chunks WHERE doc_id = ?', [docId]);
    const chunkIds = (chunkRows || []).map(row => row.id);
    if (chunkIds.length === 0) return;
    const placeholders = chunkIds.map(() => '?').join(',');
    await exec(`DELETE FROM knowledge_relations WHERE source_chunk_id IN (${placeholders})`, chunkIds);
    await exec(`DELETE FROM knowledge_entity_mentions WHERE chunk_id IN (${placeholders})`, chunkIds);
}

async function refreshGraphEntityEvidenceForDocument(docId, deps = {}) {
    const safeDocId = Number.parseInt(docId, 10);
    if (!Number.isSafeInteger(safeDocId) || safeDocId <= 0) return { entities: 0 };
    const q = deps.query || query;
    const exec = deps.execute || execute;
    const rows = await q(`
        SELECT DISTINCT entity_id
        FROM knowledge_entity_mentions
        WHERE doc_id = ?
    `, [safeDocId]);
    for (const row of rows) {
        await exec(`
            UPDATE knowledge_entities entity
            SET evidence_count = (
                    SELECT COUNT(*)
                    FROM knowledge_entity_mentions mention
                    JOIN knowledge_docs document ON document.id = mention.doc_id
                    WHERE mention.entity_id = entity.id
                      AND COALESCE(mention.source_state, 'active') = 'active'
                      AND ${graphDocumentReadySql('document')}
                ),
                last_evidence_at = (
                    SELECT MAX(mention.updated_at)
                    FROM knowledge_entity_mentions mention
                    JOIN knowledge_docs document ON document.id = mention.doc_id
                    WHERE mention.entity_id = entity.id
                      AND COALESCE(mention.source_state, 'active') = 'active'
                      AND ${graphDocumentReadySql('document')}
                ),
                updated_at = CASE WHEN entity.origin = 'auto' THEN ? ELSE entity.updated_at END
            WHERE entity.id = ?
        `, [getBeijingTimestamp(), row.entity_id]);
    }
    return { entities: rows.length };
}

async function garbageCollectKnowledgeGraph({ userId = null, limit = 500 } = {}, deps = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 500, 1), 5000);
    const exec = deps.execute || execute;
    const ownerSql = userId ? 'AND user_id = ?' : '';
    const params = userId ? [Number(userId), safeLimit] : [safeLimit];
    const deleted = await exec(`
        UPDATE knowledge_entities entity
        SET deleted_at = ?, updated_at = ?
        WHERE entity.id IN (
            SELECT id FROM knowledge_entities
            WHERE deleted_at IS NULL AND origin = 'auto' AND frozen = FALSE
              AND COALESCE(evidence_count, 0) = 0 ${ownerSql}
            ORDER BY updated_at ASC LIMIT ?
        )
    `, [getBeijingTimestamp(), getBeijingTimestamp(), ...params]);
    return { deleted: Number(deleted || 0) };
}

function createKnowledgeGraphMaintenanceRunner({ intervalMs = 6 * 60 * 60 * 1000, logger: log = logger, deps = {} } = {}) {
    const interval = Math.min(Math.max(Number.parseInt(intervalMs, 10) || 6 * 60 * 60 * 1000, 60 * 1000), 24 * 60 * 60 * 1000);
    let timer = null;
    let running = false;
    const runOnce = async () => {
        if (running) return null;
        running = true;
        try { return await garbageCollectKnowledgeGraph({}, deps); }
        catch (error) { log.warn?.({ err: error.message }, '知识图谱自动实体清理失败'); return null; }
        finally { running = false; }
    };
    return {
        start() {
            if (timer) return { started: true };
            timer = setInterval(() => { void runOnce(); }, interval);
            timer.unref?.();
            void runOnce();
            return { started: true };
        },
        stop() { if (timer) clearInterval(timer); timer = null; },
        runOnce,
        getRuntimeStatus: () => ({ started: Boolean(timer), running })
    };
}

async function invalidateKnowledgeGraphSources({ userId = null, docId, reason = 'source_changed' } = {}, deps = {}) {
    const safeDocId = Number.parseInt(docId, 10);
    if (!Number.isSafeInteger(safeDocId) || safeDocId <= 0) return { relations: 0, mentions: 0, claims: 0 };
    const exec = deps.execute || execute;
    const q = deps.query || query;
    const relationParams = userId ? [getBeijingTimestamp(), safeDocId, Number(userId)] : [getBeijingTimestamp(), safeDocId];
    const relationUserSql = userId ? ' AND user_id = ?' : '';
    const relationRows = await q(`SELECT id FROM knowledge_relations WHERE source_doc_id = ?${relationUserSql}`, userId ? [safeDocId, Number(userId)] : [safeDocId]);
    const mentions = await exec(`
        UPDATE knowledge_entity_mentions SET source_state = 'inactive', updated_at = ?
        WHERE doc_id = ?${relationUserSql}
    `, relationParams);
    const relations = await exec(`
        UPDATE knowledge_relations SET source_state = 'inactive', status = 'deleted', updated_at = ?
        WHERE source_doc_id = ?${relationUserSql}
    `, relationParams);
    const facts = await invalidateGraphClaimEvidenceForDocument({ docId: safeDocId }, deps);
    await refreshGraphEntityEvidenceForDocument(safeDocId, deps);
    return { relations: Number(relations || relationRows.length || 0), mentions: Number(mentions || 0), claims: Number(facts?.claims || 0), reason };
}

async function getGraphSummaryAsync(userOrId, scope = {}) {
    const normalizedUser = normalizeKnowledgeUser(userOrId);
    const entityAccess = buildGraphEntityAccessFilter(userOrId, 'e');
    const relationAccess = buildGraphRelationAccessFilter(userOrId, 'r');
    const entityScope = buildGraphEntityScopeSql(scope);
    const relationScope = buildGraphRelationRecordScopeSql(scope, 'r');
    const mentionScope = buildGraphMentionScopeSql(scope, 'm');
    const mentionAccess = buildGraphMentionAccessFilter(userOrId, 'm');
    const entityRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_entities e WHERE ${entityAccess.sql} AND e.deleted_at IS NULL AND ${graphEntityEvidenceReadySql('e')} ${entityScope.sql}`, [...entityAccess.params, ...entityScope.params]);
    const entityCount = Number(entityRow?.count || 0);

    const relationRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_relations r WHERE ${relationAccess.sql} AND r.status = 'active' AND ${graphRelationEvidenceReadySql('r')} ${relationScope.sql}`, [...relationAccess.params, ...relationScope.params]);
    const relationCount = Number(relationRow?.count || 0);

    const pendingRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_relations r WHERE ${relationAccess.sql} AND r.status = 'pending' AND ${graphRelationEvidenceReadySql('r')} ${relationScope.sql}`, [...relationAccess.params, ...relationScope.params]);
    const pendingRelationCount = Number(pendingRow?.count || 0);

    const mentionRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_entity_mentions m WHERE ${mentionAccess.sql} AND COALESCE(m.source_state, 'active') = 'active' AND EXISTS (SELECT 1 FROM knowledge_docs d_active WHERE d_active.id = m.doc_id AND ${graphDocumentReadySql('d_active')}) ${mentionScope.sql}`, [...mentionAccess.params, ...mentionScope.params]);
    const mentionCount = Number(mentionRow?.count || 0);
    const orphanRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_entities e WHERE ${entityAccess.sql} AND e.deleted_at IS NULL AND ${graphEntityEvidenceReadySql('e')} ${entityScope.sql} AND NOT EXISTS (SELECT 1 FROM knowledge_relations r WHERE ${relationAccess.sql.replace(/\br\./g, 'r.')} AND r.status IN ('active', 'pending') AND ${graphRelationEvidenceReadySql('r')} AND (r.source_entity_id = e.id OR r.target_entity_id = e.id) ${relationScope.sql})`, [...entityAccess.params, ...entityScope.params, ...relationAccess.params, ...relationScope.params]);
    const orphanEntities = Number(orphanRow?.count || 0);
    const lowConfidenceRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_relations r WHERE ${relationAccess.sql} AND status IN ('active', 'pending') AND ${graphRelationEvidenceReadySql('r')} AND confidence < ? ${relationScope.sql}`, [...relationAccess.params, LOW_CONFIDENCE_THRESHOLD, ...relationScope.params]);
    const lowConfidenceRelations = Number(lowConfidenceRow?.count || 0);
    const sourceLessRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_relations r WHERE ${relationAccess.sql} AND status IN ('active', 'pending') AND (source_doc_id IS NULL OR COALESCE(source_state, 'active') <> 'active' OR NOT (${graphRelationEvidenceReadySql('r')})) ${relationScope.sql}`, [...relationAccess.params, ...relationScope.params]);
    const sourceLessRelations = Number(sourceLessRow?.count || 0);
    const topTypes = await query(`SELECT type, COUNT(*) AS count FROM knowledge_entities e WHERE ${entityAccess.sql} AND e.deleted_at IS NULL AND ${graphEntityEvidenceReadySql('e')} ${entityScope.sql} GROUP BY type ORDER BY count DESC, type ASC LIMIT 12`, [...entityAccess.params, ...entityScope.params]);
    const duplicateSuggestions = hasGraphScope(scope) ? [] : await suggestDuplicateEntities(normalizedUser.id, 5);
    const quality = buildGraphQualitySignals({ entityCount, relationCount, mentionCount, pendingRelationCount, orphanEntities, lowConfidenceRelations, sourceLessRelations, duplicateSuggestions });
    let scopedDoc = null;
    const normalizedScope = normalizeGraphScope(scope);
    if (normalizedScope.docIds.length === 1) {
        const documentAccess = buildGraphDocumentAccessFilter(userOrId, 'd');
        scopedDoc = await queryOne(`
            SELECT d.id, d.name
            FROM knowledge_docs d
            WHERE d.id = ? AND d.deleted_at IS NULL AND ${documentAccess.sql}
        `, [normalizedScope.docIds[0], ...documentAccess.params]);
    }
    return {
        extractionMode: GRAPH_EXTRACTION_MODE, qualityNotice: GRAPH_QUALITY_NOTICE,
        entities: entityCount, relations: relationCount, pendingRelations: pendingRelationCount,
        mentions: mentionCount, topTypes: topTypes || [], quality,
        suggestions: quality.recommendations, duplicateSuggestions,
        doc: scopedDoc ? { id: scopedDoc.id, name: scopedDoc.name } : null
    };
}

const getGraphSummary = getGraphSummaryAsync;

async function listEntities({ userId, user = null, query: queryText = '', type = '', quality = '', scope = {}, limit = 50, offset = 0 }) {
    const entityAccess = buildGraphEntityAccessFilter(user || userId, 'e'), entityScope = buildGraphEntityScopeSql(scope);
    const mentionScope = buildGraphMentionScopeSql(scope, 'm'), relationScope1 = buildGraphRelationRecordScopeSql(scope, 'r1');
    const relationScope2 = buildGraphRelationRecordScopeSql(scope, 'r2'), orphanRelationScope = buildGraphRelationRecordScopeSql(scope, 'r');
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200), safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const where = [entityAccess.sql, 'e.deleted_at IS NULL', graphEntityEvidenceReadySql('e')], params = [...entityAccess.params, ...entityScope.params];
    if (entityScope.sql) where.push(entityScope.sql.replace(/^\s*AND\s+/i, ''));
    const normalizedQuery = normalizeEntityName(queryText);
    if (normalizedQuery) { where.push('(e.normalized_name LIKE ? OR e.name LIKE ?)'); params.push(`%${normalizedQuery}%`, `%${String(queryText).trim()}%`); }
    if (type) { where.push('e.type = ?'); params.push(type); }
    if (quality === 'orphan') {
        where.push(`NOT EXISTS (SELECT 1 FROM knowledge_relations r WHERE r.user_id = e.user_id AND r.status IN ('active', 'pending') AND ${graphRelationEvidenceReadySql('r')} AND (r.source_entity_id = e.id OR r.target_entity_id = e.id) ${orphanRelationScope.sql})`);
        params.push(...orphanRelationScope.params);
    }
    if (quality === 'low') { where.push('e.confidence < ?'); params.push(0.62); }
    const whereSql = where.join(' AND ');
    const relationAccess1 = buildGraphRelationAccessFilter(user || userId, 'r1'), relationAccess2 = buildGraphRelationAccessFilter(user || userId, 'r2');
    const data = await query(`
        SELECT e.*, COUNT(DISTINCT m.id) AS mention_count, COUNT(DISTINCT r1.id) + COUNT(DISTINCT r2.id) AS relation_count
        FROM knowledge_entities e
        LEFT JOIN knowledge_entity_mentions m ON m.entity_id = e.id AND COALESCE(m.source_state, 'active') = 'active' ${mentionScope.sql}
        LEFT JOIN knowledge_relations r1 ON r1.source_entity_id = e.id AND r1.status = 'active' AND ${graphRelationEvidenceReadySql('r1')} AND (${relationAccess1.sql}) ${relationScope1.sql}
        LEFT JOIN knowledge_relations r2 ON r2.target_entity_id = e.id AND r2.status = 'active' AND ${graphRelationEvidenceReadySql('r2')} AND (${relationAccess2.sql}) ${relationScope2.sql}
        WHERE ${whereSql} GROUP BY e.id ORDER BY relation_count DESC, mention_count DESC, e.updated_at DESC LIMIT ? OFFSET ?
    `, [...mentionScope.params, ...relationAccess1.params, ...relationScope1.params, ...relationAccess2.params, ...relationScope2.params, ...params, safeLimit, safeOffset]);
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_entities e WHERE ${whereSql}`, params);
    return { data: data || [], total: Number(totalRow?.count || 0), limit: safeLimit, offset: safeOffset };
}

async function getEntityGraph({ userId, user = null, entityId, depth = 1, limit = 80, status = 'active', relationType = '', minConfidence = null, scope = {} }) {
    const entityAccess = buildGraphEntityAccessFilter(user || userId, 'e'), entityScope = buildGraphEntityScopeSql(scope);
    const entity = await queryOne(`SELECT * FROM knowledge_entities e WHERE e.id = ? AND ${entityAccess.sql} AND e.deleted_at IS NULL AND ${graphEntityEvidenceReadySql('e')} ${entityScope.sql}`, [entityId, ...entityAccess.params, ...entityScope.params]);
    if (!entity) return null;
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 80, 10), 300);
    const safeDepth = Math.min(Math.max(Number.parseInt(depth, 10) || 1, 1), 2);
    const statusList = normalizeRelationStatusFilter(status);
    const relationAccess = buildGraphRelationAccessFilter(user || userId, 'r');
    const relationScope = buildGraphRelationRecordScopeSql(scope, 'r');
    const visitedEntityIds = new Set([Number(entity.id)]);
    const relationMap = new Map();
    let frontier = [Number(entity.id)];
    for (let hop = 0; hop < safeDepth && frontier.length && relationMap.size < safeLimit; hop += 1) {
        const placeholders = frontier.map(() => '?').join(',');
        const relationWhere = [
            relationAccess.sql,
            `r.status IN (${statusList.map(() => '?').join(',')})`,
            graphRelationEvidenceReadySql('r'),
            `(r.source_entity_id IN (${placeholders}) OR r.target_entity_id IN (${placeholders}))`
        ];
        const params = [...relationAccess.params, ...statusList, ...frontier, ...frontier];
        if (relationScope.sql) { relationWhere.push(relationScope.sql.replace(/^\s*AND\s+/i, '')); params.push(...relationScope.params); }
        if (relationType) { relationWhere.push('r.relation_type = ?'); params.push(String(relationType).trim()); }
        const min = Number(minConfidence);
        if (Number.isFinite(min)) { relationWhere.push('r.confidence >= ?'); params.push(Math.min(Math.max(min, 0), 1)); }
        const rows = await query(`
            SELECT r.*, s.name AS source_name, s.type AS source_type, t.name AS target_name, t.type AS target_type,
                   d.name AS doc_name, c.content AS chunk_text, evidence.excerpt_text, evidence.locator_json, evidence.stance,
                   claim.confidence_reason_json
            FROM knowledge_relations r
            JOIN knowledge_entities s ON s.id = r.source_entity_id AND s.deleted_at IS NULL
            JOIN knowledge_entities t ON t.id = r.target_entity_id AND t.deleted_at IS NULL
            LEFT JOIN knowledge_docs d ON d.id = r.source_doc_id
            LEFT JOIN knowledge_chunks c ON c.id = r.source_chunk_id
            LEFT JOIN knowledge_graph_claim_evidence evidence ON evidence.legacy_relation_id = r.id AND evidence.source_state = 'active'
            LEFT JOIN knowledge_graph_claims claim ON claim.id = evidence.claim_id
            WHERE ${relationWhere.join(' AND ')} ORDER BY r.confidence DESC, r.updated_at DESC LIMIT ?
        `, [...params, safeLimit - relationMap.size]);
        const next = new Set();
        for (const row of rows || []) {
            relationMap.set(Number(row.id), row);
            [Number(row.source_entity_id), Number(row.target_entity_id)].forEach(id => {
                if (!visitedEntityIds.has(id)) { visitedEntityIds.add(id); next.add(id); }
            });
            if (relationMap.size >= safeLimit) break;
        }
        frontier = [...next];
    }
    const relations = [...relationMap.values()];
    const nodeMap = new Map([[entity.id, entity]]);
    (relations || []).forEach(row => {
        nodeMap.set(row.source_entity_id, { id: row.source_entity_id, name: row.source_name, type: row.source_type });
        nodeMap.set(row.target_entity_id, { id: row.target_entity_id, name: row.target_name, type: row.target_type });
    });
    return { center: entity, depth: safeDepth, nodes: Array.from(nodeMap.values()), relations };
}

function normalizeRelationStatusFilter(status = 'active') {
    const raw = String(status || 'active').trim();
    if (raw === 'all') return ['active', 'pending'];
    if (raw === 'pending') return ['pending'];
    if (raw === 'deleted') return ['deleted'];
    return ['active'];
}

async function listRelations({ userId, user = null, entityId = null, relationType = '', status = 'active', minConfidence = null, docId = null, scope = {}, limit = 100, offset = 0 }) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 300), safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const statusList = normalizeRelationStatusFilter(status), relationAccess = buildGraphRelationAccessFilter(user || userId, 'r');
    const where = [relationAccess.sql, `r.status IN (${statusList.map(() => '?').join(',')})`];
    if (!statusList.includes('deleted')) where.push(graphRelationEvidenceReadySql('r'));
    const params = [...relationAccess.params, ...statusList];
    const relationScope = buildGraphRelationRecordScopeSql({ ...scope, docId: docId || scope?.docId }, 'r');
    if (relationScope.sql) { where.push(relationScope.sql.replace(/^\s*AND\s+/i, '')); params.push(...relationScope.params); }
    const safeEntityId = Number.parseInt(entityId, 10);
    if (Number.isSafeInteger(safeEntityId) && safeEntityId > 0) { where.push('(r.source_entity_id = ? OR r.target_entity_id = ?)'); params.push(safeEntityId, safeEntityId); }
    if (relationType) { where.push('r.relation_type = ?'); params.push(String(relationType).trim()); }
    const min = Number(minConfidence);
    if (Number.isFinite(min)) { where.push('r.confidence >= ?'); params.push(Math.min(Math.max(min, 0), 1)); }
    const whereSql = where.join(' AND ');
    const data = await query(`
        SELECT r.*, s.name AS source_name, s.type AS source_type, t.name AS target_name, t.type AS target_type,
               d.name AS doc_name, c.content AS chunk_text
        FROM knowledge_relations r
        JOIN knowledge_entities s ON s.id = r.source_entity_id
        JOIN knowledge_entities t ON t.id = r.target_entity_id
        LEFT JOIN knowledge_docs d ON d.id = r.source_doc_id
        LEFT JOIN knowledge_chunks c ON c.id = r.source_chunk_id
        WHERE ${whereSql}
        ORDER BY r.confidence DESC, r.updated_at DESC
        LIMIT ? OFFSET ?
    `, [...params, safeLimit, safeOffset]);
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_relations r WHERE ${whereSql}`, params);
    const total = Number(totalRow?.count || 0);
    return { data: data || [], total, limit: safeLimit, offset: safeOffset };
}

function buildGraphQualitySignals({
    entityCount = 0,
    relationCount = 0,
    mentionCount = 0,
    pendingRelationCount = 0,
    orphanEntities = 0,
    lowConfidenceRelations = 0,
    sourceLessRelations = 0,
    duplicateSuggestions = []
}) {
    let score = 100;
    if (entityCount === 0) score = 0;
    else {
        if (relationCount === 0) score -= 30;
        score -= Math.min(orphanEntities * 3, 24);
        score -= Math.min(pendingRelationCount * 4, 24);
        score -= Math.min(lowConfidenceRelations * 3, 18);
        score -= Math.min(sourceLessRelations * 2, 12);
        score -= Math.min(duplicateSuggestions.length * 5, 20);
        if (mentionCount < entityCount) score -= 8;
    }
    const qualityScore = Math.max(0, Math.min(100, Math.round(score)));
    const recommendations = [];
    if (entityCount === 0) recommendations.push('知识图谱暂无实体，请先上传并索引知识库文档。');
    if (pendingRelationCount > 0) recommendations.push(`有 ${pendingRelationCount} 条低置信关系待确认，建议先审核后再参与正式图谱。`);
    if (duplicateSuggestions.length > 0) recommendations.push(`发现 ${duplicateSuggestions.length} 组疑似重复实体，可在校准弹窗中合并。`);
    if (orphanEntities > 0) recommendations.push(`有 ${orphanEntities} 个孤立实体，建议补充来源资料或清理无效实体。`);
    if (sourceLessRelations > 0) recommendations.push(`有 ${sourceLessRelations} 条关系缺少来源文档，建议补充来源或降低其使用优先级。`);
    if (relationCount === 0 && entityCount > 0) recommendations.push('实体已抽取但关系较少，可重建图谱或补充包含责任、依赖、归属的信息。');
    return {
        qualityScore,
        level: qualityScore >= 85 ? 'good' : qualityScore >= 65 ? 'warning' : 'risk',
        orphanEntities,
        lowConfidenceRelations,
        sourceLessRelations,
        pendingRelations: pendingRelationCount,
        duplicateGroups: duplicateSuggestions.length,
        recommendations
    };
}

async function suggestDuplicateEntities(userId, limit = 20) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
    const rows = await query(`
        SELECT id, name, normalized_name, type, aliases, confidence, updated_at
        FROM knowledge_entities
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY type ASC, normalized_name ASC
    `, [userId]);
    return await scoreKnowledgeEntityResolutionCandidates(rows || [], { limit: safeLimit });
}

// 在 JS 打分前，最多从 SQL 拉取的候选实体数量上限。
const QUERY_ENTITY_CANDIDATE_LIMIT = 200;

async function findQueryEntities(userId, queryText, limit = GRAPH_CONTEXT_ENTITY_LIMIT, options = {}) {
    const terms = buildRagSearchTerms(queryText, 20);
    if (terms.length === 0) return [];
    const scopeFilter = buildGraphEntityScopeSql(options.scope);
    const access = buildGraphEntityAccessFilter(options.user || userId, 'e');
    const tokenClauses = [];
    const tokenParams = [];
    terms.slice(0, 8).forEach(term => {
        const like = `%${String(term).toLowerCase()}%`;
        tokenClauses.push(`(
            LOWER(e.normalized_name) LIKE ? OR LOWER(e.name) LIKE ?
            OR EXISTS (
                SELECT 1 FROM knowledge_entity_aliases alias
                WHERE alias.entity_id = e.id AND LOWER(alias.normalized_alias) LIKE ?
            )
        )`);
        tokenParams.push(like, like, like);
    });
    const rows = await query(`
        SELECT e.*, COUNT(m.id) AS mention_count
        FROM knowledge_entities e
        LEFT JOIN knowledge_entity_mentions m ON m.entity_id = e.id AND COALESCE(m.source_state, 'active') = 'active'
        WHERE e.deleted_at IS NULL
          AND ${graphEntityEvidenceReadySql('e')}
          AND (${tokenClauses.join(' OR ')})
        ${scopeFilter.sql}
          AND ${access.sql}
        GROUP BY e.id
        LIMIT ?
    `, [
        ...tokenParams,
        ...scopeFilter.params,
        ...access.params,
        QUERY_ENTITY_CANDIDATE_LIMIT
    ]);
    return (rows || [])
        .map(row => {
            const haystack = `${row.name} ${row.normalized_name} ${row.aliases || ''}`.toLowerCase();
            const score = terms.reduce((acc, term) => acc + (haystack.includes(String(term).toLowerCase()) ? Math.min(String(term).length, 6) : 0), 0);
            return { ...row, graphScore: score };
        })
        .filter(row => row.graphScore > 0)
        .sort((a, b) => b.graphScore - a.graphScore || Number(b.mention_count || 0) - Number(a.mention_count || 0))
        .slice(0, limit);
}

async function getGraphContextForQuery(userId, queryText, options = {}) {
    const entities = await findQueryEntities(userId, queryText, options.entityLimit || GRAPH_CONTEXT_ENTITY_LIMIT, options);
    if (entities.length === 0) return { entities: [], relations: [], chunkIds: [], context: '' };
    const entityIds = entities.map(entity => entity.id);
    const placeholders = entityIds.map(() => '?').join(',');
    const relationScope = buildGraphRelationScopeSql(options.scope, 'd', 'claim');
    const access = buildGraphRelationAccessFilter(options.user || userId, 'claim');
    const relations = await query(`
        SELECT * FROM (
            SELECT DISTINCT ON (claim.id)
                   evidence.legacy_relation_id AS id, claim.id AS claim_id, claim.user_id,
                   claim.source_entity_id, claim.target_entity_id, claim.relation_type, claim.description,
                   claim.confidence, claim.status, claim.evidence_count, claim.last_evidence_at,
                   evidence.source_doc_id, evidence.source_chunk_id, evidence.excerpt_hash, evidence.excerpt_text, evidence.locator_json,
                   s.name AS source_name, t.name AS target_name, d.name AS doc_name
            FROM knowledge_graph_claims claim
            JOIN knowledge_entities s ON s.id = claim.source_entity_id AND s.deleted_at IS NULL
            JOIN knowledge_entities t ON t.id = claim.target_entity_id AND t.deleted_at IS NULL
            JOIN knowledge_graph_claim_evidence evidence ON evidence.claim_id = claim.id AND evidence.source_state = 'active'
            JOIN knowledge_docs d ON d.id = evidence.source_doc_id AND ${graphDocumentReadySql('d')}
            WHERE claim.status = 'active'
              AND ${access.sql}
              AND (claim.source_entity_id IN (${placeholders}) OR claim.target_entity_id IN (${placeholders}))
              ${relationScope.sql}
            ORDER BY claim.id, claim.confidence DESC, evidence.confidence DESC, evidence.updated_at DESC
        ) ranked_claims
        ORDER BY confidence DESC, evidence_count DESC, last_evidence_at DESC NULLS LAST, claim_id DESC
        LIMIT ?
    `, [
        ...access.params,
        ...entityIds,
        ...entityIds,
        ...relationScope.params,
        options.relationLimit || GRAPH_CONTEXT_RELATION_LIMIT
    ]);
    const chunkIds = [...new Set(relations.map(row => row.source_chunk_id).filter(Boolean))];
    return {
        entities,
        relations,
        chunkIds,
        context: formatGraphContext({ entities, relations })
    };
}

async function queryKnowledgeGraph({ userId, user = null, query, entityLimit = GRAPH_CONTEXT_ENTITY_LIMIT, relationLimit = GRAPH_CONTEXT_RELATION_LIMIT, scope = {} }) {
    const graphContext = await getGraphContextForQuery(userId, query, { entityLimit, relationLimit, scope, user });
    const entities = graphContext.entities;
    const paths = graphContext.relations.map(row => ({
        relationId: row.id,
        source: row.source_name,
        relationType: row.relation_type,
        target: row.target_name,
        confidence: row.confidence,
        docName: row.doc_name || '',
        chunkId: row.source_chunk_id || null,
        description: row.description || '',
        locator: typeof row.locator_json === 'object' ? row.locator_json : (() => {
            try { return JSON.parse(row.locator_json || '{}'); } catch (_) { return {}; }
        })()
    }));
    const sourceDocIds = [...new Set(graphContext.relations.map(row => row.source_doc_id).filter(Boolean))];
    return {
        query: String(query || ''),
        extractionMode: GRAPH_EXTRACTION_MODE,
        qualityNotice: GRAPH_QUALITY_NOTICE,
        entities,
        relations: graphContext.relations,
        paths,
        chunkIds: graphContext.chunkIds,
        sourceDocIds,
        context: graphContext.context,
        answerHint: paths.length
            ? '已找到可解释关系路径，可结合来源文档回答。'
            : '未找到明确关系路径，建议补充资料或使用文本召回。'
    };
}

function formatGraphContext({ entities = [], relations = [] }) {
    if (!entities.length && !relations.length) return '';
    const entityText = entities
        .slice(0, GRAPH_CONTEXT_ENTITY_LIMIT)
        .map(entity => `${entity.name}(${entity.type || 'concept'})`)
        .join('、');
    const relationText = relations
        .slice(0, GRAPH_CONTEXT_RELATION_LIMIT)
        .map((row, index) => `[关系 ${index + 1} | 来源: ${row.doc_name || '知识图谱'}]: ${row.source_name} -${row.relation_type}-> ${row.target_name}${row.description ? `；依据: ${String(row.description).slice(0, 120)}` : ''}${row.excerpt_text ? `；原文: ${String(row.excerpt_text).slice(0, 240)}` : ''}`)
        .join('\n');
    return `\n\n【参考知识图谱信息如下】：\n相关实体：${entityText || '-'}\n${relationText}\n请结合上述实体关系与知识库引用回答；如果实体关系不足以支撑结论，请明确说明依据不足。\n`;
}

async function updateEntity({ userId, entityId, patch }) {
    const current = await queryOne('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [entityId, userId]);
    if (!current) return null;
    const name = cleanEntityName(patch.name ?? current.name);
    const normalized = normalizeEntityName(name);
    const type = String(patch.type || current.type || 'concept').slice(0, 40);
    const description = String(patch.description ?? current.description ?? '').slice(0, 1000);
    const aliases = patch.aliases !== undefined ? JSON.stringify(buildAliasList(patch.aliases)) : current.aliases;
    const frozen = patch.frozen === undefined ? true : patch.frozen === true;
    await execute(`
        UPDATE knowledge_entities
        SET name = ?, normalized_name = ?, type = ?, description = ?, aliases = ?,
            origin = 'manual', frozen = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [name, normalized, type, description, aliases, frozen, getBeijingTimestamp(), entityId, userId]);
    const updated = await queryOne('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ?', [entityId, userId]);
    if (updated) await syncKnowledgeEntityAliases(updated);
    return updated;
}

async function mergeEntities({ userId, sourceEntityId, targetEntityId }) {
    const result = await mergeKnowledgeGraphEntities({ userId, sourceEntityId, targetEntityId });
    if (!result) return null;
    const target = await queryOne('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ?', [result.targetId, userId]);
    if (target) await syncKnowledgeEntityAliases(target);
    return await getEntityGraph({ userId, entityId: result.targetId });
}

async function revertEntityMerge({ userId, auditId }) {
    const restored = await revertKnowledgeGraphEntityMerge({ userId, auditId });
    if (!restored) return null;
    return { ...restored, graph: await getEntityGraph({ userId, entityId: restored.sourceId }) };
}

async function listGraphMergeAudits({ userId, limit = 50 }) {
    return await listKnowledgeGraphMergeAudits({ userId, limit });
}

async function updateRelation({ userId, relationId, patch }) {
    const current = await queryOne("SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ? AND status IN ('active', 'pending')", [relationId, userId]);
    if (!current) return null;
    const nextStatus = ['active', 'pending'].includes(String(patch.status || '').trim())
        ? String(patch.status).trim()
        : relationStatusForConfidence(patch.confidence ?? current.confidence);
    await execute(`
        UPDATE knowledge_relations
        SET relation_type = ?, description = ?, confidence = ?, status = ?, origin = 'manual', frozen = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [
        normalizeGraphRelationType(patch.relationType || current.relation_type || 'related_to'),
        String(patch.description ?? current.description ?? '').slice(0, 1000),
        Math.min(Math.max(Number(patch.confidence ?? current.confidence ?? 0.6), 0), 1),
        nextStatus,
        patch.frozen === undefined ? true : patch.frozen === true,
        getBeijingTimestamp(),
        relationId,
        userId
    ]);
    const updated = await queryOne('SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ?', [relationId, userId]);
    if (updated) {
        // 人工改写关系类型后，旧 claim 的 evidence 不能继续代表新语义；先撤销
        // 旧证据，再以同一来源创建/冻结新的规范断言。
        await rejectGraphClaimEvidenceByRelation(updated.id);
        await upsertGraphClaimEvidence({
            userId, sourceEntityId: updated.source_entity_id, targetEntityId: updated.target_entity_id,
            relationType: updated.relation_type, description: updated.description, confidence: updated.confidence,
            origin: 'manual', legacyRelationId: updated.id, sourceDocId: updated.source_doc_id,
            sourceChunkId: updated.source_chunk_id, snippet: updated.description,
            extractionMethod: 'manual', extractorVersion: 'manual-v1',
            stance: patch.stance === 'contradicts' ? 'contradicts' : 'supports'
        });
        await setGraphClaimManualReview({
            legacyRelationId: updated.id, status: updated.status, confidence: updated.confidence,
            description: updated.description, frozen: updated.frozen === true
        });
    }
    return updated;
}

async function deleteRelation({ userId, relationId }) {
    const result = await execute("UPDATE knowledge_relations SET status = 'deleted', updated_at = ? WHERE id = ? AND user_id = ?", [
        getBeijingTimestamp(), relationId, userId
    ]);
    const deleted = Number(result || 0) > 0;
    if (deleted) await rejectGraphClaimEvidenceByRelation(relationId);
    return deleted;
}

async function confirmRelation({ userId, relationId }) {
    const current = await queryOne("SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ? AND status = 'pending'", [relationId, userId]);
    if (!current) return null;
    await execute(`
        UPDATE knowledge_relations
        SET status = 'active', confidence = GREATEST(confidence, ?), updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [LOW_CONFIDENCE_THRESHOLD, getBeijingTimestamp(), relationId, userId]);
    const confirmed = await queryOne('SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ?', [relationId, userId]);
    if (confirmed) await setGraphClaimManualReview({ legacyRelationId: confirmed.id, status: 'active', confidence: confirmed.confidence });
    return confirmed;
}

async function rebuildGraphForDocument({ userId, docId }) {
    const doc = await queryOne("SELECT * FROM knowledge_docs WHERE id = ? AND user_id = ? AND deleted_at IS NULL", [docId, userId]);
    if (!doc) return null;
    const chunks = (await knowledgeRepository.listAllDocumentChunks(docId)) || [];
    // 删除旧图谱与写入新图谱必须是同一事务：抽取或写库失败时保留上一份可用图谱。
    const result = await transaction(async trx => {
        const trxDeps = {
            query: trx.query.bind(trx), queryOne: trx.queryOne.bind(trx), execute: trx.execute.bind(trx),
            getDocumentName: async id => await trx.queryOne('SELECT name FROM knowledge_docs WHERE id = ?', [id])
        };
        await clearKnowledgeGraphForDocument(docId, trxDeps);
        return await indexKnowledgeGraphForChunks({ userId, docId, chunks, deps: trxDeps });
    });
    return { docId, ...result };
}

async function safeIndexKnowledgeGraphForChunks(payload) {
    try {
        return await indexKnowledgeGraphForChunks(payload);
    } catch (e) {
        logger.warn({ err: e.message, docId: payload?.docId }, '知识图谱已跳过文档批次索引');
        return { entities: 0, relations: 0, error: e.message };
    }
}

module.exports = {
    clearKnowledgeGraphForDocument,
    confirmRelation,
    deleteRelation,
    createKnowledgeGraphMaintenanceRunner,
    extractEntitiesFromText,
    GRAPH_EXTRACTION_MODE,
    GRAPH_QUALITY_NOTICE,
    extractKnowledgeGraph,
    extractRelationsFromText,
    findQueryEntities,
    formatGraphContext,
    getEntityGraph,
    getGraphContextForQuery,
    getGraphSummary,
    getGraphSummaryAsync,
    indexKnowledgeGraphForChunks,
    invalidateKnowledgeGraphSources,
    listEntities,
    listGraphMergeAudits,
    listRelations,
    mergeEntities,
    garbageCollectKnowledgeGraph,
    normalizeEntityName,
    queryKnowledgeGraph,
    refreshGraphEntityEvidenceForDocument,
    rebuildGraphForDocument,
    revertEntityMerge,
    suggestDuplicateEntities,
    safeIndexKnowledgeGraphForChunks,
    updateEntity,
    updateRelation,
    upsertEntity
};
