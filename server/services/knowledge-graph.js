const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { buildRagSearchTerms, normalizeSearchText } = require('./rag-tokenizer');

const MAX_ENTITIES_PER_CHUNK = 12;
const MAX_RELATIONS_PER_CHUNK = 16;
const GRAPH_CONTEXT_ENTITY_LIMIT = 6;
const GRAPH_CONTEXT_RELATION_LIMIT = 12;

const ENTITY_SUFFIX_TYPES = [
    ['department', /(部门|中心|小组|团队|委员会|办公室|事业部|分公司|集团|公司)$/],
    ['system', /(系统|平台|服务|数据库|网关|接口|API|模型|知识库|控制台|门户)$/i],
    ['process', /(流程|工单|审批|审核|申请|报销|归档|发布|上线|巡检)$/],
    ['policy', /(制度|规范|办法|规定|指南|手册|预案|标准|条例|细则|政策)$/],
    ['project', /(项目|计划|工程|专项|版本|里程碑)$/],
    ['role', /(管理员|负责人|审批人|申请人|用户|客户|供应商|运维|开发|测试)$/]
];

const RELATION_PATTERNS = [
    { type: 'responsible_for', regex: /([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})(?:负责|管理|维护|承接)([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})/g },
    { type: 'belongs_to', regex: /([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})(?:属于|隶属于|归口于)([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})/g },
    { type: 'depends_on', regex: /([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})(?:依赖|调用|接入|连接|使用)([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})/g },
    { type: 'contains', regex: /([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})(?:包含|包括|覆盖|由)([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})/g },
    { type: 'affects', regex: /([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})(?:影响|适用于|约束|支撑)([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})/g }
];

function normalizeEntityName(value) {
    return normalizeSearchText(value)
        .replace(/[^\p{L}\p{N}\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff_.-]+/gu, '')
        .trim();
}

