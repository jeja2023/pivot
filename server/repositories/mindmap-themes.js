'use strict';
const { query, execute, transaction } = require('../db/client');
const schema = require('../../client/common/mindmap-document');
async function list(userId) { return query('SELECT id,name,content FROM mindmap_theme_library WHERE user_id=? ORDER BY updated_at DESC LIMIT 100', [userId]); }
async function save(userId, content) {
    return transaction(async db => {
        await db.queryOne('SELECT pg_advisory_xact_lock(?)', [Number(userId)]);
        const count = await db.queryOne('SELECT COUNT(*) AS n FROM mindmap_theme_library WHERE user_id=? AND name<>?', [userId, content.label]); if (Number(count.n) >= 100) throw schema.error('主题库已达到 100 个主题，请先删除旧主题。', 'MINDMAP_THEME_QUOTA', 429);
        return db.queryOne('INSERT INTO mindmap_theme_library(id,user_id,name,content) VALUES(?,?,?,?::jsonb) ON CONFLICT(user_id,name) DO UPDATE SET content=EXCLUDED.content,updated_at=NOW() RETURNING id,name,content', [require('crypto').randomUUID(), userId, content.label, JSON.stringify(content)]);
    });
}
async function remove(userId, id) { return execute('DELETE FROM mindmap_theme_library WHERE id=? AND user_id=?', [id, userId]); }
module.exports = { list, save, remove };
