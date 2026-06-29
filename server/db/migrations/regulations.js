const { buildRagSearchContent } = require('../../services/rag-tokenizer');

module.exports = [
    {
        id: '202606260002_regulations_library',
        description: 'Create shared regulations library tables and article FTS indexes.',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS regulation_documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    category TEXT DEFAULT '',
                    issuing_body TEXT DEFAULT '',
                    jurisdiction TEXT DEFAULT '',
                    effective_date TEXT DEFAULT '',
                    summary TEXT DEFAULT '',
                    status TEXT DEFAULT 'active',
                    current_version_id INTEGER,
                    version_count INTEGER DEFAULT 0,
                    article_count INTEGER DEFAULT 0,
                    created_by_user INTEGER DEFAULT 0,
                    updated_by_user INTEGER DEFAULT 0,
                    deleted_at DATETIME,
                    deleted_by_user INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    FOREIGN KEY (current_version_id) REFERENCES regulation_versions(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS regulation_versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    document_id INTEGER NOT NULL,
                    version_label TEXT DEFAULT '',
                    source_name TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    source_size INTEGER DEFAULT 0,
                    source_hash TEXT DEFAULT '',
                    source_format TEXT DEFAULT '',
                    extracted_text TEXT DEFAULT '',
                    summary TEXT DEFAULT '',
                    article_count INTEGER DEFAULT 0,
                    uploaded_by_user INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    FOREIGN KEY (document_id) REFERENCES regulation_documents(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS regulation_articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    document_id INTEGER NOT NULL,
                    version_id INTEGER NOT NULL,
                    sort_order INTEGER DEFAULT 0,
                    article_label TEXT NOT NULL,
                    article_title TEXT DEFAULT '',
                    content TEXT NOT NULL,
                    search_content TEXT,
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    FOREIGN KEY (document_id) REFERENCES regulation_documents(id) ON DELETE CASCADE,
                    FOREIGN KEY (version_id) REFERENCES regulation_versions(id) ON DELETE CASCADE
                );

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

                CREATE INDEX IF NOT EXISTS idx_regulation_documents_status ON regulation_documents(status, deleted_at, updated_at);
                CREATE INDEX IF NOT EXISTS idx_regulation_documents_category ON regulation_documents(category, deleted_at, updated_at);
                CREATE INDEX IF NOT EXISTS idx_regulation_documents_jurisdiction ON regulation_documents(jurisdiction, deleted_at, updated_at);
                CREATE INDEX IF NOT EXISTS idx_regulation_documents_updated ON regulation_documents(updated_at DESC, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_regulation_versions_document ON regulation_versions(document_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_regulation_articles_document ON regulation_articles(document_id, sort_order, id);
                CREATE INDEX IF NOT EXISTS idx_regulation_articles_version ON regulation_articles(version_id, sort_order, id);
            `);

            const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'regulation_articles'").get();
            if (!existing) return;

            const rows = db.prepare(`
                SELECT id, content, search_content
                FROM regulation_articles
                WHERE search_content IS NULL OR search_content = ''
            `).all();
            if (rows.length > 0) {
                const update = db.prepare('UPDATE regulation_articles SET search_content = ? WHERE id = ?');
                rows.forEach(row => {
                    update.run(buildRagSearchContent(row.content), row.id);
                });
            }

            db.exec('DELETE FROM regulation_articles_fts');
            db.exec(`
                INSERT INTO regulation_articles_fts(rowid, content)
                SELECT id, COALESCE(search_content, content)
                FROM regulation_articles
            `);
        }
    },
    {
        id: '202606290001_regulation_date_columns',
        description: 'Add effective_date_normalized and expire_date columns to regulation_documents for structured date queries and effect status.',
        up(db) {
            const columns = db.prepare('PRAGMA table_info(regulation_documents)').all();
            if (!columns.some(col => col.name === 'effective_date_normalized')) {
                db.exec('ALTER TABLE regulation_documents ADD COLUMN effective_date_normalized TEXT DEFAULT \'\'');
            }
            if (!columns.some(col => col.name === 'expire_date')) {
                db.exec('ALTER TABLE regulation_documents ADD COLUMN expire_date TEXT DEFAULT \'\'');
            }
        }
    },
    {
        id: '202606290002_regulation_article_links',
        description: 'Add heading_path to regulation_articles and create regulation_article_links for citation-graph relations between articles.',
        up(db) {
            const columns = db.prepare('PRAGMA table_info(regulation_articles)').all();
            if (!columns.some(col => col.name === 'heading_path')) {
                db.exec('ALTER TABLE regulation_articles ADD COLUMN heading_path TEXT DEFAULT \'\'');
            }
            db.exec(`
                CREATE TABLE IF NOT EXISTS regulation_article_links (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    document_id INTEGER NOT NULL,
                    version_id INTEGER NOT NULL,
                    source_article_id INTEGER NOT NULL,
                    target_label TEXT DEFAULT '',
                    target_article_id INTEGER,
                    target_document_id INTEGER,
                    relation_type TEXT DEFAULT 'cite',
                    confidence REAL DEFAULT 0.7,
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    FOREIGN KEY (document_id) REFERENCES regulation_documents(id) ON DELETE CASCADE,
                    FOREIGN KEY (version_id) REFERENCES regulation_versions(id) ON DELETE CASCADE,
                    FOREIGN KEY (source_article_id) REFERENCES regulation_articles(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_regulation_article_links_version ON regulation_article_links(version_id);
                CREATE INDEX IF NOT EXISTS idx_regulation_article_links_source ON regulation_article_links(source_article_id);
                CREATE INDEX IF NOT EXISTS idx_regulation_article_links_target ON regulation_article_links(target_article_id);
            `);
        }
    }
];
