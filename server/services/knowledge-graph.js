const { query, queryOne, execute } = require('../db/client');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { buildRagSearchTerms, normalizeSearchText } = require('./rag-tokenizer');
const { detectDocType } = require('./rag-chunker');
const knowledgeRepository = require('../repositories/knowledge');
const { buildDocumentAccessFilter } = require('./knowledge-access');

const MAX_ENTITIES_PER_CHUNK = 12;
const MAX_RELATIONS_PER_CHUNK = 16;
const GRAPH_CONTEXT_ENTITY_LIMIT = 6;
const GRAPH_CONTEXT_RELATION_LIMIT = 12;
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const GRAPH_DUPLICATE_PREFIX_MIN = 3;
const GRAPH_EXTRACTION_MODE = 'rule_heuristic';
const GRAPH_QUALITY_NOTICE = '知识图谱由规则和启发式抽取生成，适合作为 Graph-RAG 辅助线索；生产问答前建议确认低可信关系、合并重复实体，并结合来源文档校验。';

function buildGraphEntityAccessFilter(userOrId, alias = 'e') {
    const access = buildDocumentAccessFilter(userOrId, 'd_access', 'c_access');
    const ownId = access.params[0];
    return {
        sql: `(${alias}.user_id = ? OR EXISTS (
            SELECT 1
            FROM knowledge_entity_mentions m_access
            JOIN knowledge_docs d_access ON d_access.id = m_access.doc_id
            LEFT JOIN knowledge_collections c_access ON c_access.id = d_access.collection_id AND c_access.deleted_at IS NULL
            WHERE m_access.entity_id = ${alias}.id
              AND ${access.sql}
        ))`,
        params: [ownId, ...access.params]
    };
}

