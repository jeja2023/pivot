'use strict';

const crypto = require('crypto');
const { normalizeRetrievalScope } = require('./rag-index/retrieval-scope-builder');
const { parseJsonObject } = require('./agent-validators');

function intersectScopes(...values) {
    const scopes = values.map(value => normalizeRetrievalScope(value || {}));
    const result = {};
    for (const key of ['collectionIds', 'tagNames', 'verifiedStatuses', 'lifecycleStatuses', 'sourceKinds', 'ownerUnits']) {
        const lists = scopes.map(scope => scope[key]).filter(list => list.length);
        if (!lists.length) continue;
        result[key] = lists.reduce((left, right) => left.filter(item => right.includes(item)));
        if (!result[key].length) throw scopeError();
    }
    result.updatedAfter = scopes.map(scope => scope.updatedAfter).filter(Boolean).sort().at(-1) || '';
    return result;
}

function scopeError() { return Object.assign(new Error('知识库选择范围不可用或超出本次任务范围，请重新选择资料。'), { code: 'KNOWLEDGE_SCOPE_DENIED', status: 403, category: 'policy' }); }

async function resolveKnowledgeToolScope(user, input = {}, context = {}, deps = {}) {
    const run = context.run || {};
    const metadata = parseJsonObject(run.metadata) || {};
    const config = parseJsonObject(run.context_config || run.contextConfig) || {};
    const requested = { collectionIds: input.collectionIds, tagNames: input.tagNames };
    if (Array.isArray(input.collectionIds) && input.collectionIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw scopeError();
    if ((Array.isArray(input.collectionIds) && input.collectionIds.length > 50) || (Array.isArray(input.tagNames) && input.tagNames.length > 20)) throw scopeError();
    const scope = intersectScopes(metadata.chatBridge?.ragScope, { collectionIds: config.collectionIds }, requested);
    const getCollection = deps.getCollectionForUser || require('../repositories/knowledge').getCollectionForUser;
    for (const id of scope.collectionIds || []) if (!await getCollection(id, user)) throw scopeError();
    return scope;
}

function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function presentKnowledgeResult(query, result, rows) {
    const selected = result.evidence || (result.matches || []).filter(match => match.selected === true);
    const byId = new Map(rows.map(row => [Number(row.chunk_id), row]));
    const sources = [];
    const matches = [];
    for (const match of selected.slice(0, 10)) {
        const row = byId.get(Number(match.chunkId));
        if (!row) continue;
        const content = String(row.content || '');
        const text = content.slice(0, 1600);
        const locator = { charStart: row.char_start == null ? null : Number(row.char_start), charEnd: row.char_end == null ? null : Number(row.char_end) };
        const coverage = parseJsonObject(row.extraction_coverage_json) || {};
        const source = { index: sources.length + 1, kind: 'knowledge', legacyDocumentId: Number(row.doc_id), collectionId: row.collection_id == null ? null : Number(row.collection_id),
            documentId: row.document_id == null ? null : Number(row.document_id), versionId: row.version_id == null ? null : Number(row.version_id),
            blockId: row.block_id == null ? null : Number(row.block_id), chunkId: Number(row.chunk_id), citationKey: String(row.citation_key || ''),
            title: String(row.name || '').slice(0, 200), locator, contentDigest: digest(content), excerptDigest: digest(text), truncated: text.length < content.length,
            indexVersion: String(row.index_fingerprint || '').slice(0, 180), coverage: { known: typeof coverage.complete === 'boolean', complete: coverage.complete === true,
                sourcePageCount: Number(coverage.sourcePageCount) || null, processedPages: Number(coverage.processedPages) || null } };
        sources.push(source);
        matches.push({ docName: source.title, score: Number(match.score || match.denseScore || 0), hit: true, content: text, source });
    }
    const degraded = result.ranking?.mode === 'keyword_fallback' || Boolean(result.ranking?.degradedPaths?.length);
    const unavailable = selected.slice(0, 10).length > matches.length;
    const context = matches.length ? require('./rag-index/retrieval-context').formatInjectedContext(matches.map(match => ({ text: match.content,
        source: match.docName, citationKey: match.source.citationKey }))) : '';
    return { knowledgeSourceVersion: 1, query, matches, sources, context,
        retrieval: { status: matches.length ? (degraded || unavailable ? 'partial' : 'succeeded') : 'blocked',
            reasonCode: matches.length ? (unavailable ? 'KNOWLEDGE_SOURCE_UNAVAILABLE' : degraded ? 'KNOWLEDGE_LEXICAL_FALLBACK' : 'KNOWLEDGE_MATCHED') : selected.length ? 'KNOWLEDGE_SOURCE_UNAVAILABLE' : 'KNOWLEDGE_NO_RELIABLE_MATCH',
            selectedCount: matches.length, coverage: 'retrieved_excerpts', completeDocument: false },
        metrics: result.metrics || null };
}

function knowledgeEvidenceManifest(value) {
    if (value?.type === 'tools_batch_read') return require('./knowledge-evidence-lineage').evidenceOf(value);
    if (value?.knowledgeEvidence) return knowledgeEvidenceManifest(value.knowledgeEvidence);
    if (value?.knowledgeSourceVersion !== 1 || !Array.isArray(value.sources)) return null;
    return { knowledgeSourceVersion: 1, sources: value.sources, retrieval: value.retrieval,
        ...(value.knowledgeEvidenceIncomplete ? { knowledgeEvidenceIncomplete: true } : {}) };
}

async function executeKnowledgeSearch(input, user, context = {}, deps = {}) {
    const query = String(input.query || '').trim();
    if (!query) throw new Error('请填写检索问题。');
    const scope = await resolveKnowledgeToolScope(user, input, context, deps);
    const retrieve = deps.debugRetrieveContext || require('./rag-index').debugRetrieveContext;
    let result;
    try { result = await retrieve(user.id, query, { topK: Math.min(Math.max(Number(input.topK) || 5, 1), 10), candidateLimit: Math.min(Math.max(Number(input.candidateLimit) || 80, 10), 200), scope, user }); }
    catch (_) { throw Object.assign(new Error('知识库检索服务暂不可用，请稍后重试。'), { code: 'KNOWLEDGE_RETRIEVAL_UNAVAILABLE', status: 503, category: 'execution' }); }
    if (result.ranking?.mode === 'retrieval_unavailable') throw Object.assign(new Error('知识库检索服务暂不可用，请稍后重试。'), { code: 'KNOWLEDGE_RETRIEVAL_UNAVAILABLE', status: 503, category: 'execution' });
    const selected = result.evidence || (result.matches || []).filter(match => match.selected === true);
    const rows = await (deps.readSourceChunks || require('../repositories/knowledge').readSourceChunks)(selected.map(match => match.chunkId), user, scope);
    return presentKnowledgeResult(query, result, rows);
}

async function revalidateKnowledgeToolEvidence(observations, user, deps = {}) {
    observations = (observations || []).map(item => ({ ...item, output: typeof item.output === 'string' ? parseJsonObject(item.output) : item.output }));
    observations = observations.map(item => ({ ...item, knowledgeEvidence: require('./knowledge-evidence-lineage').mergeKnowledgeEvidence(item.knowledgeEvidence, item.output) }));
    if ((observations || []).some(item => item.output?.knowledgeEvidenceIncomplete === true || item.knowledgeEvidence?.knowledgeEvidenceIncomplete || item.output?.knowledgeEvidence?.knowledgeEvidenceIncomplete)) return false;
    if (observations.some(item => item.output?.knowledgeSourceVersion === 1 && !item.output.sources?.length
        && (item.output.matches?.length || item.output.context || item.output.paths?.length || item.output.relations?.length || item.output.entities?.length))) return false;
    const allSources = (observations || []).flatMap(item => item.knowledgeEvidence?.knowledgeSourceVersion === 1 ? item.knowledgeEvidence.sources || []
        : item.output?.knowledgeEvidence?.knowledgeSourceVersion === 1 ? item.output.knowledgeEvidence.sources || []
            : item.output?.knowledgeSourceVersion === 1 ? item.output.sources || [] : []);
    const sources = [...new Map(allSources.map(source => [JSON.stringify(source), source])).values()];
    if (!sources.length) return true;
    if (sources.length > 1000) return false;
    if (sources.some(source => !source.citationKey || !source.contentDigest || !source.chunkId)) return false;
    const read = deps.readSourceChunks || require('../repositories/knowledge').readSourceChunks;
    const rows = [], ids = [...new Set(sources.map(source => source.chunkId))];
    for (let index = 0; index < ids.length; index += 100) rows.push(...await read(ids.slice(index, index + 100), user, deps.scope || {}));
    const current = sources.every(source => rows.some(row => Number(row.chunk_id) === Number(source.chunkId)
        && Number(row.doc_id) === Number(source.legacyDocumentId) && digest(row.content || '') === source.contentDigest
        && String(row.citation_key || '') === source.citationKey
        && [['documentId', 'document_id'], ['versionId', 'version_id'], ['blockId', 'block_id'], ['collectionId', 'collection_id']]
            .every(([key, column]) => source[key] == null || Number(source[key]) === Number(row[column]))
        && (!source.indexVersion || source.indexVersion === String(row.index_fingerprint || '').slice(0, 180))));
    if (!current) return false;
    const verify = deps.validateCitationKeys || require('../repositories/knowledge').validateCitationKeys;
    const keys = [...new Set(sources.map(source => source.citationKey).filter(Boolean))];
    for (let index = 0; index < keys.length; index += 100) if (!await verify(keys.slice(index, index + 100), user)) return false;
    return true;
}

async function presentKnowledgeSteps(steps, user, deps = {}) {
    return await Promise.all((steps || []).map(async step => {
        const output = typeof step.output === 'string' ? parseJsonObject(step.output) : step.output;
        if ((step.output == null && !['completed', 'continued_error', 'success'].includes(step.status))
            || (!['rag.search', 'knowledge.graph.query'].includes(step.tool_name) && output?.knowledgeSourceVersion !== 1 && !output?.knowledgeEvidence && !step.knowledge_evidence)) return step;
        const manifest = step.knowledge_evidence || output?.knowledgeEvidence || (output?.knowledgeSourceVersion === 1 ? output : null);
        let current = false;
        if (manifest?.knowledgeSourceVersion === 1 && Array.isArray(manifest.sources)) {
            try { current = await (deps.revalidate || revalidateKnowledgeToolEvidence)([{ output, knowledgeEvidence: manifest }], user); } catch (_) { /* 无法确认权限时隐藏历史结果。 */ }
        }
        if (current) return step;
        return { ...step, input: {}, knowledge_evidence: null, output: { knowledgeSourceVersion: 1, sources: [], retrieval: { status: 'blocked', reasonCode: 'KNOWLEDGE_SOURCE_UNAVAILABLE' } }, error_message: null };
    }));
}

module.exports = { intersectScopes, resolveKnowledgeToolScope, presentKnowledgeResult, executeKnowledgeSearch, knowledgeEvidenceManifest, revalidateKnowledgeToolEvidence, presentKnowledgeSteps, digest };
