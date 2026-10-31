'use strict';

const { query, execute } = require('../../db/client');
const { logger } = require('../../logger');

// 请求方与显示的在线用户均重新按文稿当前所有权/协作关系过滤。
async function listSharedPresence(presentationId, userId) {
    const rows = await query(`
        SELECT p.user_id, u.username, COALESCE(NULLIF(u.nickname, ''), u.username, '用户') AS display_name,
               p.slide_id, p.selected_element_id, p.is_editing,
               to_char(p.last_seen_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') AS last_seen_at
        FROM presentation_shared_presence p
        JOIN presentation_documents d ON d.id = p.presentation_id AND d.deleted_at IS NULL
        JOIN users u ON u.id = p.user_id AND u.deleted_at IS NULL AND COALESCE(u.status, 'active') = 'active'
        WHERE p.presentation_id = ? AND p.last_seen_at > NOW() - INTERVAL '45 seconds'
          AND (d.owner_user_id = ? OR EXISTS (SELECT 1 FROM presentation_collaborators viewer WHERE viewer.presentation_id = d.id AND viewer.user_id = ?))
          AND (d.owner_user_id = p.user_id OR EXISTS (SELECT 1 FROM presentation_collaborators member WHERE member.presentation_id = d.id AND member.user_id = p.user_id))
        ORDER BY p.user_id
    `, [presentationId, userId, userId]);
    return rows.map(row => ({ userId: Number(row.user_id), username: String(row.username || '').slice(0, 60),
        displayName: String(row.display_name || '用户').slice(0, 60), slideId: row.slide_id,
        selectedElementId: row.selected_element_id, isEditing: row.is_editing, lastSeenAt: row.last_seen_at }));
}

let lastPrune = 0;
let pruning = null;
async function pruneExpiredPresence() {
    return await execute(`
        DELETE FROM presentation_shared_presence WHERE ctid IN (
            SELECT ctid FROM presentation_shared_presence WHERE last_seen_at < NOW() - INTERVAL '1 day' LIMIT 500
        )
    `);
}
function schedulePrune() {
    if (pruning) return pruning;
    if (Date.now() - lastPrune < 60000) return Promise.resolve();
    lastPrune = Date.now();
    pruning = pruneExpiredPresence().catch(error => logger.warn({ code: error.code || 'PRESENCE_CLEANUP_FAILED' }, '演示文稿在线状态清理失败'))
        .finally(() => { pruning = null; });
    return pruning;
}

async function recordSharedPresence({ presentationId, userId, slideId = '', selectedElementId = '', isEditing = false }) {
    await execute(`
        INSERT INTO presentation_shared_presence (presentation_id, user_id, slide_id, selected_element_id, is_editing, last_seen_at)
        SELECT d.id, ?, ?, ?, ?, NOW() FROM presentation_documents d
        WHERE d.id = ? AND d.deleted_at IS NULL
          AND (d.owner_user_id = ? OR EXISTS (SELECT 1 FROM presentation_collaborators c WHERE c.presentation_id = d.id AND c.user_id = ?))
        ON CONFLICT (presentation_id, user_id) DO UPDATE SET slide_id = EXCLUDED.slide_id,
            selected_element_id = EXCLUDED.selected_element_id, is_editing = EXCLUDED.is_editing, last_seen_at = EXCLUDED.last_seen_at
    `, [userId, String(slideId || '').slice(0, 64), String(selectedElementId || '').slice(0, 64), Boolean(isEditing), presentationId, userId, userId]);
    await schedulePrune();
    return await listSharedPresence(presentationId, userId);
}

async function leaveSharedPresence({ presentationId, userId }) {
    await execute('DELETE FROM presentation_shared_presence WHERE presentation_id = ? AND user_id = ?', [presentationId, userId]);
    return await listSharedPresence(presentationId, userId);
}

module.exports = { listSharedPresence, recordSharedPresence, leaveSharedPresence, pruneExpiredPresence };
