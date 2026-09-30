const assert = require('node:assert/strict');
const test = require('node:test');

const [migration] = require('../server/db/migrations/knowledge-llm-wiki-foundation');
const [externalCompatMigration] = require('../server/db/migrations/knowledge-llm-wiki-external-compat');
const {
    buildWikiCompileManifest,
    claimWikiCompileRun,
    cancelWikiCompileRun,
    createKnowledgeWikiCompileWorker,
    defaultCompilePolicy,
    getKnowledgeWikiConfig,
    listWikiSpaces,
    markWikiPagesStaleForDocument,
    normalizeWikiCandidate,
    parseWikiCompilerOutput
} = require('../server/services/knowledge-wiki');

test('LLM Wiki 迁移建立派生页面、来源映射、链接和可恢复编译记录', async () => {
    const statements = [];
    await migration.upPg({ query: async sql => statements.push(String(sql)) });
    const sql = statements.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_wiki_spaces/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_wiki_pages/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_wiki_page_sources/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_wiki_page_links/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_wiki_compile_runs/);
    assert.match(sql, /version_id BIGINT NOT NULL REFERENCES knowledge_document_versions/);
    assert.match(sql, /idx_knowledge_wiki_compile_runs_claim/);
});

test('已部署 Wiki 底座可通过后续兼容迁移补齐外部 Markdown 投影和专用搜索索引', async () => {
    const statements = [];
    await externalCompatMigration.upPg({ query: async sql => statements.push(String(sql)) });
    const sql = statements.join('\n');
    assert.match(sql, /knowledge_wiki_external_pages/);
    assert.match(sql, /knowledge_wiki_external_page_links/);
    assert.match(sql, /idx_knowledge_wiki_pages_search/);
});

test('Wiki 编译候选必须把每个事实性段落绑定到本轮允许的来源', () => {
    const source = {
        documentId: 11, versionId: 22, blockId: 33, chunkId: 44,
        content: '原始资料正文', locator: { headingPath: '第三章' }
    };
    const allowed = new Map([[`${source.documentId}:${source.versionId}:${source.blockId}:${source.chunkId}`, source]]);
    const valid = normalizeWikiCandidate({
        pageType: 'topic', slug: 'travel-policy', title: '差旅制度', summary: '综合说明', markdown: '## 适用范围\n适用员工。',
        claims: [{ sectionAnchor: '适用范围', statement: '适用员工。', sourceRefs: [{ documentId: 11, versionId: 22, blockId: 33, chunkId: 44, supportType: 'supports' }] }],
        links: [{ slug: 'invoice-policy', relationType: 'related_to' }]
    }, allowed);
    assert.equal(valid.slug, 'travel-policy');
    assert.equal(valid.sourceRefs.length, 1);
    assert.equal(valid.links[0].slug, 'invoice-policy');

    const invalid = normalizeWikiCandidate({
        title: '越权来源', markdown: '没有可验证依据。',
        claims: [{ statement: '没有可验证依据。', sourceRefs: [{ documentId: 99, versionId: 98, blockId: 97 }] }]
    }, allowed);
    assert.equal(invalid, null);

    for (const markdown of [
        '<script>alert(1)</script>',
        '[外部链接](https://untrusted.example/wiki)',
        '![](file:///sensitive/path.png)',
        '正文'.repeat(12001)
    ]) {
        assert.equal(normalizeWikiCandidate({
            title: '不安全输出', markdown,
            claims: [{ statement: '不安全输出。', sourceRefs: [{ documentId: 11, versionId: 22, blockId: 33, chunkId: 44, supportType: 'supports' }] }]
        }, allowed), null);
    }
});

test('Wiki 输出解析只接受结构化 JSON，来源变更会使已发布派生页失效', async () => {
    const output = parseWikiCompilerOutput('```json\n{"pages":[{"title":"概览"}]}\n```');
    assert.deepEqual(output, [{ title: '概览' }]);
    const calls = [];
    const result = await markWikiPagesStaleForDocument({ legacyDocId: 71, reason: 'source_deleted' }, {
        queryOne: async (sql, params) => {
            calls.push({ sql, params });
            return { id: 81 };
        },
        execute: async (sql, params) => {
            calls.push({ sql, params });
            return 3;
        }
    });
    assert.deepEqual(result, { documentId: 81, stalePages: 3, queuedRuns: 0, reason: 'source_deleted' });
    assert.match(calls[1].sql, /status = 'stale'/);
    assert.deepEqual(calls[1].params.slice(1), [81]);
});

