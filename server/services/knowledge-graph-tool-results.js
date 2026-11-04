'use strict';

const { resolveKnowledgeToolScope, presentKnowledgeResult, revalidateKnowledgeToolEvidence, digest } = require('./knowledge-tool-results');

function graphUnavailable() {
    return Object.assign(new Error('知识图谱检索服务暂不可用，请稍后重试。'), { code: 'KNOWLEDGE_RETRIEVAL_UNAVAILABLE', status: 503, category: 'execution' });
}

function boundedLimit(value, fallback, maximum) {
    return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), maximum);
}

function relationMatchesChunk(relation, row) {
    if (Number(relation.source_chunk_id) !== Number(row.chunk_id) || Number(relation.source_doc_id) !== Number(row.doc_id)) return false;
    const hash = String(relation.excerpt_hash || '');
    const excerpt = String(relation.excerpt_text || '');
    return hash === `sha256:${digest(row.content || '')}`
        || Boolean(excerpt && String(row.content || '').includes(excerpt) && hash === `sha256:${digest(excerpt)}`);
}

async function executeKnowledgeGraphQuery(input, user, context = {}, deps = {}) {
    const query = String(input.query || '').trim();
    if (!query) throw new Error('请填写知识图谱查询问题。');
    const scope = await resolveKnowledgeToolScope(user, input, context, deps);
    let graph, rows;
    try {
        graph = await (deps.queryKnowledgeGraph || require('./knowledge-graph').queryKnowledgeGraph)({ userId: user.id, user, query, scope,
            entityLimit: boundedLimit(input.entityLimit, 6, 10), relationLimit: boundedLimit(input.relationLimit, 12, 20) });
        const chunkIds = [...new Set((graph.relations || []).map(row => Number(row.source_chunk_id)).filter(id => Number.isSafeInteger(id) && id > 0))];
        rows = await (deps.readSourceChunks || require('../repositories/knowledge').readSourceChunks)(chunkIds, user, scope);
    } catch (_) { throw graphUnavailable(); }

    // 图谱原始上下文可能包含已失效的实体描述，只从当前可访问片段重建交付内容。
    const evidence = [...new Set((graph.relations || []).map(row => Number(row.source_chunk_id)))].map(chunkId => ({ chunkId, selected: true }));
    const result = presentKnowledgeResult(query, { evidence }, rows.filter(row => row.citation_key && (graph.relations || [])
        .some(relation => relationMatchesChunk(relation, row))));
    let current;
    try { current = await revalidateKnowledgeToolEvidence([{ output: result }], user, { ...deps, scope }); }
    catch (_) { throw graphUnavailable(); }
    if (!current) {
        result.matches = []; result.sources = []; result.context = '';
        result.retrieval = { ...result.retrieval, status: 'blocked', reasonCode: 'KNOWLEDGE_SOURCE_UNAVAILABLE', selectedCount: 0 };
    }
    const sourcesByChunk = new Map(result.sources.map(source => [source.chunkId, source]));
    const rowsByChunk = new Map(rows.map(row => [Number(row.chunk_id), row]));
    const relations = (graph.relations || []).flatMap(row => {
        const source = sourcesByChunk.get(Number(row.source_chunk_id));
        if (!source || !relationMatchesChunk(row, rowsByChunk.get(source.chunkId))) return [];
        return [{ id: row.id, source_entity_id: row.source_entity_id, target_entity_id: row.target_entity_id,
            source_name: String(row.source_name || '').slice(0, 200), target_name: String(row.target_name || '').slice(0, 200),
            relation_type: String(row.relation_type || '').slice(0, 80), description: String(row.description || '').slice(0, 1200),
            confidence: Math.min(Math.max(Number(row.confidence) || 0, 0), 1), source_doc_id: source.legacyDocumentId,
            source_chunk_id: source.chunkId, doc_name: source.title, source }];
    });
    const paths = relations.map(row => ({ relationId: row.id, source: row.source_name, relationType: row.relation_type, target: row.target_name,
        confidence: row.confidence, docName: row.doc_name, chunkId: row.source_chunk_id, description: row.description, locator: row.source.locator, citationKey: row.source.citationKey }));
    const entities = new Map();
    for (const row of relations) {
        entities.set(row.source_entity_id, { id: row.source_entity_id, name: row.source_name });
        entities.set(row.target_entity_id, { id: row.target_entity_id, name: row.target_name });
    }
    return { ...result, extractionMode: 'rule_heuristic', qualityNotice: '图谱关系是辅助线索，请结合所附原文与引用核对。',
        matches: result.matches.map(match => ({ ...match, graphPaths: paths.filter(path => path.chunkId === match.source.chunkId) })),
        entities: [...entities.values()], relations, paths, chunkIds: result.sources.map(source => source.chunkId),
        sourceDocIds: [...new Set(result.sources.map(source => source.legacyDocumentId))],
        answerHint: paths.length ? '已找到附带来源的关系线索，请结合引用原文回答。' : '未找到可引用关系，请补充资料或使用文本检索。' };
}

module.exports = { executeKnowledgeGraphQuery };
