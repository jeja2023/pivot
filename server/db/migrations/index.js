const crypto = require('crypto');
const { buildRagSearchContent } = require('../../services/rag-tokenizer');
const regulationsMigrations = require('./regulations');
const { enterpriseSchemaSql } = require('../schema/enterprise');
const { archiveDeletedUsername } = require('../../services/user-identity');

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
    },
    {
        id: '202607030001_rag_debug_enterprise_contracts',
        description: 'Create RAG debug history and enterprise deployment contract tables.',
        up(db) {
            db.exec(enterpriseSchemaSql());
        }
    },
    {
        id: '202607150001_release_deleted_usernames',
        description: 'Preserve deleted usernames while releasing them for new registrations.',
        up(db) {
            const usersTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
            if (!usersTable) return;

            const columns = db.prepare('PRAGMA table_info(users)').all();
            if (!columns.some(column => column.name === 'deleted_username')) {
                db.exec('ALTER TABLE users ADD COLUMN deleted_username TEXT');
            }
            if (!columns.some(column => column.name === 'deleted_at')) return;

            const deletedUsers = db.prepare(`
                SELECT id
                FROM users
                WHERE deleted_at IS NOT NULL AND username != 'admin'
                ORDER BY id ASC
            `).all();
            deletedUsers.forEach(user => archiveDeletedUsername(db, user.id));
        }
    },
    {
        id: '202607310001_hash_refresh_tokens',
        description: 'Hash refresh tokens at rest while preserving active client sessions.',
        up(db) {
            const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'refresh_tokens'").get();
            if (!table) return;
            const rows = db.prepare('SELECT id, token FROM refresh_tokens').all();
            const update = db.prepare('UPDATE refresh_tokens SET token = ? WHERE id = ?');
            rows.forEach((row) => {
                const token = String(row.token || '');
                if (/^[0-9a-f]{64}$/i.test(token)) return;
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                update.run(tokenHash, row.id);
            });
        }
    },
    ...regulationsMigrations
];

module.exports = migrations;
