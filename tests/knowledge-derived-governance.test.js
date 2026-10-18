'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const [migration] = require('../server/db/migrations/knowledge-derived-governance');
const [qualityMigration] = require('../server/db/migrations/knowledge-derived-quality');
const [qualityRepairMigration] = require('../server/db/migrations/knowledge-derived-quality-repair');
const {
    enqueueKnowledgeSourceLifecycleEvent,
    handleKnowledgeSourceLifecycleEvent,
    knowledgeMemorySourceFingerprintInput,
    knowledgeMemorySourceReference,
    lifecycleEventKey
} = require('../server/services/knowledge-source-lifecycle');
const { scoreKnowledgeEntityResolutionCandidates } = require('../server/services/knowledge-entity-resolution');
const { selectWikiManifestSources } = require('../server/services/knowledge-wiki');

test('知识派生治理迁移覆盖 claim/evidence、可回放 Wiki 输入与生命周期 outbox', async () => {
    const calls = [];
    await migration.upPg({ query: async sql => { calls.push(String(sql)); } });
    const sql = calls.join('\n');
    assert.match(sql, /knowledge_graph_claims/);
    assert.match(sql, /knowledge_graph_claim_evidence/);
    assert.match(sql, /knowledge_graph_merge_audits/);
    assert.match(sql, /knowledge_wiki_compile_inputs/);
    assert.match(sql, /knowledge_source_lifecycle_outbox/);
    assert.match(sql, /INSERT INTO knowledge_graph_claims/);
});

test('知识质量迁移建立人工别名字典、证据立场和可解释置信度字段', async () => {
    const calls = [];
    await qualityMigration.upPg({ query: async sql => { calls.push(String(sql)); } });
    const sql = calls.join('\n');
    assert.match(sql, /knowledge_entity_aliases/);
    assert.match(sql, /stance TEXT NOT NULL DEFAULT 'supports'/);
    assert.match(sql, /confidence_reason_json/);
    assert.match(sql, /idx_knowledge_entities_name_trgm/);
});

test('质量修复迁移可补齐部分升级环境缺失的证据摘录字段', async () => {
    const calls = [];
    await qualityRepairMigration.upPg({ query: async sql => { calls.push(String(sql)); } });
    const sql = calls.join('\n');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS excerpt_text/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS confidence_reason_json/);
});

test('Wiki 编译来源按文档轮转并遵守总 token 预算', () => {
    const rows = [
        { document_id: 1, document_title: '制度 A', version_id: 1, version_no: 1, block_id: 11, legacy_chunk_id: 111, heading_path: '第一章', content: '甲'.repeat(1000), source_locator_json: '{}' },
        { document_id: 1, document_title: '制度 A', version_id: 1, version_no: 1, block_id: 12, legacy_chunk_id: 112, heading_path: '第二章', content: '乙'.repeat(1000), source_locator_json: '{}' },
        { document_id: 2, document_title: '制度 B', version_id: 2, version_no: 1, block_id: 21, legacy_chunk_id: 211, heading_path: '总则', content: '丙'.repeat(1000), source_locator_json: '{}' }
    ];
    const selection = selectWikiManifestSources(rows, { maxSourceBlocks: 3, maxInputTokens: 1400 });
    assert.ok(selection.sources.length >= 2);
    assert.equal(selection.sources[0].documentId, 1);
    assert.equal(selection.sources[1].documentId, 2);
    assert.ok(selection.usedTokens <= selection.tokenBudget);
    assert.equal(selection.sources[0].selectedReason, 'document_diversity');
});

test('知识来源生命周期事件键按来源版本稳定去重', () => {
    const base = { legacyDocId: 8, documentId: 18, eventType: 'source_reindexed', payload: { sourceHash: 'a', versionId: 2 } };
    assert.equal(lifecycleEventKey(base), lifecycleEventKey({ ...base, payload: { versionId: 2, sourceHash: 'a' } }));
    assert.notEqual(lifecycleEventKey(base), lifecycleEventKey({ ...base, payload: { sourceHash: 'b', versionId: 2 } }));
});

test('知识来源映射到稳定的长期记忆来源引用与版本化摘要输入', () => {
    const event = { document_id: 18, legacy_doc_id: 8 };
    assert.equal(knowledgeMemorySourceReference(event), 'knowledge_document:18');
    assert.deepEqual(knowledgeMemorySourceFingerprintInput(event, { sourceHash: 'source-hash-v2', versionId: 3 }), {
        sourceKind: 'knowledge_document', sourceRef: 'knowledge_document:18', content: 'source-hash-v2', version: '3'
    });
});