function buildGraphRelationAccessFilter(userOrId, alias = 'r') {
    const access = buildDocumentAccessFilter(userOrId, 'd_access', 'c_access');
    const ownId = access.params[0];
    return {
        sql: `(${alias}.user_id = ? OR EXISTS (
            SELECT 1
            FROM knowledge_docs d_access
            LEFT JOIN knowledge_collections c_access ON c_access.id = d_access.collection_id AND c_access.deleted_at IS NULL
            WHERE d_access.id = ${alias}.source_doc_id
              AND ${access.sql}
        ))`,
        params: [ownId, ...access.params]
    };
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
async function upsertEntity({ userId, name, type = 'concept', confidence = 0.7, sourceDocId = null, description = '' }) {
    const normalized = normalizeEntityName(name);
    if (!normalized) return null;
    const now = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO knowledge_entities (user_id, name, normalized_name, type, description, confidence, source_doc_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, normalized_name) DO UPDATE SET
            name = CASE WHEN LENGTH(EXCLUDED.name) > LENGTH(knowledge_entities.name) THEN EXCLUDED.name ELSE knowledge_entities.name END,
            type = CASE WHEN knowledge_entities.type = 'concept' THEN EXCLUDED.type ELSE knowledge_entities.type END,
            confidence = GREATEST(knowledge_entities.confidence, EXCLUDED.confidence),
            updated_at = EXCLUDED.updated_at,
            deleted_at = NULL
        RETURNING *
    `, [userId, cleanEntityName(name), normalized, type, description, confidence, sourceDocId, now, now]);
}

async function recordMention({ userId, entityId, docId, chunkId, snippet = '' }) {
    await execute(`
        INSERT INTO knowledge_entity_mentions (user_id, entity_id, doc_id, chunk_id, snippet, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
    `, [userId, entityId, docId, chunkId, String(snippet || '').slice(0, 500), getBeijingTimestamp()]);
}

async function upsertRelation({ userId, sourceEntityId, targetEntityId, relationType, description = '', confidence = 0.6, sourceDocId = null, sourceChunkId = null }) {
    if (!sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId) return null;
    const now = getBeijingTimestamp();
    const status = relationStatusForConfidence(confidence);
    await execute(`
        INSERT INTO knowledge_relations (
            user_id, source_entity_id, target_entity_id, relation_type, description,
            confidence, source_doc_id, source_chunk_id, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, source_entity_id, target_entity_id, relation_type, source_chunk_id) DO UPDATE SET
            description = CASE WHEN EXCLUDED.description != '' THEN EXCLUDED.description ELSE knowledge_relations.description END,
            confidence = GREATEST(knowledge_relations.confidence, EXCLUDED.confidence),
            status = CASE
                WHEN knowledge_relations.status = 'deleted' THEN EXCLUDED.status
                WHEN knowledge_relations.status = 'active' THEN 'active'
                ELSE EXCLUDED.status
            END,
            updated_at = EXCLUDED.updated_at
    `, [userId, sourceEntityId, targetEntityId, relationType, description, confidence, sourceDocId, sourceChunkId, status, now, now]);
}

async function indexKnowledgeGraphForChunks({ userId, docId, chunks }) {
    if (!userId || !docId || !Array.isArray(chunks) || chunks.length === 0) return { entities: 0, relations: 0 };
    let entityCount = 0;
    let relationCount = 0;
    const docRow = await knowledgeRepository.getDocumentName(docId);
    const sampleText = chunks.slice(0, 24).map(item => item.content).join('\n');
    const docType = detectDocType(docRow?.name || '', sampleText);
    for (const chunk of chunks) {
        const graph = extractKnowledgeGraph(chunk.content, docType);
        const entityRows = new Map();
        for (const entity of graph.entities) {
            const row = await upsertEntity({ userId, sourceDocId: docId, ...entity });
            if (!row) continue;
            entityRows.set(entity.normalizedName, row);
            await recordMention({
                userId,
                entityId: row.id,
                docId,
                chunkId: chunk.chunkId,
                snippet: chunk.content
            });
            entityCount += 1;
        }
        for (const relation of graph.relations) {
            const source = entityRows.get(normalizeEntityName(relation.sourceName));
            const target = entityRows.get(normalizeEntityName(relation.targetName));
            if (!source || !target) continue;
            await upsertRelation({
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
        }
    }
    return { entities: entityCount, relations: relationCount };
}

async function clearKnowledgeGraphForDocument(docId) {
    const chunkRows = await query('SELECT id FROM knowledge_chunks WHERE doc_id = ?', [docId]);
    const chunkIds = (chunkRows || []).map(row => row.id);
    if (chunkIds.length === 0) return;
    const placeholders = chunkIds.map(() => '?').join(',');
    await execute(`DELETE FROM knowledge_relations WHERE source_chunk_id IN (${placeholders})`, chunkIds);
    await execute(`DELETE FROM knowledge_entity_mentions WHERE chunk_id IN (${placeholders})`, chunkIds);
}

async function getGraphSummaryAsync(userOrId) {
    const entityAccess = buildGraphEntityAccessFilter(userOrId, 'e');
    const relationAccess = buildGraphRelationAccessFilter(userOrId, 'r');
    const userId = entityAccess.params[0];
    const entityRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_entities e WHERE ${entityAccess.sql} AND e.deleted_at IS NULL`, entityAccess.params);
    const entityCount = Number(entityRow?.count || 0);

    const relationRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_relations r WHERE ${relationAccess.sql} AND r.status = 'active'`, relationAccess.params);
    const relationCount = Number(relationRow?.count || 0);

    const pendingRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_relations r WHERE ${relationAccess.sql} AND r.status = 'pending'`, relationAccess.params);
    const pendingRelationCount = Number(pendingRow?.count || 0);

    const docAccess = buildDocumentAccessFilter(userOrId, 'd_access', 'c_access');
    const mentionRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_entity_mentions m WHERE m.user_id = ? OR EXISTS (SELECT 1 FROM knowledge_docs d_access LEFT JOIN knowledge_collections c_access ON c_access.id = d_access.collection_id AND c_access.deleted_at IS NULL WHERE d_access.id = m.doc_id AND ${docAccess.sql})`, [userId, ...docAccess.params]);
    const mentionCount = Number(mentionRow?.count || 0);

    const orphanRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM knowledge_entities e
        WHERE ${entityAccess.sql} AND e.deleted_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM knowledge_relations r
              WHERE ${relationAccess.sql.replace(/\br\./g, 'r.')}
                AND r.status IN ('active', 'pending')
                AND (r.source_entity_id = e.id OR r.target_entity_id = e.id)
          )
    `, [...entityAccess.params, ...relationAccess.params]);
    const orphanEntities = Number(orphanRow?.count || 0);

    const lowConfidenceRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM knowledge_relations r
        WHERE ${relationAccess.sql} AND status IN ('active', 'pending') AND confidence < ?
    `, [...relationAccess.params, LOW_CONFIDENCE_THRESHOLD]);
    const lowConfidenceRelations = Number(lowConfidenceRow?.count || 0);

    const sourceLessRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM knowledge_relations r
        WHERE ${relationAccess.sql} AND status IN ('active', 'pending') AND source_doc_id IS NULL
    `, relationAccess.params);
    const sourceLessRelations = Number(sourceLessRow?.count || 0);

    const topTypes = await query(`
        SELECT type, COUNT(*) AS count
        FROM knowledge_entities e
        WHERE ${entityAccess.sql} AND e.deleted_at IS NULL
        GROUP BY type
        ORDER BY count DESC, type ASC
        LIMIT 12
    `, entityAccess.params);

    const duplicateSuggestions = await suggestDuplicateEntities(userId, 5);
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
        topTypes: topTypes || [],
        quality,
        suggestions: quality.recommendations,
        duplicateSuggestions
    };
}

