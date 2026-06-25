const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { buildRagSearchTerms, normalizeSearchText } = require('./rag-tokenizer');
const { detectDocType } = require('./rag-chunker');

const MAX_ENTITIES_PER_CHUNK = 12;
const MAX_RELATIONS_PER_CHUNK = 16;
const GRAPH_CONTEXT_ENTITY_LIMIT = 6;
const GRAPH_CONTEXT_RELATION_LIMIT = 12;
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const GRAPH_DUPLICATE_PREFIX_MIN = 3;
const GRAPH_EXTRACTION_MODE = 'rule_heuristic';
const GRAPH_QUALITY_NOTICE = '知识图谱由规则和启发式抽取生成，适合作为 Graph-RAG 辅助线索；生产问答前建议确认低可信关系、合并重复实体，并结合来源文档校验。';

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
        collectionIds: normalizeGraphScopeIds(raw.collectionIds ?? raw.collectionId),
        tagNames: normalizeGraphScopeTags(raw.tagNames ?? raw.tagName ?? raw.tag)
    };
}

function buildGraphDocScopeClauses(normalized, docAlias) {
    const clauses = [`${docAlias}.user_id = e.user_id`, `${docAlias}.deleted_at IS NULL`];
    const params = [];
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
    if (!normalized.collectionIds.length && !normalized.tagNames.length) return { sql: '', params: [] };
    const mentionDocScope = buildGraphDocScopeClauses(normalized, 'd_scope');
    const sourceDocScope = buildGraphDocScopeClauses(normalized, 'sd_scope');
    return {
        sql: `
          AND (
              EXISTS (
                  SELECT 1
                  FROM knowledge_entity_mentions m_scope
                  JOIN knowledge_docs d_scope ON d_scope.id = m_scope.doc_id
                  WHERE m_scope.entity_id = e.id
                    AND ${mentionDocScope.clauses.join(' AND ')}
              )
              OR EXISTS (
                  SELECT 1
                  FROM knowledge_docs sd_scope
                  WHERE sd_scope.id = e.source_doc_id
                    AND ${sourceDocScope.clauses.join(' AND ')}
              )
          )`,
        params: [...mentionDocScope.params, ...sourceDocScope.params]
    };
}

function buildGraphRelationScopeSql(scope, docAlias = 'd') {
    const normalized = normalizeGraphScope(scope);
    if (!normalized.collectionIds.length && !normalized.tagNames.length) return { sql: '', params: [] };
    const clauses = [];
    const params = [];
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
    return {
        sql: ` AND ${clauses.join(' AND ')}`,
        params
    };
}

// 汉字基本区间 U+4E00–U+9FA5。用 String.fromCharCode 构造，避免在源码中散落生僻字或转义序列。
const HAN_RANGE = `${String.fromCharCode(0x4e00)}-${String.fromCharCode(0x9fa5)}`;
const HAN_TOKEN = `[${HAN_RANGE}A-Za-z0-9_.-]{2,40}`;

const ENTITY_SUFFIX_TYPES = [
    // 法规领域类型优先匹配（正则足够具体，避免误吞 IT/通用术语）。
    ['legal_doc', new RegExp(`(中华人民共和国[${HAN_RANGE}]{2,40}法|[${HAN_RANGE}]{2,40}条例|[${HAN_RANGE}]{2,40}准则)$`)],
    ['clause', /第[一二三四五六七八九十百千零〇两0-9]+(?:条|款|项)$/],
    ['obligation', /(义务|责任)$/],
    ['right', /(权利|权益)$/],
    ['penalty', /(罚则|处罚|罚款|追责)$/],
    ['subject', /(当事人|相对人|权利人|义务人|被申请人)$/],
    ['department', /(部门|中心|小组|团队|委员会|办公室|事业部|分公司|集团|公司)$/],
    ['system', /(系统|平台|服务|数据库|网关|接口|API|模型|知识库|控制台|门户)$/i],
    ['process', /(流程|工单|审批|审核|申请|报销|归档|发布|上线|巡检)$/],
    ['policy', /(制度|规范|办法|规定|指南|手册|预案|标准|条例|细则|政策)$/],
    ['project', /(项目|计划|工程|专项|版本|里程碑)$/],
    ['role', /(管理员|负责人|审批人|申请人|用户|客户|供应商|运维|开发|测试)$/]
];

