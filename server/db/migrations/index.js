const { buildRagSearchContent } = require('../../services/rag-tokenizer');

const migrations = [
    {
        id: '202606260001_rag_search_content_backfill',
        description: 'Backfill RAG search_content and rebuild FTS from legacy chunks.',
        up(db) {
            db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
                    content,
                    tokenize='unicode61'
                );
            `);
            const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks'").get();
            if (!table) return;
            const columns = db.prepare('PRAGMA table_info(knowledge_chunks)').all();
            if (!columns.some(col => col.name === 'search_content')) {
                db.exec('ALTER TABLE knowledge_chunks ADD COLUMN search_content TEXT');
            }
            const rows = db.prepare(`
                SELECT id, content FROM knowledge_chunks
                WHERE search_content IS NULL OR search_content = ''
            `).all();
            if (rows.length > 0) {
                const update = db.prepare('UPDATE knowledge_chunks SET search_content = ? WHERE id = ?');
                rows.forEach(row => update.run(buildRagSearchContent(row.content), row.id));
            }
            db.exec('DELETE FROM knowledge_chunks_fts');
            db.exec('INSERT INTO knowledge_chunks_fts(rowid, content) SELECT id, COALESCE(search_content, content) FROM knowledge_chunks');
        }
    }
];

module.exports = migrations;
