const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { normalizeSourceConfig } = require('../server/services/knowledge-sources');
const {
    parseMarkdownFrontmatter,
    parseMarkdownLinks,
    upsertExternalWikiMarkdownPage
} = require('../server/services/knowledge-wiki-markdown');

test('外部 Markdown Wiki 适配器解析安全 front matter、WikiLinks 与 Markdown 相对链接', () => {
    const parsed = parseMarkdownFrontmatter('---\ntitle: 差旅概览\ntags: [finance, travel]\n---\n# 差旅\n参见 [[发票要求|发票]] 和 [流程](流程.md)。');
    assert.deepEqual(parsed.frontmatter, { title: '差旅概览', tags: ['finance', 'travel'] });
    assert.match(parsed.body, /# 差旅/);
    assert.deepEqual(parseMarkdownLinks(parsed.body), [
        { targetPath: '发票要求', targetLabel: '发票', linkType: 'wikilink' },
        { targetPath: '流程', targetLabel: '流程', linkType: 'markdown' }
    ]);
});

test('外部 Wiki 数据源强制收敛为白名单目录内的 Markdown 文件', () => {
    const root = path.resolve('wiki-sample-root');
    const config = normalizeSourceConfig('wiki_markdown', { rootPath: root, extensions: ['.pdf'], maxFiles: 99 }, {
        env: { KNOWLEDGE_LOCAL_SOURCE_ROOTS: root, KNOWLEDGE_SOURCE_MAX_FILES: '1000' }
    });
    assert.deepEqual(config.extensions, ['.md']);
    assert.equal(config.rootPath, root);
});

test('外部 Markdown 同步以参数化页面和链接投影写入，不写回源目录', async () => {
    const calls = [];
    const result = await upsertExternalWikiMarkdownPage({
        sourceId: 1, documentId: 2, canonicalUri: 'wiki/overview.md',
        markdown: '---\ntitle: 总览\n---\n# 总览\n[[主题]]'
    }, {
        transaction: async fn => await fn({
            queryOne: async (sql, params) => { calls.push({ sql, params }); return { id: 3, source_id: 1, document_id: 2, canonical_uri: 'wiki/overview.md', title: '总览', frontmatter_json: { title: '总览' }, content_hash: 'sha256:x', status: 'active' }; },
            execute: async (sql, params) => { calls.push({ sql, params }); return 1; }
        })
    });
    assert.equal(result.page.title, '总览');
    assert.deepEqual(result.links, [{ targetPath: '主题', targetLabel: '主题', linkType: 'wikilink' }]);
    assert.match(calls[0].sql, /INSERT INTO knowledge_wiki_external_pages/);
    assert.match(calls[1].sql, /DELETE FROM knowledge_wiki_external_page_links/);
    assert.match(calls[2].sql, /INSERT INTO knowledge_wiki_external_page_links/);
});