// 通用关系（适用所有文档）。实体抽取也沿用此通用集，避免法规祈使句产生噪声实体。
const GENERIC_RELATION_PATTERNS = [
    { type: 'responsible_for', regex: new RegExp(`(${HAN_TOKEN})(?:负责|管理|维护|承接)(${HAN_TOKEN})`, 'g') },
    { type: 'belongs_to', regex: new RegExp(`(${HAN_TOKEN})(?:属于|隶属于|归口于)(${HAN_TOKEN})`, 'g') },
    { type: 'depends_on', regex: new RegExp(`(${HAN_TOKEN})(?:依赖|调用|接入|连接|使用)(${HAN_TOKEN})`, 'g') },
    { type: 'contains', regex: new RegExp(`(${HAN_TOKEN})(?:包含|包括|覆盖|由)(${HAN_TOKEN})`, 'g') },
    { type: 'affects', regex: new RegExp(`(${HAN_TOKEN})(?:影响|约束|支撑)(${HAN_TOKEN})`, 'g') }
];

// 法规领域关系（仅在法规类文档上叠加，避免跨域误抽）。
const LEGAL_RELATION_PATTERNS = [
    { type: 'applies_to', regex: new RegExp(`(${HAN_TOKEN})(?:适用于|适用)(${HAN_TOKEN})`, 'g') },
    { type: 'references', regex: new RegExp(`(${HAN_TOKEN})(?:依据|根据|引用|参照)(${HAN_TOKEN})`, 'g') },
    { type: 'supersedes', regex: new RegExp(`(${HAN_TOKEN})(?:废止|替代|取代|修订)(${HAN_TOKEN})`, 'g') },
    { type: 'prohibits', regex: new RegExp(`(${HAN_TOKEN})(?:禁止|不得)(${HAN_TOKEN})`, 'g') },
    { type: 'requires', regex: new RegExp(`(${HAN_TOKEN})(?:应当|必须|要求)(${HAN_TOKEN})`, 'g') }
];

// 实体抽取沿用通用动词集（保持既有行为）。
const RELATION_PATTERNS = GENERIC_RELATION_PATTERNS;

function relationPatternsForDocType(docType) {
    return docType === 'legal'
        ? GENERIC_RELATION_PATTERNS.concat(LEGAL_RELATION_PATTERNS)
        : GENERIC_RELATION_PATTERNS;
}

function normalizeEntityName(value) {
    return normalizeSearchText(value)
        .replace(/[^\p{L}\p{N}\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff_.-]+/gu, '')
        .trim();
}

function parseEntityAliases(value) {
    if (Array.isArray(value)) return value.map(cleanEntityName).filter(Boolean).slice(0, 20);
    try {
        const parsed = JSON.parse(String(value || '[]'));
        return Array.isArray(parsed) ? parsed.map(cleanEntityName).filter(Boolean).slice(0, 20) : [];
    } catch (_) {
        return String(value || '')
            .split(/[,，;；\n]/)
            .map(cleanEntityName)
            .filter(Boolean)
            .slice(0, 20);
    }
}

function buildAliasList(...values) {
    const aliases = new Set();
    values.flatMap(parseEntityAliases).forEach(alias => aliases.add(alias));
    return [...aliases].slice(0, 20);
}

function relationStatusForConfidence(confidence) {
    return Number(confidence || 0) < LOW_CONFIDENCE_THRESHOLD ? 'pending' : 'active';
}

