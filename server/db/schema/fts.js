/**
 * SQLite 专属：FTS5 全文索引虚拟表与同步触发器。
 * PostgreSQL 侧不建虚拟表，改用 pg_trgm GIN 索引，见 server/db/schema/pg.js。
 */
function sqliteFtsSql() {
    return `
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
            content,
            tokenize='unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS trg_knowledge_chunks_insert AFTER INSERT ON knowledge_chunks BEGIN
            INSERT INTO knowledge_chunks_fts(rowid, content) VALUES (new.id, COALESCE(new.search_content, new.content));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_knowledge_chunks_delete AFTER DELETE ON knowledge_chunks BEGIN
            DELETE FROM knowledge_chunks_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_knowledge_chunks_update AFTER UPDATE ON knowledge_chunks
        WHEN old.content != new.content OR COALESCE(old.search_content, '') != COALESCE(new.search_content, '') BEGIN
            UPDATE knowledge_chunks_fts SET content = COALESCE(new.search_content, new.content) WHERE rowid = new.id;
        END;

        -- 全文搜索支持 (FTS5)

        CREATE VIRTUAL TABLE IF NOT EXISTS regulation_articles_fts USING fts5(
            content,
            tokenize='unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS trg_regulation_articles_insert AFTER INSERT ON regulation_articles BEGIN
            INSERT INTO regulation_articles_fts(rowid, content) VALUES (new.id, COALESCE(new.search_content, new.content));
        END;
        CREATE TRIGGER IF NOT EXISTS trg_regulation_articles_delete AFTER DELETE ON regulation_articles BEGIN
            DELETE FROM regulation_articles_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_regulation_articles_update AFTER UPDATE ON regulation_articles BEGIN
            UPDATE regulation_articles_fts SET content = COALESCE(new.search_content, new.content) WHERE rowid = new.id;
        END;

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            tokenize='unicode61'
        );

        -- 触发器：同步消息到全文索引
        -- 注意：这些触发器不区分软删除（deleted_at），被软删除的消息仍保留在 messages_fts 中。
        -- 因此全文搜索查询必须在 SQL 层显式过滤 m.deleted_at IS NULL（参见 routes/sessions.js 搜索路由），
        -- 不要依赖 FTS 索引本身排除已删除消息。
        CREATE TRIGGER IF NOT EXISTS trg_messages_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_messages_delete AFTER DELETE ON messages BEGIN
            DELETE FROM messages_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_messages_update AFTER UPDATE ON messages WHEN old.content != new.content BEGIN
            UPDATE messages_fts SET content = new.content WHERE rowid = new.id;
        END;
    `;
}

module.exports = { sqliteFtsSql };