const getGraphSummary = getGraphSummaryAsync;

async function listEntities({ userId, user = null, query: queryText = '', type = '', quality = '', limit = 50, offset = 0 }) {
    const entityAccess = buildGraphEntityAccessFilter(user || userId, 'e');
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const where = [entityAccess.sql, 'e.deleted_at IS NULL'];
    const params = [...entityAccess.params];
    const normalizedQuery = normalizeEntityName(queryText);
    if (normalizedQuery) {
        where.push('(e.normalized_name LIKE ? OR e.name LIKE ?)');
        params.push(`%${normalizedQuery}%`, `%${String(queryText).trim()}%`);
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
    const relationAccess1 = buildGraphRelationAccessFilter(user || userId, 'r1');
    const relationAccess2 = buildGraphRelationAccessFilter(user || userId, 'r2');
    const data = await query(`
        SELECT e.*,
            COUNT(DISTINCT m.id) AS mention_count,
            COUNT(DISTINCT r1.id) + COUNT(DISTINCT r2.id) AS relation_count
        FROM knowledge_entities e
        LEFT JOIN knowledge_entity_mentions m ON m.entity_id = e.id
        LEFT JOIN knowledge_relations r1 ON r1.source_entity_id = e.id AND r1.status = 'active'
            AND (${relationAccess1.sql})
        LEFT JOIN knowledge_relations r2 ON r2.target_entity_id = e.id AND r2.status = 'active'
            AND (${relationAccess2.sql})
        WHERE ${whereSql}
        GROUP BY e.id
        ORDER BY relation_count DESC, mention_count DESC, e.updated_at DESC
        LIMIT ? OFFSET ?
    `, [...relationAccess1.params, ...relationAccess2.params, ...params, safeLimit, safeOffset]);
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM knowledge_entities e WHERE ${whereSql}`, params);
    const total = Number(totalRow?.count || 0);
    return { data: data || [], total, limit: safeLimit, offset: safeOffset };
}

async function getEntityGraph({ userId, user = null, entityId, depth = 1, limit = 80, status = 'active', relationType = '' }) {
    const entityAccess = buildGraphEntityAccessFilter(user || userId, 'e');
    const entity = await queryOne(`SELECT * FROM knowledge_entities e WHERE e.id = ? AND ${entityAccess.sql} AND e.deleted_at IS NULL`, [entityId, ...entityAccess.params]);
    if (!entity) return null;
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 80, 10), 300);
    const statusList = normalizeRelationStatusFilter(status);
    const statusPlaceholders = statusList.map(() => '?').join(',');
    const relationAccess = buildGraphRelationAccessFilter(user || userId, 'r');
    const relationWhere = [relationAccess.sql, `r.status IN (${statusPlaceholders})`, '(r.source_entity_id = ? OR r.target_entity_id = ?)'];
    const params = [...relationAccess.params, ...statusList, entity.id, entity.id];
    if (relationType) {
        relationWhere.push('r.relation_type = ?');
        params.push(String(relationType).trim());
    }
    const relations = await query(`
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
    `, [...params, safeLimit]);
    const nodeMap = new Map([[entity.id, entity]]);
    (relations || []).forEach(row => {
        nodeMap.set(row.source_entity_id, { id: row.source_entity_id, name: row.source_name, type: row.source_type });
        nodeMap.set(row.target_entity_id, { id: row.target_entity_id, name: row.target_name, type: row.target_type });
    });
    return {
        center: entity,
        depth: Math.min(Math.max(Number.parseInt(depth, 10) || 1, 1), 2),
        nodes: Array.from(nodeMap.values()),
        relations: relations || []
    };
}

function normalizeRelationStatusFilter(status = 'active') {
    const raw = String(status || 'active').trim();
    if (raw === 'all') return ['active', 'pending'];
    if (raw === 'pending') return ['pending'];
    if (raw === 'deleted') return ['deleted'];
    return ['active'];
}

async function listRelations({ userId, user = null, entityId = null, relationType = '', status = 'active', minConfidence = null, docId = null, limit = 100, offset = 0 }) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 300);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const statusList = normalizeRelationStatusFilter(status);
    const relationAccess = buildGraphRelationAccessFilter(user || userId, 'r');
    const where = [relationAccess.sql, `r.status IN (${statusList.map(() => '?').join(',')})`];
    const params = [...relationAccess.params, ...statusList];
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
    const groups = new Map();
    (rows || []).forEach(row => {
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

async function findQueryEntities(userId, queryText, limit = GRAPH_CONTEXT_ENTITY_LIMIT, options = {}) {
    const terms = buildRagSearchTerms(queryText, 20);
    if (terms.length === 0) return [];
    const scopeFilter = buildGraphEntityScopeSql(options.scope);
    const access = options.user ? buildDocumentAccessFilter(options.user, 'd_access', 'c_access') : null;
    const accessSql = access
        ? `AND (e.user_id = ? OR EXISTS (
                SELECT 1
                FROM knowledge_entity_mentions m_access
                JOIN knowledge_docs d_access ON d_access.id = m_access.doc_id
                LEFT JOIN knowledge_collections c_access ON c_access.id = d_access.collection_id AND c_access.deleted_at IS NULL
                WHERE m_access.entity_id = e.id AND ${access.sql}
            ))`
        : 'AND e.user_id = ?';
    const tokenClauses = [];
    const tokenParams = [];
    terms.slice(0, 8).forEach(term => {
        const like = `%${String(term).toLowerCase()}%`;
        tokenClauses.push('(LOWER(e.normalized_name) LIKE ? OR LOWER(e.name) LIKE ? OR LOWER(COALESCE(e.aliases, \'\')) LIKE ?)');
        tokenParams.push(like, like, like);
    });
    const rows = await query(`
        SELECT e.*, COUNT(m.id) AS mention_count
        FROM knowledge_entities e
        LEFT JOIN knowledge_entity_mentions m ON m.entity_id = e.id
        WHERE e.deleted_at IS NULL
          AND (${tokenClauses.join(' OR ')})
        ${scopeFilter.sql}
        ${accessSql}
        GROUP BY e.id
        LIMIT ?
    `, [
        ...tokenParams,
        ...scopeFilter.params,
        ...(options.user ? [userId, ...access.params] : [userId]),
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
    const relationScope = buildGraphRelationScopeSql(options.scope, 'd');
    const access = options.user ? buildDocumentAccessFilter(options.user, 'd_access', 'c_access') : null;
    const accessSql = access
        ? `AND (r.user_id = ? OR EXISTS (
                SELECT 1
                FROM knowledge_docs d_access
                LEFT JOIN knowledge_collections c_access ON c_access.id = d_access.collection_id AND c_access.deleted_at IS NULL
                WHERE d_access.id = r.source_doc_id AND ${access.sql}
            ))`
        : 'AND r.user_id = ?';
    const relations = await query(`
        SELECT r.*, s.name AS source_name, t.name AS target_name, d.name AS doc_name
        FROM knowledge_relations r
        JOIN knowledge_entities s ON s.id = r.source_entity_id
        JOIN knowledge_entities t ON t.id = r.target_entity_id
        LEFT JOIN knowledge_docs d ON d.id = r.source_doc_id
        WHERE r.status = 'active'
          AND (r.source_entity_id IN (${placeholders}) OR r.target_entity_id IN (${placeholders}))
          ${relationScope.sql}
          ${accessSql}
        ORDER BY r.confidence DESC, r.updated_at DESC
        LIMIT ?
    `, [
        ...entityIds,
        ...entityIds,
        ...relationScope.params,
        ...(options.user ? [userId, ...access.params] : [userId]),
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

function queryKnowledgeGraph({ userId, user = null, query, entityLimit = GRAPH_CONTEXT_ENTITY_LIMIT, relationLimit = GRAPH_CONTEXT_RELATION_LIMIT, scope = {} }) {
    const entities = findQueryEntities(userId, query, entityLimit, { scope, user });
    const graphContext = getGraphContextForQuery(userId, query, { entityLimit, relationLimit, scope, user });
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

async function updateEntity({ userId, entityId, patch }) {
    const current = await queryOne('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [entityId, userId]);
    if (!current) return null;
    const name = cleanEntityName(patch.name ?? current.name);
    const normalized = normalizeEntityName(name);
    const type = String(patch.type || current.type || 'concept').slice(0, 40);
    const description = String(patch.description ?? current.description ?? '').slice(0, 1000);
    const aliases = patch.aliases !== undefined ? JSON.stringify(buildAliasList(patch.aliases)) : current.aliases;
    await execute(`
        UPDATE knowledge_entities
        SET name = ?, normalized_name = ?, type = ?, description = ?, aliases = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [name, normalized, type, description, aliases, getBeijingTimestamp(), entityId, userId]);
    return await queryOne('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ?', [entityId, userId]);
}

