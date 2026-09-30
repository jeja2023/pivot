'use strict';

module.exports = [{
    id: '202609300001_knowledge_llm_wiki_foundation',
    description: 'Add governed LLM Wiki spaces, derived pages, source mappings, links and recoverable compile runs.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS knowledge_wiki_spaces (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                collection_id BIGINT NOT NULL REFERENCES knowledge_collections(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                scope TEXT NOT NULL DEFAULT 'personal',
                allowed_units TEXT NOT NULL DEFAULT '',
                allowed_user_ids TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                compile_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                prompt_version TEXT NOT NULL DEFAULT 'wiki-compiler-v1',
                last_compiled_at TIMESTAMPTZ,
                last_published_at TIMESTAMPTZ,
                deleted_at TIMESTAMPTZ,
                deleted_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(owner_user_id, collection_id, name)
            );
            CREATE TABLE IF NOT EXISTS knowledge_wiki_pages (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                space_id BIGINT NOT NULL REFERENCES knowledge_wiki_spaces(id) ON DELETE CASCADE,
                page_type TEXT NOT NULL DEFAULT 'topic',
                slug TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                content_markdown TEXT NOT NULL DEFAULT '',
                content_hash TEXT NOT NULL DEFAULT '',
                version_no BIGINT NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'draft',
                confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
                source_coverage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                generated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                model_version TEXT NOT NULL DEFAULT '',
                prompt_version TEXT NOT NULL DEFAULT '',
                published_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                published_at TIMESTAMPTZ,
                superseded_by BIGINT,
                deleted_at TIMESTAMPTZ,
                deleted_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(space_id, slug, version_no)
            );
            CREATE TABLE IF NOT EXISTS knowledge_wiki_page_sources (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                wiki_page_id BIGINT NOT NULL REFERENCES knowledge_wiki_pages(id) ON DELETE CASCADE,
                document_id BIGINT NOT NULL REFERENCES knowledge_documents(id) ON DELETE RESTRICT,
                version_id BIGINT NOT NULL REFERENCES knowledge_document_versions(id) ON DELETE RESTRICT,
                block_id BIGINT REFERENCES knowledge_blocks(id) ON DELETE SET NULL,
                legacy_chunk_id BIGINT REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
                wiki_section_anchor TEXT NOT NULL DEFAULT '',
                source_locator_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                support_type TEXT NOT NULL DEFAULT 'supports',
                excerpt_hash TEXT NOT NULL DEFAULT '',
                verified_status TEXT NOT NULL DEFAULT 'unverified',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(wiki_page_id, document_id, version_id, block_id, legacy_chunk_id, wiki_section_anchor, support_type)
            );
            CREATE TABLE IF NOT EXISTS knowledge_wiki_page_links (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                from_page_id BIGINT NOT NULL REFERENCES knowledge_wiki_pages(id) ON DELETE CASCADE,
                to_page_id BIGINT NOT NULL REFERENCES knowledge_wiki_pages(id) ON DELETE CASCADE,
                relation_type TEXT NOT NULL DEFAULT 'related_to',
                anchor TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(from_page_id, to_page_id, relation_type, anchor)
            );
            CREATE TABLE IF NOT EXISTS knowledge_wiki_compile_runs (
                id UUID PRIMARY KEY,
                space_id BIGINT NOT NULL REFERENCES knowledge_wiki_spaces(id) ON DELETE CASCADE,
                requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                trigger_type TEXT NOT NULL DEFAULT 'manual',
                input_manifest_hash TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'queued',
                stage TEXT NOT NULL DEFAULT 'queued',
                summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                error_code TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                locked_by TEXT,
                locked_at TIMESTAMPTZ,
                started_at TIMESTAMPTZ,
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
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
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_spaces_collection ON knowledge_wiki_spaces(collection_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_space_status ON knowledge_wiki_pages(space_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_slug ON knowledge_wiki_pages(space_id, slug, version_no DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_search ON knowledge_wiki_pages
                USING GIN (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(content_markdown, '')));
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_page_sources_document ON knowledge_wiki_page_sources(document_id, version_id, verified_status);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_page_sources_page ON knowledge_wiki_page_sources(wiki_page_id, support_type);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_page_links_from ON knowledge_wiki_page_links(from_page_id, relation_type);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_compile_runs_claim ON knowledge_wiki_compile_runs(status, created_at ASC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_external_pages_source ON knowledge_wiki_external_pages(source_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_external_pages_document ON knowledge_wiki_external_pages(document_id, status);
            CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_external_links_page ON knowledge_wiki_external_page_links(page_id, link_type);
        `);
    }
}];