test('资料状态变更可在调用方事务中写入可重试 outbox', async () => {
    const calls = [];
    await enqueueKnowledgeSourceLifecycleEvent({
        userId: 7, legacyDocId: 71, documentId: 17, eventType: 'source_disabled'
    }, {
        trx: { queryOne: async (sql, params) => { calls.push({ sql, params }); return { id: 'event-1' }; } }
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /knowledge_source_lifecycle_outbox/);
    assert.match(calls[0].sql, /status = 'pending'/);
});

test('实体消歧同时使用别名字面相似与现有来源分块向量', async () => {
    const candidates = await scoreKnowledgeEntityResolutionCandidates([
        { id: 1, name: '销售分析平台', type: 'system', aliases: '[]', confidence: 0.7 },
        { id: 2, name: '经营洞察系统', type: 'system', aliases: '["销售平台"]', confidence: 0.8 }
    ], { limit: 5 }, {
        query: async () => [
            { entity_id: 1, embedding: '[1,0,0]' },
            { entity_id: 2, embedding: '[0.99,0.01,0]' }
        ]
    });
    assert.equal(candidates.length, 1);
    assert.ok(candidates[0].semanticSimilarity > 0.98);
    assert.match(candidates[0].reason, /向量/);
});

test('失效来源事件同时失效图谱、Wiki 和 RAG 缓存', async () => {
    const calls = [];
    const result = await handleKnowledgeSourceLifecycleEvent({
        user_id: 7, legacy_doc_id: 71, document_id: 17, event_type: 'source_deleted', payload: {}
    }, {
        graph: { invalidateKnowledgeGraphSources: async input => { calls.push(['graph', input]); return { relations: 2, mentions: 3 }; } },
        wiki: { markWikiPagesStaleForDocument: async input => { calls.push(['wiki', input]); return { stalePages: 4 }; } },
        clearRagCacheForUser: userId => calls.push(['cache', userId]),
        memory: {
            revokeMemoriesForSourceReference: async (...args) => { calls.push(['memory', args]); return { revoked: 2, evidenceRemoved: 2 }; }
        }
    });
    assert.equal(result.graphInvalidated, 5);
    assert.equal(result.wikiResult.stalePages, 4);
    assert.equal(result.memoryResult.revoked, 2);
    assert.deepEqual(calls.map(item => item[0]), ['graph', 'wiki', 'memory', 'cache']);
});

test('知识新版本使用服务器内计算的来源摘要收紧关联记忆', async () => {
    const captured = [];
    const result = await handleKnowledgeSourceLifecycleEvent({
        user_id: 7, legacy_doc_id: 71, document_id: 17, event_type: 'manual_version_published',
        payload: { sourceHash: 'new-content-hash', versionId: 4 }
    }, {
        graph: { rebuildGraphForDocument: async () => ({ entities: 1, relations: 2 }) },
        wiki: { markWikiPagesStaleForDocument: async () => ({ stalePages: 1 }) },
        clearRagCacheForUser: () => {},
        memory: {
            sourceFingerprint: input => { captured.push(['fingerprint', input]); return 'f'.repeat(64); },
            markMemoriesForChangedSource: async (...args) => { captured.push(['changed', args]); return { reviewed: 3, memoryIds: [1, 2, 3] }; }
        }
    });
    assert.equal(result.memoryResult.reviewed, 3);
    assert.deepEqual(captured[0], ['fingerprint', {
        sourceKind: 'knowledge_document', sourceRef: 'knowledge_document:17', content: 'new-content-hash', version: '4'
    }]);
    assert.equal(captured[1][1][1].sourceFingerprint, 'f'.repeat(64));
});

test('Graph-RAG 只能以有效来源证据辅助原文召回，Wiki 搜索具有正向相关筛选', () => {
    const root = path.resolve(__dirname, '..');
    const graph = fs.readFileSync(path.join(root, 'server/services/knowledge-graph.js'), 'utf8');
    const retrieval = fs.readFileSync(path.join(root, 'server/services/rag-index/index.js'), 'utf8');
    const wiki = fs.readFileSync(path.join(root, 'server/services/knowledge-wiki.js'), 'utf8');
    assert.match(graph, /knowledge_graph_claim_evidence/);
    assert.match(graph, /graphDocumentReadySql/);
    assert.match(graph, /COALESCE\(.*source_state.*'active'/);
    assert.doesNotMatch(retrieval, /status:\s*'graph_hit'/);
    assert.match(wiki, /AND \(\$\{lexicalMatch\}\)/);
    assert.match(wiki, /Number\(row\.rank \|\| 0\) > 0/);
});
