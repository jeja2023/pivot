const { queryOne, execute } = require('../db/client');

const DELETED_USERNAME_PREFIX = '@deleted:';

function allocateDeletedUsername(userId) {
    return `${DELETED_USERNAME_PREFIX}${userId}`;
}

async function archiveDeletedUsername(dbOrUserId, userIdIfDb) {
    const userId = typeof dbOrUserId === 'number' || typeof dbOrUserId === 'string' ? dbOrUserId : userIdIfDb;
    return await archiveDeletedUsernameAsync(userId);
}

/**
 * 异步版本：通过 client.js 异步接口执行。
 */
async function archiveDeletedUsernameAsync(userId, _db = null) {
    const user = await queryOne(
        'SELECT id, username, deleted_username, deleted_at FROM users WHERE id = ?',
        [userId]
    );
    if (!user || !user.deleted_at) return false;

    const deletedUsername = String(user.deleted_username || user.username || '').trim();
    const base = `${DELETED_USERNAME_PREFIX}${userId}`;
    let candidate = base;
    let suffix = 0;

    // 分配无冲突的归档用户名
    while (true) {
        const collision = await queryOne(
            'SELECT id FROM users WHERE username = ? AND id != ?',
            [candidate, userId]
        );
        if (!collision) break;
        suffix += 1;
        candidate = `${base}:${suffix}`;
    }

    const changed = await execute(
        'UPDATE users SET username = ?, deleted_username = ? WHERE id = ? AND deleted_at IS NOT NULL',
        [candidate, deletedUsername, userId]
    );
    return changed > 0;
}

module.exports = {
    DELETED_USERNAME_PREFIX,
    allocateDeletedUsername,
    archiveDeletedUsername,
    archiveDeletedUsernameAsync
};