async function mergeEntities({ userId, sourceEntityId, targetEntityId }) {
    const sourceId = Number.parseInt(sourceEntityId, 10);
    const targetId = Number.parseInt(targetEntityId, 10);
    if (!Number.isSafeInteger(sourceId) || !Number.isSafeInteger(targetId) || sourceId <= 0 || targetId <= 0 || sourceId === targetId) return null;
    const source = await queryOne('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [sourceId, userId]);
    const target = await queryOne('SELECT * FROM knowledge_entities WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [targetId, userId]);
    if (!source || !target) return null;
    
    await execute(`
        UPDATE knowledge_entity_mentions
        SET entity_id = ?
        WHERE entity_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM knowledge_entity_mentions m2
              WHERE m2.entity_id = ? AND m2.chunk_id = knowledge_entity_mentions.chunk_id
          )
    `, [targetId, sourceId, targetId]);
    await execute('DELETE FROM knowledge_entity_mentions WHERE entity_id = ?', [sourceId]);

    await execute(`
        UPDATE knowledge_relations
        SET source_entity_id = ?, updated_at = ?
        WHERE source_entity_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM knowledge_relations r2
              WHERE r2.source_entity_id = ? AND r2.target_entity_id = knowledge_relations.target_entity_id
                AND r2.relation_type = knowledge_relations.relation_type
                AND COALESCE(r2.source_chunk_id, 0) = COALESCE(knowledge_relations.source_chunk_id, 0)
          )
    `, [targetId, getBeijingTimestamp(), sourceId, targetId]);
    await execute('DELETE FROM knowledge_relations WHERE source_entity_id = ?', [sourceId]);

    await execute(`
        UPDATE knowledge_relations
        SET target_entity_id = ?, updated_at = ?
        WHERE target_entity_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM knowledge_relations r2
              WHERE r2.source_entity_id = knowledge_relations.source_entity_id AND r2.target_entity_id = ?
                AND r2.relation_type = knowledge_relations.relation_type
                AND COALESCE(r2.source_chunk_id, 0) = COALESCE(knowledge_relations.source_chunk_id, 0)
          )
    `, [targetId, getBeijingTimestamp(), sourceId, targetId]);
    await execute('DELETE FROM knowledge_relations WHERE target_entity_id = ?', [sourceId]);
    await execute('DELETE FROM knowledge_relations WHERE source_entity_id = target_entity_id');

    const aliases = new Set();
    try { JSON.parse(target.aliases || '[]').forEach(alias => aliases.add(alias)); } catch (_) {}
    aliases.add(source.name);
    await execute('UPDATE knowledge_entities SET aliases = ?, updated_at = ?, deleted_at = ? WHERE id = ? AND user_id = ?', [
        JSON.stringify([...aliases].slice(0, 20)), getBeijingTimestamp(), getBeijingTimestamp(), sourceId, userId
    ]);
    return await getEntityGraph({ userId, entityId: targetId });
}

async function updateRelation({ userId, relationId, patch }) {
    const current = await queryOne("SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ? AND status IN ('active', 'pending')", [relationId, userId]);
    if (!current) return null;
    const nextStatus = ['active', 'pending'].includes(String(patch.status || '').trim())
        ? String(patch.status).trim()
        : relationStatusForConfidence(patch.confidence ?? current.confidence);
    await execute(`
        UPDATE knowledge_relations
        SET relation_type = ?, description = ?, confidence = ?, status = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [
        String(patch.relationType || current.relation_type || 'related_to').slice(0, 60),
        String(patch.description ?? current.description ?? '').slice(0, 1000),
        Math.min(Math.max(Number(patch.confidence ?? current.confidence ?? 0.6), 0), 1),
        nextStatus,
        getBeijingTimestamp(),
        relationId,
        userId
    ]);
    return await queryOne('SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ?', [relationId, userId]);
}

async function deleteRelation({ userId, relationId }) {
    const result = await execute("UPDATE knowledge_relations SET status = 'deleted', updated_at = ? WHERE id = ? AND user_id = ?", [
        getBeijingTimestamp(), relationId, userId
    ]);
    return (result?.rowCount || result?.changes || 0) > 0;
}

async function confirmRelation({ userId, relationId }) {
    const current = await queryOne("SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ? AND status = 'pending'", [relationId, userId]);
    if (!current) return null;
    await execute(`
        UPDATE knowledge_relations
        SET status = 'active', confidence = GREATEST(confidence, ?), updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [LOW_CONFIDENCE_THRESHOLD, getBeijingTimestamp(), relationId, userId]);
    return await queryOne('SELECT * FROM knowledge_relations WHERE id = ? AND user_id = ?', [relationId, userId]);
}

async function rebuildGraphForDocument({ userId, docId }) {
    const doc = await queryOne("SELECT * FROM knowledge_docs WHERE id = ? AND user_id = ? AND deleted_at IS NULL", [docId, userId]);
    if (!doc) return null;
    const chunks = (await knowledgeRepository.listAllDocumentChunks(docId)) || [];
    await clearKnowledgeGraphForDocument(docId);
    const result = await indexKnowledgeGraphForChunks({ userId, docId, chunks });
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
