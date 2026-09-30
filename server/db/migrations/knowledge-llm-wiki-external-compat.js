'use strict';

// 首个 Wiki 底座迁移已经可能在开发或早期试点库执行；后续新增的外部
// Markdown 投影和 GIN 搜索索引必须使用独立迁移补齐，不能修改既有记录后
// 假定已部署数据库会自动重跑。
module.exports = [{
    id: '202609300002_knowledge_llm_wiki_external_compat',
    description: 'Add external Markdown Wiki projection tables and a dedicated derived-page search index.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS knowledge_wiki_external_pages (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                source_id BIGINT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
                document_id BIGINT REFERENCES knowledge_documents(id) ON DELETE SET NULL,
                canonical_uri TEXT NOT NULL,
                title TEXT NOT NULL,
                frontmatter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                content_markdown TEXT NOT NULL DEFAULT '',
                content_hash TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(source_id, canonical_uri)
            );
            CREATE TABLE IF NOT EXISTS knowledge_wiki_external_page_links (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                page_id BIGINT NOT NULL REFERENCES knowledge_wiki_external_pages(id) ON DELETE CASCADE,
                target_path TEXT NOT NULL,
                target_label TEXT NOT NULL DEFAULT '',
                link_type TEXT NOT NULL DEFAULT 'wikilink',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(page_id, target_path, target_label, link_type)
            );
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_external_pages_source ON knowledge_wiki_external_pages(source_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_external_pages_document ON knowledge_wiki_external_pages(document_id, status);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_external_links_page ON knowledge_wiki_external_page_links(page_id, link_type);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_search ON knowledge_wiki_pages
                USING GIN (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(content_markdown, '')));
        `);
    }
}];
