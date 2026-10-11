'use strict';

const { query, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { contentHash, normalizeId, normalizeText, parseJson } = require('./knowledge-wiki-compiler');
const { getAccessibleProductDocuments } = require('./knowledge-wiki-access');

function estimateWikiTokens(value = '') {
    const text = String(value || '');
    const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
    return Math.max(1, Math.ceil(han / 1.6 + (text.length - han) / 4));
}

function buildWikiTopicPlan(sources = [], maxTopics = 10, signals = {}) {
    const seen = new Set();
    const topics = [];
    const tagsByDocument = signals.tagsByDocument || new Map();
    const entitiesByDocument = signals.entitiesByDocument || new Map();
    const historicalTopics = Array.isArray(signals.historicalTopics) ? signals.historicalTopics : [];
    const append = (label, source, origin) => {
        const normalized = normalizeText(label, 160);
        const key = normalized.toLowerCase();
        if (!normalized || seen.has(key) || topics.length >= maxTopics) return;
        seen.add(key);
        topics.push({ label: normalized, documentTitle: source?.documentTitle || '', sourceId: source?.sourceId || '', origin });
    };
    for (const source of sources) {
        append(source.headingPath || source.documentTitle || '综合概览', source, 'heading');
        (tagsByDocument.get(Number(source.documentId)) || []).forEach(tag => append(tag, source, 'tag'));
        (entitiesByDocument.get(Number(source.documentId)) || []).forEach(entity => append(entity, source, 'entity'));
    }
    historicalTopics.forEach(topic => append(topic, null, 'history'));
    return topics;
}

function sourceTopicScore(row, terms = []) {
    const text = `${row.document_title || ''} ${row.heading_path || ''} ${row.content || ''}`.toLowerCase();
    return terms.reduce((score, term) => score + (text.includes(String(term).toLowerCase()) ? Math.min(String(term).length, 12) : 0), 0);
}

function selectWikiManifestSources(rows = [], { maxSourceBlocks = 12, maxInputTokens = 12000, topicTermsByDocument = new Map(), changedBlockKeys = new Set() } = {}) {
    const safeBlockLimit = Math.max(1, Math.min(Number.parseInt(maxSourceBlocks, 10) || 12, 30));
    const safeTokenBudget = Math.max(2048, Math.min(Number.parseInt(maxInputTokens, 10) || 12000, 64000));
    const byDocument = new Map();
    for (const row of rows) {
        const documentId = Number(row.document_id);
        if (!byDocument.has(documentId)) byDocument.set(documentId, []);
        byDocument.get(documentId).push(row);
    }
    byDocument.forEach((items, documentId) => {
        const terms = topicTermsByDocument.get(documentId) || [];
        items.sort((left, right) => Number(changedBlockKeys.has(`${right.document_id}:${right.version_id}:${right.block_id}`)) - Number(changedBlockKeys.has(`${left.document_id}:${left.version_id}:${left.block_id}`))
            || sourceTopicScore(right, terms) - sourceTopicScore(left, terms)
            || Number(left.block_id || 0) - Number(right.block_id || 0));
    });
    const documentQueues = [...byDocument.values()];
    const selected = [];
    let remainingTokens = safeTokenBudget;
    let cursor = 0;
    while (documentQueues.some(items => items.length) && selected.length < safeBlockLimit && remainingTokens > 0) {
        const queue = documentQueues[cursor % documentQueues.length];
        cursor += 1;
        const row = queue.shift();
        if (!row) continue;
        const maxChars = Math.max(800, Math.floor(remainingTokens * 1.6));
        const content = String(row.content || '').slice(0, Math.min(8000, maxChars));
        const tokenEstimate = estimateWikiTokens(content);
        if (!content || tokenEstimate > remainingTokens) continue;
        selected.push({
            documentId: Number(row.document_id), documentTitle: row.document_title,
            versionId: Number(row.version_id), versionNo: Number(row.version_no || 0), blockId: Number(row.block_id),
            chunkId: normalizeId(row.legacy_chunk_id), headingPath: row.heading_path || '', content,
            locator: parseJson(row.source_locator_json, {}), tokenEstimate,
            selectedReason: changedBlockKeys.has(`${row.document_id}:${row.version_id}:${row.block_id}`) ? 'changed_block'
                : (selected.filter(item => item.documentId === Number(row.document_id)).length === 0
                    ? 'document_diversity' : (sourceTopicScore(row, topicTermsByDocument.get(Number(row.document_id)) || []) > 0 ? 'topic_relevance' : 'topic_coverage'))
        });
        remainingTokens -= tokenEstimate;
    }
    return { sources: selected, tokenBudget: safeTokenBudget, usedTokens: safeTokenBudget - remainingTokens };
}

async function buildWikiCompileManifestForSpace({
    spaceId, user, maxSourceBlocks = 12, maxInputTokens = 12000, sourceDocumentIds = [], maxPages = 10
} = {}, deps = {}) {
    const getSpace = deps.getWikiSpaceForUser;
    const space = typeof getSpace === 'function' ? await getSpace(spaceId, user, deps) : null;
    if (!space) return null;
    const safeLimit = Math.max(1, Math.min(Number.parseInt(maxSourceBlocks, 10) || 12, 30));
    const scopedDocumentIds = [...new Set((Array.isArray(sourceDocumentIds) ? sourceDocumentIds : [sourceDocumentIds])
        .map(normalizeId).filter(Boolean))].slice(0, 100);
    const rows = await (deps.query || query)(`
        SELECT document.id AS document_id, document.title AS document_title, version.id AS version_id,
               version.version_no, block.id AS block_id, block.heading_path, block.content,
               block.source_locator_json, citation.legacy_chunk_id
        FROM knowledge_documents document
        JOIN knowledge_document_versions version ON version.id = document.current_version_id
        JOIN knowledge_blocks block ON block.version_id = version.id
        LEFT JOIN knowledge_citations citation ON citation.document_id = document.id
          AND citation.version_id = version.id AND citation.block_id = block.id
        WHERE document.collection_id = ? AND document.deleted_at IS NULL
          AND document.lifecycle_status = 'published' AND document.verified_status <> 'expired'
          ${scopedDocumentIds.length ? `AND document.id IN (${scopedDocumentIds.map(() => '?').join(',')})` : ''}
        ORDER BY document.updated_at DESC, document.id DESC, block.block_order ASC, block.id ASC LIMIT ?
    `, [space.collection_id, ...scopedDocumentIds, Math.max(safeLimit * 20, 200)]);
    const readableDocuments = await getAccessibleProductDocuments([...new Set(rows.map(row => normalizeId(row.document_id)).filter(Boolean))], user, deps);
    const readableRows = rows.filter(row => readableDocuments.has(normalizeId(row.document_id)));
    const readableIds = [...new Set(readableRows.map(row => normalizeId(row.document_id)).filter(Boolean))];
    const [tagRows, entityRows, historyRows] = readableIds.length ? await Promise.all([
        (deps.query || query)(`SELECT doc_id, ARRAY_AGG(DISTINCT tag ORDER BY tag) AS tags FROM knowledge_doc_tags WHERE doc_id IN (${readableIds.map(() => '?').join(',')}) GROUP BY doc_id`, readableIds),
        (deps.query || query)(`
            SELECT mention.doc_id, ARRAY_AGG(DISTINCT entity.name ORDER BY entity.name) AS entities
            FROM knowledge_entity_mentions mention
            JOIN knowledge_entities entity ON entity.id = mention.entity_id AND entity.deleted_at IS NULL
            WHERE mention.doc_id IN (${readableIds.map(() => '?').join(',')}) AND COALESCE(mention.source_state, 'active') = 'active'
            GROUP BY mention.doc_id
        `, readableIds),
        (deps.query || query)(`SELECT title, summary FROM knowledge_wiki_pages WHERE space_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 100`, [space.id])
    ]) : [[], [], []];
    const tagsByDocument = new Map(tagRows.map(row => [Number(row.doc_id), Array.isArray(row.tags) ? row.tags : parseJson(row.tags, [])]));
    const entitiesByDocument = new Map(entityRows.map(row => [Number(row.doc_id), Array.isArray(row.entities) ? row.entities : parseJson(row.entities, [])]));
    const historicalTopics = historyRows.flatMap(row => [row.title, row.summary]).map(value => normalizeText(value, 160)).filter(Boolean).slice(0, 30);
    const topicTermsByDocument = new Map(readableIds.map(id => [id, [
        ...(tagsByDocument.get(id) || []), ...(entitiesByDocument.get(id) || []), ...historicalTopics
    ].filter(Boolean).slice(0, 40)]));
    const priorSources = readableIds.length ? await (deps.query || query)(`
        SELECT source.document_id, source.version_id, source.block_id, source.excerpt_hash
        FROM knowledge_wiki_page_sources source
        JOIN knowledge_wiki_pages page ON page.id = source.wiki_page_id AND page.space_id = ? AND page.deleted_at IS NULL
        WHERE source.document_id IN (${readableIds.map(() => '?').join(',')})
    `, [space.id, ...readableIds]) : [];
    const knownBlocks = new Map();
    priorSources.forEach(source => {
        const key = `${source.document_id}:${source.version_id}:${source.block_id}`;
        if (!knownBlocks.has(key)) knownBlocks.set(key, new Set());
        knownBlocks.get(key).add(String(source.excerpt_hash || ''));
    });
    const changedBlockKeys = new Set(readableRows.filter(row => !knownBlocks.get(`${row.document_id}:${row.version_id}:${row.block_id}`)?.has(contentHash(row.content))).map(row => `${row.document_id}:${row.version_id}:${row.block_id}`));
    const currentBlockKeys = new Set(readableRows.map(row => `${row.document_id}:${row.version_id}:${row.block_id}`));
    const selection = selectWikiManifestSources(readableRows, { maxSourceBlocks: safeLimit, maxInputTokens, topicTermsByDocument, changedBlockKeys });
    const sources = selection.sources.map((source, index) => ({ ...source, sourceId: `S${index + 1}` }));
    const manifest = {
        spaceId: Number(space.id), collectionId: Number(space.collection_id), promptVersion: space.prompt_version,
        sourceDocumentIds: scopedDocumentIds, tokenBudget: selection.tokenBudget, usedTokens: selection.usedTokens,
        changedBlockCount: changedBlockKeys.size, removedBlockCount: [...knownBlocks.keys()].filter(key => !currentBlockKeys.has(key)).length,
        sources: sources.map(source => ({ documentId: source.documentId, versionId: source.versionId, blockId: source.blockId, chunkId: source.chunkId, contentHash: contentHash(source.content), tokenEstimate: source.tokenEstimate, selectedReason: source.selectedReason }))
    };
    return { space, sources, topicPlan: buildWikiTopicPlan(sources, Math.min(safeLimit, maxPages), { tagsByDocument, entitiesByDocument, historicalTopics }), hash: contentHash(JSON.stringify(manifest)), manifest };
}

async function persistWikiCompileInputs({ runId, sources = [] } = {}, deps = {}) {
    const safeRunId = String(runId || '').trim();
    if (!safeRunId || !sources.length) return 0;
    const exec = deps.execute || execute;
    const now = getBeijingTimestamp();
    await exec(`
        INSERT INTO knowledge_wiki_compile_inputs (
            run_id, source_ordinal, document_id, version_id, block_id, legacy_chunk_id,
            document_title, heading_path, content, content_hash, source_locator_json,
            selected_reason, token_estimate, created_at
        ) VALUES ${sources.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)').join(', ')}
        ON CONFLICT (run_id, source_ordinal) DO NOTHING
    `, sources.flatMap((source, index) => [
        safeRunId, index + 1, source.documentId, source.versionId, source.blockId, source.chunkId || null,
        source.documentTitle || '', source.headingPath || '', source.content || '', contentHash(source.content),
        JSON.stringify(source.locator || {}), source.selectedReason || '', Number(source.tokenEstimate || estimateWikiTokens(source.content)), now
    ]));
    return sources.length;
}

async function loadWikiCompileManifestSnapshot({ runId, user } = {}, deps = {}) {
    const safeRunId = String(runId || '').trim();
    if (!safeRunId || !user?.id) return null;
    const rows = await (deps.query || query)(`
        SELECT input.*, document.current_version_id, document.lifecycle_status, document.verified_status,
               document.deleted_at AS document_deleted_at, block.version_id AS current_block_version_id
        FROM knowledge_wiki_compile_inputs input
        JOIN knowledge_documents document ON document.id = input.document_id
        LEFT JOIN knowledge_blocks block ON block.id = input.block_id
        WHERE input.run_id = ? ORDER BY input.source_ordinal ASC
    `, [safeRunId]);
    if (!rows.length) return { sources: [], superseded: true, reason: 'missing_snapshot' };
    const invalid = [];
    const snapshotDocumentIds = [...new Set(rows.map(row => Number(row.document_id)))];
    const getDocument = deps.getProductDocumentForUser || require('./knowledge-content').getProductDocumentForUser;
    const readableDocuments = new Map((await Promise.all(snapshotDocumentIds.map(async id => [id, await getDocument(id, user)])))
        .filter(([, document]) => Boolean(document)));
    for (const row of rows) {
        const isCurrent = Number(row.current_version_id) === Number(row.version_id)
            && Number(row.current_block_version_id) === Number(row.version_id)
            && !row.document_deleted_at && row.lifecycle_status === 'published' && row.verified_status !== 'expired';
        if (!isCurrent) { invalid.push(row); continue; }
        if (!readableDocuments.has(Number(row.document_id))) invalid.push(row);
    }
    if (invalid.length) return { sources: [], superseded: true, reason: 'source_changed', invalidSourceCount: invalid.length };
    const sources = rows.map(row => ({
        sourceId: `S${Number(row.source_ordinal)}`, documentId: Number(row.document_id), versionId: Number(row.version_id),
        blockId: Number(row.block_id), chunkId: normalizeId(row.legacy_chunk_id), documentTitle: row.document_title,
        headingPath: row.heading_path || '', content: row.content || '', locator: parseJson(row.source_locator_json, {}),
        tokenEstimate: Number(row.token_estimate || estimateWikiTokens(row.content)), selectedReason: row.selected_reason || ''
    }));
    return { sources, superseded: false, topicPlan: buildWikiTopicPlan(sources) };
}

module.exports = {
    buildWikiCompileManifestForSpace,
    loadWikiCompileManifestSnapshot,
    persistWikiCompileInputs,
    selectWikiManifestSources
};