test('Wiki 编译预算从类型化配置收敛且默认要求审核', () => {
    const config = getKnowledgeWikiConfig({
        PIVOT_KNOWLEDGE_WIKI_ENABLED: 'true',
        PIVOT_KNOWLEDGE_WIKI_MAX_SOURCE_BLOCKS: '999',
        PIVOT_KNOWLEDGE_WIKI_MAX_PAGES_PER_RUN: '0',
        PIVOT_KNOWLEDGE_WIKI_REQUIRE_REVIEW: 'true'
    });
    assert.equal(config.maxSourceBlocks, 30);
    assert.equal(config.maxPagesPerRun, 1);
    const policy = defaultCompilePolicy({}, {
        PIVOT_KNOWLEDGE_WIKI_MAX_SOURCE_BLOCKS: '8',
        PIVOT_KNOWLEDGE_WIKI_MAX_PAGES_PER_RUN: '2',
        PIVOT_KNOWLEDGE_WIKI_REQUIRE_REVIEW: 'true'
    });
    assert.equal(policy.maxSourceBlocks, 8);
    assert.equal(policy.maxPagesPerRun, 2);
    assert.equal(policy.requireReview, true);
});

test('Wiki 编译 Worker 通过可恢复租约领取任务，且禁用配置时不会启动', async () => {
    const calls = [];
    const claimed = await claimWikiCompileRun({ runId: 'run-1', workerId: 'worker-1', leaseSeconds: 90 }, {
        transaction: async fn => await fn({
            queryOne: async (sql, params) => {
                calls.push({ sql, params });
                return calls.length === 1 ? { id: 'run-1' } : { id: 'run-1', status: 'running', locked_by: 'worker-1' };
            }
        })
    });
    assert.equal(claimed.locked_by, 'worker-1');
    assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(calls[1].sql, /locked_by = \?/);
    assert.deepEqual(calls[0].params, ['run-1', 90]);

    const disabled = createKnowledgeWikiCompileWorker({
        deps: { getKnowledgeWikiConfig: () => ({ enabled: false, workerEnabled: true }) }
    });
    assert.equal(disabled, null);
});

test('Wiki 编译取消仅允许 Space 管理者，并持久化终态和中止运行控制器', async () => {
    const calls = [];
    const denied = await cancelWikiCompileRun({ runId: 'run-1', user: { id: 8, role: 'user' } }, {
        queryOne: async () => ({ id: 'run-1', owner_user_id: 9 }),
        execute: async () => 1
    });
    assert.equal(denied, null);
    const cancelled = await cancelWikiCompileRun({ runId: 'run-1', user: { id: 9, role: 'user' } }, {
        queryOne: async sql => { calls.push({ sql }); return { id: 'run-1', owner_user_id: 9 }; },
        execute: async (sql, params) => { calls.push({ sql, params }); return 1; }
    });
    assert.deepEqual(cancelled, { runId: 'run-1', status: 'cancelled' });
    assert.match(calls[1].sql, /status = 'cancelled'/);
    assert.equal(calls[1].params.at(-1), 'run-1');
});

test('共享专题库派生的 Wiki Space 仅按单位或用户白名单只读可见', async () => {
    const rows = [{
        id: 1, owner_user_id: 9, collection_id: 3, name: '研发 Wiki', description: '', scope: 'shared',
        allowed_units: '研发部', allowed_user_ids: '', status: 'active', compile_policy_json: '{}', prompt_version: 'v1',
        published_pages: 1, pending_pages: 0, stale_pages: 0
    }];
    const visible = await listWikiSpaces({ id: 8, unit: '研发部', role: 'user' }, {}, { query: async () => rows });
    assert.equal(visible.length, 1);
    const hidden = await listWikiSpaces({ id: 7, unit: '财务部', role: 'user' }, {}, { query: async () => rows });
    assert.deepEqual(hidden, []);
    const listCall = [];
    await listWikiSpaces({ id: 8, unit: '研发部', role: 'user' }, {}, {
        query: async sql => { listCall.push(sql); return rows; }
    });
    assert.match(listCall[0], /GROUP BY ws\.id, kc\.id/);
});

test('专题库权限收紧或文档级 ACL 拒绝时，Wiki 不保留旧共享快照也不把正文送入编译模型', async () => {
    const spaceRow = {
        id: 1, owner_user_id: 9, collection_id: 3, name: '研发 Wiki', description: '', scope: 'shared',
        allowed_units: '研发部', allowed_user_ids: '', status: 'active', compile_policy_json: '{}', prompt_version: 'v1',
        collection_owner_user_id: 9, collection_scope: 'personal', collection_allowed_units: '', collection_allowed_user_ids: ''
    };
    const hiddenAfterCollectionRestriction = await listWikiSpaces({ id: 8, unit: '研发部', role: 'user' }, {}, {
        query: async () => [{ ...spaceRow, published_pages: 1, pending_pages: 0, stale_pages: 0 }]
    });
    assert.deepEqual(hiddenAfterCollectionRestriction, []);

    const manifest = await buildWikiCompileManifest({ spaceId: 1, user: { id: 9, unit: '研发部', role: 'user' } }, {
        queryOne: async () => spaceRow,
        query: async () => [{
            document_id: 123, document_title: '不应进入模型的私有资料', version_id: 5, version_no: 1,
            block_id: 8, heading_path: '机密', content: '不得泄露', source_locator_json: '{}', legacy_chunk_id: 13
        }],
        getProductDocumentForUser: async () => null
    });
    assert.equal(manifest.sources.length, 0);
});