function cleanEntityName(value) {
    let text = String(value || '')
        .replace(/^[\s"'“”‘’《》（）()【】[\]{}<>:：,，;；.。]+|[\s"'“”‘’《》（）()【】[\]{}<>:：,，;；.。]+$/g, '')
        .trim();
    text = text.split(/(?:负责|管理|维护|承接|属于|隶属于|归口于|依赖|调用|接入|连接|使用|包含|包括|覆盖|影响|适用于|约束|支撑)/)[0] || text;
    return text.trim().slice(0, 80);
}

function inferEntityType(name) {
    const text = String(name || '');
    const matched = ENTITY_SUFFIX_TYPES.find(([, regex]) => regex.test(text));
    if (matched) return matched[0];
    if (/^[A-Z][A-Za-z0-9_.-]{1,39}$/.test(text) || /API|SDK|SQL|HTTP|RAG|MCP/i.test(text)) return 'system';
    return 'concept';
}

function isUsefulEntityName(name) {
    const text = cleanEntityName(name);
    if (text.length < 2 || text.length > 80) return false;
    if (/^\d+$/.test(text)) return false;
    if (/(?:负责|管理|维护|承接|属于|隶属于|归口于|依赖|调用|接入|连接|使用|包含|包括|覆盖|影响|适用于|约束|支撑)/.test(text)) return false;
    if (/^(以及|或者|如果|因此|同时|需要|可以|进行|通过|相关|当前|必须|不得|应该|问题)$/.test(text)) return false;
    return true;
}

function uniqByNormalized(entities) {
    const seen = new Set();
    const result = [];
    entities.forEach(entity => {
        const normalized = normalizeEntityName(entity.name);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push({ ...entity, normalizedName: normalized });
    });
    return result;
}

function extractEntitiesFromText(text, limit = MAX_ENTITIES_PER_CHUNK) {
    const content = String(text || '').slice(0, 5000);
    const entities = [];
    const push = (name, confidence = 0.68) => {
        const cleaned = cleanEntityName(name);
        if (!isUsefulEntityName(cleaned)) return;
        entities.push({
            name: cleaned,
            type: inferEntityType(cleaned),
            confidence
        });
    };

    const bracketRegex = /[《【“"]([^《》【】“”"]{2,60})[》】”"]/g;
    let match;
    while ((match = bracketRegex.exec(content))) push(match[1], 0.82);

    const suffixRegex = /([\u4e00-\u9fa5A-Za-z0-9_.-]{2,32}(?:部门|中心|小组|团队|委员会|办公室|事业部|集团|公司|系统|平台|服务|数据库|网关|接口|API|模型|知识库|流程|制度|规范|办法|规定|指南|手册|项目|计划|管理员|负责人))/gi;
    while ((match = suffixRegex.exec(content))) push(match[1], 0.76);

    RELATION_PATTERNS.forEach(({ regex }) => {
        regex.lastIndex = 0;
        while ((match = regex.exec(content))) {
            push(match[1], 0.78);
            push(match[2], 0.78);
        }
    });

    const latinRegex = /\b([A-Z][A-Za-z0-9_.-]{2,39}|[A-Z]{2,12})\b/g;
    while ((match = latinRegex.exec(content))) push(match[1], 0.7);

    return uniqByNormalized(entities)
        .sort((a, b) => b.confidence - a.confidence || b.name.length - a.name.length)
        .slice(0, limit);
}

function extractRelationsFromText(text, entities, limit = MAX_RELATIONS_PER_CHUNK) {
    const content = String(text || '').slice(0, 5000);
    const entityByNorm = new Map((entities || []).map(entity => [entity.normalizedName || normalizeEntityName(entity.name), entity]));
    const relations = [];
    const push = (sourceName, targetName, type, confidence, description = '') => {
        const sourceNorm = normalizeEntityName(sourceName);
        const targetNorm = normalizeEntityName(targetName);
        const source = entityByNorm.get(sourceNorm);
        const target = entityByNorm.get(targetNorm);
        if (!source || !target || sourceNorm === targetNorm) return;
        relations.push({
            sourceName: source.name,
            targetName: target.name,
            relationType: type,
            description: description || `${source.name} ${type} ${target.name}`,
            confidence
        });
    };

    RELATION_PATTERNS.forEach(({ type, regex }) => {
        let match;
        regex.lastIndex = 0;
        while ((match = regex.exec(content))) {
            push(match[1], match[2], type, 0.78, match[0].slice(0, 160));
        }
    });

    for (let i = 0; i < entities.length; i += 1) {
        for (let j = i + 1; j < entities.length && relations.length < limit; j += 1) {
            const a = entities[i];
            const b = entities[j];
            const aIndex = content.indexOf(a.name);
            const bIndex = content.indexOf(b.name);
            if (aIndex < 0 || bIndex < 0 || Math.abs(aIndex - bIndex) > 220) continue;
            push(a.name, b.name, 'related_to', 0.55, '同一知识分块中共同出现');
        }
    }

    const seen = new Set();
    return relations.filter(item => {
        const key = `${item.sourceName}|${item.relationType}|${item.targetName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, limit);
}

function extractKnowledgeGraph(text) {
    const entities = extractEntitiesFromText(text);
    const relations = extractRelationsFromText(text, entities);
    return { entities, relations };
}

function upsertEntity({ userId, name, type = 'concept', confidence = 0.7, sourceDocId = null, description = '' }) {
    const normalized = normalizeEntityName(name);
    if (!normalized) return null;
    const now = getBeijingTimestamp();
    db.prepare(`
        INSERT INTO knowledge_entities (user_id, name, normalized_name, type, description, confidence, source_doc_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, normalized_name) DO UPDATE SET
            name = CASE WHEN LENGTH(excluded.name) > LENGTH(knowledge_entities.name) THEN excluded.name ELSE knowledge_entities.name END,
            type = CASE WHEN knowledge_entities.type = 'concept' THEN excluded.type ELSE knowledge_entities.type END,
            confidence = MAX(knowledge_entities.confidence, excluded.confidence),
            updated_at = excluded.updated_at,
            deleted_at = NULL
    `).run(userId, cleanEntityName(name), normalized, type, description, confidence, sourceDocId, now, now);
    return db.prepare('SELECT * FROM knowledge_entities WHERE user_id = ? AND normalized_name = ?').get(userId, normalized);
}

function recordMention({ userId, entityId, docId, chunkId, snippet = '' }) {
    db.prepare(`
        INSERT OR IGNORE INTO knowledge_entity_mentions (user_id, entity_id, doc_id, chunk_id, snippet, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, entityId, docId, chunkId, String(snippet || '').slice(0, 500), getBeijingTimestamp());
}

function upsertRelation({ userId, sourceEntityId, targetEntityId, relationType, description = '', confidence = 0.6, sourceDocId = null, sourceChunkId = null }) {
    if (!sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId) return null;
    const now = getBeijingTimestamp();
    db.prepare(`
        INSERT INTO knowledge_relations (
            user_id, source_entity_id, target_entity_id, relation_type, description,
            confidence, source_doc_id, source_chunk_id, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(user_id, source_entity_id, target_entity_id, relation_type, source_chunk_id) DO UPDATE SET
            description = CASE WHEN excluded.description != '' THEN excluded.description ELSE knowledge_relations.description END,
            confidence = MAX(knowledge_relations.confidence, excluded.confidence),
            status = 'active',
            updated_at = excluded.updated_at
    `).run(userId, sourceEntityId, targetEntityId, relationType, description, confidence, sourceDocId, sourceChunkId, now, now);
}

function indexKnowledgeGraphForChunks({ userId, docId, chunks }) {
    if (!userId || !docId || !Array.isArray(chunks) || chunks.length === 0) return { entities: 0, relations: 0 };
    let entityCount = 0;
    let relationCount = 0;
    const indexTransaction = db.transaction(() => {
        chunks.forEach(chunk => {
            const graph = extractKnowledgeGraph(chunk.content);
            const entityRows = new Map();
            graph.entities.forEach(entity => {
                const row = upsertEntity({ userId, sourceDocId: docId, ...entity });
                if (!row) return;
                entityRows.set(entity.normalizedName, row);
                recordMention({
                    userId,
                    entityId: row.id,
                    docId,
                    chunkId: chunk.chunkId,
                    snippet: chunk.content
                });
                entityCount += 1;
            });
            graph.relations.forEach(relation => {
                const source = entityRows.get(normalizeEntityName(relation.sourceName));
                const target = entityRows.get(normalizeEntityName(relation.targetName));
                if (!source || !target) return;
                upsertRelation({
                    userId,
                    sourceEntityId: source.id,
                    targetEntityId: target.id,
                    relationType: relation.relationType,
                    description: relation.description,
                    confidence: relation.confidence,
                    sourceDocId: docId,
                    sourceChunkId: chunk.chunkId
                });
                relationCount += 1;
            });
        });
    });
    indexTransaction();
    return { entities: entityCount, relations: relationCount };
}

function clearKnowledgeGraphForDocument(docId) {
    const chunkIds = db.prepare('SELECT id FROM knowledge_chunks WHERE doc_id = ?').all(docId).map(row => row.id);
    if (chunkIds.length === 0) return;
    const placeholders = chunkIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM knowledge_relations WHERE source_chunk_id IN (${placeholders})`).run(...chunkIds);
    db.prepare(`DELETE FROM knowledge_entity_mentions WHERE chunk_id IN (${placeholders})`).run(...chunkIds);
}

function getGraphSummary(userId) {
    const entityCount = db.prepare('SELECT COUNT(*) AS count FROM knowledge_entities WHERE user_id = ? AND deleted_at IS NULL').get(userId).count;
    const relationCount = db.prepare("SELECT COUNT(*) AS count FROM knowledge_relations WHERE user_id = ? AND status = 'active'").get(userId).count;
    const mentionCount = db.prepare('SELECT COUNT(*) AS count FROM knowledge_entity_mentions WHERE user_id = ?').get(userId).count;
    const topTypes = db.prepare(`
        SELECT type, COUNT(*) AS count
        FROM knowledge_entities
        WHERE user_id = ? AND deleted_at IS NULL
        GROUP BY type
        ORDER BY count DESC, type ASC
        LIMIT 12
    `).all(userId);
    return { entities: entityCount, relations: relationCount, mentions: mentionCount, topTypes };
}

function listEntities({ userId, query = '', type = '', limit = 50, offset = 0 }) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const where = ['e.user_id = ?', 'e.deleted_at IS NULL'];
    const params = [userId];
    const normalizedQuery = normalizeEntityName(query);
    if (normalizedQuery) {
        where.push('(e.normalized_name LIKE ? OR e.name LIKE ?)');
        params.push(`%${normalizedQuery}%`, `%${String(query).trim()}%`);
    }
    if (type) {
        where.push('e.type = ?');
        params.push(type);
    }
    const whereSql = where.join(' AND ');
    const data = db.prepare(`
        SELECT e.*,
            COUNT(DISTINCT m.id) AS mention_count,
            COUNT(DISTINCT r1.id) + COUNT(DISTINCT r2.id) AS relation_count
        FROM knowledge_entities e
        LEFT JOIN knowledge_entity_mentions m ON m.entity_id = e.id
        LEFT JOIN knowledge_relations r1 ON r1.source_entity_id = e.id AND r1.status = 'active'
        LEFT JOIN knowledge_relations r2 ON r2.target_entity_id = e.id AND r2.status = 'active'
        WHERE ${whereSql}
        GROUP BY e.id
        ORDER BY relation_count DESC, mention_count DESC, e.updated_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM knowledge_entities e WHERE ${whereSql}`).get(...params).count;
    return { data, total, limit: safeLimit, offset: safeOffset };
}

function getEntityGraph({ userId, entityId, depth = 1, limit = 80 }) {
    const entity = db.prepare('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(entityId, userId);
    if (!entity) return null;
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 80, 10), 300);
    const relations = db.prepare(`
        SELECT r.*, s.name AS source_name, s.type AS source_type, t.name AS target_name, t.type AS target_type,
               d.name AS doc_name, c.content AS chunk_text
        FROM knowledge_relations r
        JOIN knowledge_entities s ON s.id = r.source_entity_id
        JOIN knowledge_entities t ON t.id = r.target_entity_id
        LEFT JOIN knowledge_docs d ON d.id = r.source_doc_id
        LEFT JOIN knowledge_chunks c ON c.id = r.source_chunk_id
        WHERE r.user_id = ?
          AND r.status = 'active'
          AND (r.source_entity_id = ? OR r.target_entity_id = ?)
        ORDER BY r.confidence DESC, r.updated_at DESC
        LIMIT ?
    `).all(userId, entity.id, entity.id, safeLimit);
    const nodeMap = new Map([[entity.id, entity]]);
    relations.forEach(row => {
        nodeMap.set(row.source_entity_id, { id: row.source_entity_id, name: row.source_name, type: row.source_type });
        nodeMap.set(row.target_entity_id, { id: row.target_entity_id, name: row.target_name, type: row.target_type });
    });
    return {
        center: entity,
        depth: Math.min(Math.max(Number.parseInt(depth, 10) || 1, 1), 2),
        nodes: Array.from(nodeMap.values()),
        relations
    };
}

function listRelations({ userId, entityId = null, relationType = '', limit = 100, offset = 0 }) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 300);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const where = ["r.user_id = ?", "r.status = 'active'"];
    const params = [userId];
    const safeEntityId = Number.parseInt(entityId, 10);
    if (Number.isSafeInteger(safeEntityId) && safeEntityId > 0) {
        where.push('(r.source_entity_id = ? OR r.target_entity_id = ?)');
        params.push(safeEntityId, safeEntityId);
    }
    if (relationType) {
        where.push('r.relation_type = ?');
        params.push(String(relationType).trim());
    }
    const whereSql = where.join(' AND ');
    const data = db.prepare(`
        SELECT r.*, s.name AS source_name, s.type AS source_type, t.name AS target_name, t.type AS target_type,
               d.name AS doc_name
        FROM knowledge_relations r
        JOIN knowledge_entities s ON s.id = r.source_entity_id
        JOIN knowledge_entities t ON t.id = r.target_entity_id
        LEFT JOIN knowledge_docs d ON d.id = r.source_doc_id
        WHERE ${whereSql}
        ORDER BY r.confidence DESC, r.updated_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM knowledge_relations r WHERE ${whereSql}`).get(...params).count;
    return { data, total, limit: safeLimit, offset: safeOffset };
}

function findQueryEntities(userId, query, limit = GRAPH_CONTEXT_ENTITY_LIMIT) {
    const terms = buildRagSearchTerms(query, 20);
    if (terms.length === 0) return [];
    const rows = db.prepare(`
        SELECT e.*, COUNT(m.id) AS mention_count
        FROM knowledge_entities e
        LEFT JOIN knowledge_entity_mentions m ON m.entity_id = e.id
        WHERE e.user_id = ? AND e.deleted_at IS NULL
        GROUP BY e.id
    `).all(userId);
    return rows
        .map(row => {
            const haystack = `${row.name} ${row.normalized_name} ${row.aliases || ''}`.toLowerCase();
            const score = terms.reduce((acc, term) => acc + (haystack.includes(String(term).toLowerCase()) ? Math.min(String(term).length, 6) : 0), 0);
            return { ...row, graphScore: score };
        })
        .filter(row => row.graphScore > 0)
        .sort((a, b) => b.graphScore - a.graphScore || Number(b.mention_count || 0) - Number(a.mention_count || 0))
        .slice(0, limit);
}

function getGraphContextForQuery(userId, query, options = {}) {
    const entities = findQueryEntities(userId, query, options.entityLimit || GRAPH_CONTEXT_ENTITY_LIMIT);
    if (entities.length === 0) return { entities: [], relations: [], chunkIds: [], context: '' };
    const entityIds = entities.map(entity => entity.id);
    const placeholders = entityIds.map(() => '?').join(',');
    const relations = db.prepare(`
        SELECT r.*, s.name AS source_name, t.name AS target_name, d.name AS doc_name
        FROM knowledge_relations r
        JOIN knowledge_entities s ON s.id = r.source_entity_id
        JOIN knowledge_entities t ON t.id = r.target_entity_id
        LEFT JOIN knowledge_docs d ON d.id = r.source_doc_id
        WHERE r.user_id = ?
          AND r.status = 'active'
          AND (r.source_entity_id IN (${placeholders}) OR r.target_entity_id IN (${placeholders}))
        ORDER BY r.confidence DESC, r.updated_at DESC
        LIMIT ?
    `).all(userId, ...entityIds, ...entityIds, options.relationLimit || GRAPH_CONTEXT_RELATION_LIMIT);
    const chunkIds = [...new Set(relations.map(row => row.source_chunk_id).filter(Boolean))];
    return {
        entities,
        relations,
        chunkIds,
        context: formatGraphContext({ entities, relations })
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
        .map((row, index) => `[关系 ${index + 1} | 来源: ${row.doc_name || '知识图谱'}]: ${row.source_name} -${row.relation_type}-> ${row.target_name}${row.description ? `；依据: ${String(row.description).slice(0, 120)}` : ''}`)
        .join('\n');
    return `\n\n【参考知识图谱信息如下】：\n相关实体：${entityText || '-'}\n${relationText}\n请结合上述实体关系与知识库引用回答；如果实体关系不足以支撑结论，请明确说明依据不足。\n`;
}

function updateEntity({ userId, entityId, patch }) {
    const current = db.prepare('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(entityId, userId);
    if (!current) return null;
    const name = cleanEntityName(patch.name ?? current.name);
    const normalized = normalizeEntityName(name);
    const type = String(patch.type || current.type || 'concept').slice(0, 40);
    const description = String(patch.description ?? current.description ?? '').slice(0, 1000);
    const aliases = Array.isArray(patch.aliases)
        ? JSON.stringify(patch.aliases.map(cleanEntityName).filter(Boolean).slice(0, 20))
        : current.aliases;
    db.prepare(`
        UPDATE knowledge_entities
        SET name = ?, normalized_name = ?, type = ?, description = ?, aliases = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(name, normalized, type, description, aliases, getBeijingTimestamp(), entityId, userId);
    return db.prepare('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ?').get(entityId, userId);
}

function mergeEntities({ userId, sourceEntityId, targetEntityId }) {
    const sourceId = Number.parseInt(sourceEntityId, 10);
    const targetId = Number.parseInt(targetEntityId, 10);
    if (!Number.isSafeInteger(sourceId) || !Number.isSafeInteger(targetId) || sourceId <= 0 || targetId <= 0 || sourceId === targetId) return null;
    const source = db.prepare('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(sourceId, userId);
    const target = db.prepare('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(targetId, userId);
    if (!source || !target) return null;
    const tx = db.transaction(() => {
        db.prepare('UPDATE OR IGNORE knowledge_entity_mentions SET entity_id = ? WHERE entity_id = ?').run(targetId, sourceId);
        db.prepare('DELETE FROM knowledge_entity_mentions WHERE entity_id = ?').run(sourceId);
        db.prepare('UPDATE OR IGNORE knowledge_relations SET source_entity_id = ?, updated_at = ? WHERE source_entity_id = ?').run(targetId, getBeijingTimestamp(), sourceId);
        db.prepare('DELETE FROM knowledge_relations WHERE source_entity_id = ?').run(sourceId);
        db.prepare('UPDATE OR IGNORE knowledge_relations SET target_entity_id = ?, updated_at = ? WHERE target_entity_id = ?').run(targetId, getBeijingTimestamp(), sourceId);
        db.prepare('DELETE FROM knowledge_relations WHERE target_entity_id = ?').run(sourceId);
        db.prepare('DELETE FROM knowledge_relations WHERE source_entity_id = target_entity_id').run();
        const aliases = new Set();
        try { JSON.parse(target.aliases || '[]').forEach(alias => aliases.add(alias)); } catch (_) {}
        aliases.add(source.name);
        db.prepare('UPDATE knowledge_entities SET aliases = ?, updated_at = ?, deleted_at = ? WHERE id = ? AND user_id = ?')
            .run(JSON.stringify([...aliases].slice(0, 20)), getBeijingTimestamp(), getBeijingTimestamp(), sourceId, userId);
    });
    tx();
    return getEntityGraph({ userId, entityId: targetId });
}

function updateRelation({ userId, relationId, patch }) {
    const current = db.prepare("SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ? AND status = 'active'").get(relationId, userId);
    if (!current) return null;
    db.prepare(`
        UPDATE knowledge_relations
        SET relation_type = ?, description = ?, confidence = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(
        String(patch.relationType || current.relation_type || 'related_to').slice(0, 60),
        String(patch.description ?? current.description ?? '').slice(0, 1000),
        Math.min(Math.max(Number(patch.confidence ?? current.confidence ?? 0.6), 0), 1),
        getBeijingTimestamp(),
        relationId,
        userId
    );
    return db.prepare('SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ?').get(relationId, userId);
}

function deleteRelation({ userId, relationId }) {
    return db.prepare("UPDATE knowledge_relations SET status = 'deleted', updated_at = ? WHERE id = ? AND user_id = ?")
        .run(getBeijingTimestamp(), relationId, userId).changes > 0;
}

function rebuildGraphForDocument({ userId, docId }) {
    const doc = db.prepare("SELECT * FROM knowledge_docs WHERE id = ? AND user_id = ? AND deleted_at IS NULL").get(docId, userId);
    if (!doc) return null;
    const chunks = db.prepare('SELECT id AS chunkId, content FROM knowledge_chunks WHERE doc_id = ? ORDER BY id ASC').all(docId);
    clearKnowledgeGraphForDocument(docId);
    const result = indexKnowledgeGraphForChunks({ userId, docId, chunks });
    return { docId, ...result };
}

function safeIndexKnowledgeGraphForChunks(payload) {
    try {
        return indexKnowledgeGraphForChunks(payload);
    } catch (e) {
        logger.warn({ err: e.message, docId: payload?.docId }, 'Knowledge graph indexing skipped for document batch');
        return { entities: 0, relations: 0, error: e.message };
    }
}

module.exports = {
    clearKnowledgeGraphForDocument,
    deleteRelation,
    extractEntitiesFromText,
    extractKnowledgeGraph,
    extractRelationsFromText,
    findQueryEntities,
    formatGraphContext,
    getEntityGraph,
    getGraphContextForQuery,
    getGraphSummary,
    indexKnowledgeGraphForChunks,
    listEntities,
    listRelations,
    mergeEntities,
    normalizeEntityName,
    rebuildGraphForDocument,
    safeIndexKnowledgeGraphForChunks,
    updateEntity,
    updateRelation,
    upsertEntity
};