function cleanEntityName(value) {
    let text = String(value || '')
        .replace(/^[\s"'“”‘’《》（）()【】[\]{}<>:：,，;；.。]+|[\s"'“”‘’《》（）()【】[\]{}<>:：,，;；.。]+$/g, '')
        .trim();
    // 去掉指代式前缀（该公司/本办法/上述部门→公司/办法/部门），保留双字以上实体名。
    text = text.replace(new RegExp(`^(?:该|本|上述|前述|该等|此)(?=[${HAN_RANGE}]{2,})`), '');
    text = text.split(/(?:负责|管理|维护|承接|属于|隶属于|归口于|依赖|调用|接入|连接|使用|包含|包括|覆盖|影响|适用于|适用|约束|支撑|依据|引用|参照|废止|替代|取代|修订|禁止|不得|应当|必须|要求)/)[0] || text;
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
    if (/(?:负责|管理|维护|承接|属于|隶属于|归口于|依赖|调用|接入|连接|使用|包含|包括|覆盖|影响|适用于|适用|约束|支撑|依据|引用|参照|废止|替代|取代|修订|禁止|不得|应当|必须|要求)/.test(text)) return false;
    if (/^(以及|或者|如果|因此|同时|需要|可以|进行|通过|相关|当前|必须|不得|应该|问题|该|本|上述|前述|此)$/.test(text)) return false;
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

    const suffixRegex = new RegExp(`([${HAN_RANGE}A-Za-z0-9_.-]{2,32}(?:部门|中心|小组|团队|委员会|办公室|事业部|集团|公司|系统|平台|服务|数据库|网关|接口|API|模型|知识库|流程|制度|规范|办法|规定|指南|手册|项目|计划|管理员|负责人))`, 'gi');
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

function extractRelationsFromText(text, entities, options = {}) {
    const patterns = Array.isArray(options.patterns) ? options.patterns : GENERIC_RELATION_PATTERNS;
    const limit = options.limit || MAX_RELATIONS_PER_CHUNK;
    const content = String(text || '').slice(0, 5000);
    const entityByNorm = new Map((entities || []).map(entity => [entity.normalizedName || normalizeEntityName(entity.name), entity]));
    const relations = [];
    const push = (sourceName, targetName, type, confidence, description = '') => {
        // 用与实体相同的清洗（去指代前缀/动词）后再归一，确保关系两端能对齐到实体键。
        const sourceNorm = normalizeEntityName(cleanEntityName(sourceName));
        const targetNorm = normalizeEntityName(cleanEntityName(targetName));
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

    patterns.forEach(({ type, regex }) => {
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

function extractKnowledgeGraph(text, docType = 'prose') {
    const entities = extractEntitiesFromText(text);
    const relations = extractRelationsFromText(text, entities, { patterns: relationPatternsForDocType(docType) });
    return { entities, relations };
}

// 将预编译语句提到逐实体/逐关系的索引循环（indexKnowledgeGraphForChunks）之外：
// 惰性编译一次并跨调用复用，避免每个分块重复编译相同 SQL。db 虽为模块级常量，
// 但惰性初始化可避免 require 加载顺序带来的问题。
let upsertEntityStmt = null;
let recordMentionStmt = null;
let upsertRelationStmt = null;

function upsertEntity({ userId, name, type = 'concept', confidence = 0.7, sourceDocId = null, description = '' }) {
    const normalized = normalizeEntityName(name);
    if (!normalized) return null;
    const now = getBeijingTimestamp();
    // ON CONFLICT DO UPDATE + RETURNING 让插入与更新两条路径都能在一次往返内拿到行 id
    //（SQLite 的 RETURNING 对两种路径都会触发）。
    upsertEntityStmt ||= db.prepare(`
        INSERT INTO knowledge_entities (user_id, name, normalized_name, type, description, confidence, source_doc_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, normalized_name) DO UPDATE SET
            name = CASE WHEN LENGTH(excluded.name) > LENGTH(knowledge_entities.name) THEN excluded.name ELSE knowledge_entities.name END,
            type = CASE WHEN knowledge_entities.type = 'concept' THEN excluded.type ELSE knowledge_entities.type END,
            confidence = MAX(knowledge_entities.confidence, excluded.confidence),
            updated_at = excluded.updated_at,
            deleted_at = NULL
        RETURNING *
    `);
    return upsertEntityStmt.get(userId, cleanEntityName(name), normalized, type, description, confidence, sourceDocId, now, now);
}

function recordMention({ userId, entityId, docId, chunkId, snippet = '' }) {
    recordMentionStmt ||= db.prepare(`
        INSERT OR IGNORE INTO knowledge_entity_mentions (user_id, entity_id, doc_id, chunk_id, snippet, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    recordMentionStmt.run(userId, entityId, docId, chunkId, String(snippet || '').slice(0, 500), getBeijingTimestamp());
}

function upsertRelation({ userId, sourceEntityId, targetEntityId, relationType, description = '', confidence = 0.6, sourceDocId = null, sourceChunkId = null }) {
    if (!sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId) return null;
    const now = getBeijingTimestamp();
    const status = relationStatusForConfidence(confidence);
    upsertRelationStmt ||= db.prepare(`
        INSERT INTO knowledge_relations (
            user_id, source_entity_id, target_entity_id, relation_type, description,
            confidence, source_doc_id, source_chunk_id, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, source_entity_id, target_entity_id, relation_type, source_chunk_id) DO UPDATE SET
            description = CASE WHEN excluded.description != '' THEN excluded.description ELSE knowledge_relations.description END,
            confidence = MAX(knowledge_relations.confidence, excluded.confidence),
            status = CASE
                WHEN knowledge_relations.status = 'deleted' THEN excluded.status
                WHEN knowledge_relations.status = 'active' THEN 'active'
                ELSE excluded.status
            END,
            updated_at = excluded.updated_at
    `);
    upsertRelationStmt.run(userId, sourceEntityId, targetEntityId, relationType, description, confidence, sourceDocId, sourceChunkId, status, now, now);
}

function indexKnowledgeGraphForChunks({ userId, docId, chunks }) {
    if (!userId || !docId || !Array.isArray(chunks) || chunks.length === 0) return { entities: 0, relations: 0 };
    let entityCount = 0;
    let relationCount = 0;
    // 按文档类型选择关系抽取规则集（法规文档叠加法规领域关系）。
    const docRow = db.prepare('SELECT name FROM knowledge_docs WHERE id = ?').get(docId) || {};
    const sampleText = chunks.slice(0, 24).map(item => item.content).join('\n');
    const docType = detectDocType(docRow.name || '', sampleText);
    const indexTransaction = db.transaction(() => {
        chunks.forEach(chunk => {
            const graph = extractKnowledgeGraph(chunk.content, docType);
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
    const pendingRelationCount = db.prepare("SELECT COUNT(*) AS count FROM knowledge_relations WHERE user_id = ? AND status = 'pending'").get(userId).count;
    const mentionCount = db.prepare('SELECT COUNT(*) AS count FROM knowledge_entity_mentions WHERE user_id = ?').get(userId).count;
    const orphanEntities = db.prepare(`
        SELECT COUNT(*) AS count
        FROM knowledge_entities e
        WHERE e.user_id = ? AND e.deleted_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM knowledge_relations r
              WHERE r.user_id = e.user_id
                AND r.status IN ('active', 'pending')
                AND (r.source_entity_id = e.id OR r.target_entity_id = e.id)
          )
    `).get(userId).count;
    const lowConfidenceRelations = db.prepare(`
        SELECT COUNT(*) AS count
        FROM knowledge_relations
        WHERE user_id = ? AND status IN ('active', 'pending') AND confidence < ?
    `).get(userId, LOW_CONFIDENCE_THRESHOLD).count;
    const sourceLessRelations = db.prepare(`
        SELECT COUNT(*) AS count
        FROM knowledge_relations
        WHERE user_id = ? AND status IN ('active', 'pending') AND source_doc_id IS NULL
    `).get(userId).count;
    const topTypes = db.prepare(`
        SELECT type, COUNT(*) AS count
        FROM knowledge_entities
        WHERE user_id = ? AND deleted_at IS NULL
        GROUP BY type
        ORDER BY count DESC, type ASC
        LIMIT 12
    `).all(userId);
    const duplicateSuggestions = suggestDuplicateEntities(userId, 5);
    const quality = buildGraphQualitySignals({
        entityCount,
        relationCount,
        mentionCount,
        pendingRelationCount,
        orphanEntities,
        lowConfidenceRelations,
        sourceLessRelations,
        duplicateSuggestions
    });
    return {
        extractionMode: GRAPH_EXTRACTION_MODE,
        qualityNotice: GRAPH_QUALITY_NOTICE,
        entities: entityCount,
        relations: relationCount,
        pendingRelations: pendingRelationCount,
        mentions: mentionCount,
        topTypes,
        quality,
        suggestions: quality.recommendations,
        duplicateSuggestions
    };
}

function listEntities({ userId, query = '', type = '', quality = '', limit = 50, offset = 0 }) {
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
    if (quality === 'orphan') {
        where.push(`NOT EXISTS (
            SELECT 1 FROM knowledge_relations r
            WHERE r.user_id = e.user_id
              AND r.status IN ('active', 'pending')
              AND (r.source_entity_id = e.id OR r.target_entity_id = e.id)
        )`);
    }
    if (quality === 'low') {
        where.push('e.confidence < ?');
        params.push(0.62);
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

function getEntityGraph({ userId, entityId, depth = 1, limit = 80, status = 'active', relationType = '' }) {
    const entity = db.prepare('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(entityId, userId);
    if (!entity) return null;
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 80, 10), 300);
    const statusList = normalizeRelationStatusFilter(status);
    const statusPlaceholders = statusList.map(() => '?').join(',');
    const relationWhere = ['r.user_id = ?', `r.status IN (${statusPlaceholders})`, '(r.source_entity_id = ? OR r.target_entity_id = ?)'];
    const params = [userId, ...statusList, entity.id, entity.id];
    if (relationType) {
        relationWhere.push('r.relation_type = ?');
        params.push(String(relationType).trim());
    }
    const relations = db.prepare(`
        SELECT r.*, s.name AS source_name, s.type AS source_type, t.name AS target_name, t.type AS target_type,
               d.name AS doc_name, c.content AS chunk_text
        FROM knowledge_relations r
        JOIN knowledge_entities s ON s.id = r.source_entity_id
        JOIN knowledge_entities t ON t.id = r.target_entity_id
        LEFT JOIN knowledge_docs d ON d.id = r.source_doc_id
        LEFT JOIN knowledge_chunks c ON c.id = r.source_chunk_id
        WHERE ${relationWhere.join(' AND ')}
        ORDER BY r.confidence DESC, r.updated_at DESC
        LIMIT ?
    `).all(...params, safeLimit);
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

function normalizeRelationStatusFilter(status = 'active') {
    const raw = String(status || 'active').trim();
    if (raw === 'all') return ['active', 'pending'];
    if (raw === 'pending') return ['pending'];
    if (raw === 'deleted') return ['deleted'];
    return ['active'];
}

function listRelations({ userId, entityId = null, relationType = '', status = 'active', minConfidence = null, docId = null, limit = 100, offset = 0 }) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 300);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const statusList = normalizeRelationStatusFilter(status);
    const where = ['r.user_id = ?', `r.status IN (${statusList.map(() => '?').join(',')})`];
    const params = [userId, ...statusList];
    const safeEntityId = Number.parseInt(entityId, 10);
    if (Number.isSafeInteger(safeEntityId) && safeEntityId > 0) {
        where.push('(r.source_entity_id = ? OR r.target_entity_id = ?)');
        params.push(safeEntityId, safeEntityId);
    }
    if (relationType) {
        where.push('r.relation_type = ?');
        params.push(String(relationType).trim());
    }
    const min = Number(minConfidence);
    if (Number.isFinite(min)) {
        where.push('r.confidence >= ?');
        params.push(Math.min(Math.max(min, 0), 1));
    }
    const safeDocId = Number.parseInt(docId, 10);
    if (Number.isSafeInteger(safeDocId) && safeDocId > 0) {
        where.push('r.source_doc_id = ?');
        params.push(safeDocId);
    }
    const whereSql = where.join(' AND ');
    const data = db.prepare(`
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
    `).all(...params, safeLimit, safeOffset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM knowledge_relations r WHERE ${whereSql}`).get(...params).count;
    return { data, total, limit: safeLimit, offset: safeOffset };
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

function suggestDuplicateEntities(userId, limit = 20) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
    const rows = db.prepare(`
        SELECT id, name, normalized_name, type, aliases, confidence, updated_at
        FROM knowledge_entities
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY type ASC, normalized_name ASC
    `).all(userId);
    const groups = new Map();
    rows.forEach(row => {
        const normalized = String(row.normalized_name || normalizeEntityName(row.name));
        const prefix = normalized.slice(0, Math.min(Math.max(GRAPH_DUPLICATE_PREFIX_MIN, 1), normalized.length));
        const aliases = parseEntityAliases(row.aliases).map(normalizeEntityName);
        const keys = new Set([
            `${row.type || 'concept'}:${prefix}`,
            ...aliases.map(alias => `${row.type || 'concept'}:${alias.slice(0, Math.min(GRAPH_DUPLICATE_PREFIX_MIN, alias.length))}`)
        ].filter(item => item && !item.endsWith(':')));
        keys.forEach(key => {
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        });
    });
    const seen = new Set();
    const suggestions = [];
    groups.forEach(items => {
        const unique = [];
        const localSeen = new Set();
        items.forEach(item => {
            if (localSeen.has(item.id)) return;
            localSeen.add(item.id);
            unique.push(item);
        });
        if (unique.length < 2) return;
        const signature = unique.map(item => item.id).sort((a, b) => a - b).join(',');
        if (seen.has(signature)) return;
        seen.add(signature);
        suggestions.push({
            entities: unique.slice(0, 6),
            reason: '名称前缀或别名相近',
            suggestedTargetId: unique.slice().sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0].id
        });
    });
    return suggestions.slice(0, safeLimit);
}

// 在 JS 打分前，最多从 SQL 拉取的候选实体数量上限。
const QUERY_ENTITY_CANDIDATE_LIMIT = 200;

function findQueryEntities(userId, query, limit = GRAPH_CONTEXT_ENTITY_LIMIT, options = {}) {
    const terms = buildRagSearchTerms(query, 20);
    // 没有可用的查询词元：保持原有的空结果（不做全表扫描）。
    if (terms.length === 0) return [];
    const scopeFilter = buildGraphEntityScopeSql(options.scope);
    // 在 SQL 层预筛候选，避免每次 RAG 查询都拉取该用户的全部实体。每个词元都必须
    // 以子串形式出现在参与打分的某一列中，与下方 JS 打分逻辑一致，从而保持排序不变。
    const tokenClauses = [];
    const tokenParams = [];
    terms.forEach(term => {
        const like = `%${String(term).toLowerCase()}%`;
        tokenClauses.push('(LOWER(e.normalized_name) LIKE ? OR LOWER(e.name) LIKE ? OR LOWER(COALESCE(e.aliases, \'\')) LIKE ?)');
        tokenParams.push(like, like, like);
    });
    const rows = db.prepare(`
        SELECT e.*, COUNT(m.id) AS mention_count
        FROM knowledge_entities e
        LEFT JOIN knowledge_entity_mentions m ON m.entity_id = e.id
        WHERE e.user_id = ? AND e.deleted_at IS NULL
          AND (${tokenClauses.join(' OR ')})
        ${scopeFilter.sql}
        GROUP BY e.id
        LIMIT ?
    `).all(userId, ...tokenParams, ...scopeFilter.params, QUERY_ENTITY_CANDIDATE_LIMIT);
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
    const entities = findQueryEntities(userId, query, options.entityLimit || GRAPH_CONTEXT_ENTITY_LIMIT, options);
    if (entities.length === 0) return { entities: [], relations: [], chunkIds: [], context: '' };
    const entityIds = entities.map(entity => entity.id);
    const placeholders = entityIds.map(() => '?').join(',');
    const relationScope = buildGraphRelationScopeSql(options.scope, 'd');
    const relations = db.prepare(`
        SELECT r.*, s.name AS source_name, t.name AS target_name, d.name AS doc_name
        FROM knowledge_relations r
        JOIN knowledge_entities s ON s.id = r.source_entity_id
        JOIN knowledge_entities t ON t.id = r.target_entity_id
        LEFT JOIN knowledge_docs d ON d.id = r.source_doc_id
        WHERE r.user_id = ?
          AND r.status = 'active'
          AND (r.source_entity_id IN (${placeholders}) OR r.target_entity_id IN (${placeholders}))
          ${relationScope.sql}
        ORDER BY r.confidence DESC, r.updated_at DESC
        LIMIT ?
    `).all(userId, ...entityIds, ...entityIds, ...relationScope.params, options.relationLimit || GRAPH_CONTEXT_RELATION_LIMIT);
    const chunkIds = [...new Set(relations.map(row => row.source_chunk_id).filter(Boolean))];
    return {
        entities,
        relations,
        chunkIds,
        context: formatGraphContext({ entities, relations })
    };
}

function queryKnowledgeGraph({ userId, query, entityLimit = GRAPH_CONTEXT_ENTITY_LIMIT, relationLimit = GRAPH_CONTEXT_RELATION_LIMIT, scope = {} }) {
    const entities = findQueryEntities(userId, query, entityLimit, { scope });
    const graphContext = getGraphContextForQuery(userId, query, { entityLimit, relationLimit, scope });
    const paths = graphContext.relations.map(row => ({
        relationId: row.id,
        source: row.source_name,
        relationType: row.relation_type,
        target: row.target_name,
        confidence: row.confidence,
        docName: row.doc_name || '',
        chunkId: row.source_chunk_id || null,
        description: row.description || ''
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
    const aliases = patch.aliases !== undefined ? JSON.stringify(buildAliasList(patch.aliases)) : current.aliases;
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
    const current = db.prepare("SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ? AND status IN ('active', 'pending')").get(relationId, userId);
    if (!current) return null;
    const nextStatus = ['active', 'pending'].includes(String(patch.status || '').trim())
        ? String(patch.status).trim()
        : relationStatusForConfidence(patch.confidence ?? current.confidence);
    db.prepare(`
        UPDATE knowledge_relations
        SET relation_type = ?, description = ?, confidence = ?, status = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(
        String(patch.relationType || current.relation_type || 'related_to').slice(0, 60),
        String(patch.description ?? current.description ?? '').slice(0, 1000),
        Math.min(Math.max(Number(patch.confidence ?? current.confidence ?? 0.6), 0), 1),
        nextStatus,
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

function confirmRelation({ userId, relationId }) {
    const current = db.prepare("SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ? AND status = 'pending'").get(relationId, userId);
    if (!current) return null;
    db.prepare(`
        UPDATE knowledge_relations
        SET status = 'active', confidence = MAX(confidence, ?), updated_at = ?
        WHERE id = ? AND user_id = ?
    `).run(LOW_CONFIDENCE_THRESHOLD, getBeijingTimestamp(), relationId, userId);
    return db.prepare('SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ?').get(relationId, userId);
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
        logger.warn({ err: e.message, docId: payload?.docId }, '知识图谱已跳过文档批次索引');
        return { entities: 0, relations: 0, error: e.message };
    }
}

module.exports = {
    clearKnowledgeGraphForDocument,
    confirmRelation,
    deleteRelation,
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
    indexKnowledgeGraphForChunks,
    listEntities,
    listRelations,
    mergeEntities,
    normalizeEntityName,
    queryKnowledgeGraph,
    rebuildGraphForDocument,
    suggestDuplicateEntities,
    safeIndexKnowledgeGraphForChunks,
    updateEntity,
    updateRelation,
    upsertEntity
};
