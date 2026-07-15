const DELETED_USERNAME_PREFIX = '@deleted:';

function allocateDeletedUsername(db, userId) {
    const base = `${DELETED_USERNAME_PREFIX}${userId}`;
    let candidate = base;
    let suffix = 0;
    const findCollision = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?');

    while (findCollision.get(candidate, userId)) {
        suffix += 1;
        candidate = `${base}:${suffix}`;
    }
    return candidate;
}

function archiveDeletedUsername(db, userId) {
    const user = db.prepare(`
        SELECT id, username, deleted_username, deleted_at
        FROM users
        WHERE id = ?
    `).get(userId);
    if (!user || !user.deleted_at) return false;

    const deletedUsername = String(user.deleted_username || user.username || '').trim();
    const archivedKey = allocateDeletedUsername(db, user.id);
    const info = db.prepare(`
        UPDATE users
        SET username = ?, deleted_username = ?
        WHERE id = ? AND deleted_at IS NOT NULL
    `).run(archivedKey, deletedUsername, user.id);
    return info.changes > 0;
}

module.exports = {
    DELETED_USERNAME_PREFIX,
    allocateDeletedUsername,
    archiveDeletedUsername
};
