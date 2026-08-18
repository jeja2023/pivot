const { query } = require('../db/client');
const { isAdmin } = require('../permissions');
const { parseAllowedUserIds } = require('./unit-visibility');

async function filterExistingShareUserIds(value, { excludeUserId = null } = {}) {
    const requestedIds = parseAllowedUserIds(value);
    const ids = requestedIds.filter(id => Number(id) !== Number(excludeUserId));
    if (!ids.length) {
        if (requestedIds.length) {
            const error = new Error('不能把资源共享给资源所有者本人，请重新选择个人账号。');
            error.status = 400;
            throw error;
        }
        return '';
    }
    const placeholders = ids.map(() => '?').join(',');
    const rows = await query(`
        SELECT id
        FROM users
        WHERE deleted_at IS NULL
          AND COALESCE(status, 'active') = 'active'
          AND id IN (${placeholders})
    `, ids);
    const existing = new Set((rows || []).map(row => Number(row.id)));
    const filtered = ids.filter(id => existing.has(id));
    if (filtered.length !== requestedIds.length) {
        const error = new Error('选择的个人账号已失效，请刷新共享列表后重新选择。');
        error.status = 400;
        throw error;
    }
    return filtered.join(',');
}

async function listShareTargets(user, { excludeUserId = user?.id } = {}) {
    const currentUnit = String(user?.unit || '').trim();
    const admin = isAdmin(user);
    const unitRows = admin
        ? (await query(`
            SELECT DISTINCT TRIM(unit) AS unit
            FROM users
            WHERE deleted_at IS NULL
              AND COALESCE(status, 'active') = 'active'
              AND TRIM(COALESCE(unit, '')) <> ''
            ORDER BY TRIM(unit) ASC
        `)) || []
        : (currentUnit ? [{ unit: currentUnit }] : []);
    const userRows = (await query(`
        SELECT id, username, nickname, unit
        FROM users
        WHERE deleted_at IS NULL
          AND COALESCE(status, 'active') = 'active'
          AND id != ?
        ORDER BY COALESCE(NULLIF(TRIM(nickname), ''), username) ASC, id ASC
        LIMIT 5000
    `, [Number(excludeUserId) || 0])) || [];
    const users = userRows.map(row => ({
        id: Number(row.id),
        username: String(row.username || '').trim(),
        nickname: String(row.nickname || '').trim(),
        unit: String(row.unit || '').trim()
    }));

    return {
        currentUnit,
        units: [...new Set(unitRows.map(row => String(row.unit || '').trim()).filter(Boolean))],
        users,
        canShareAll: admin,
        canShareAcrossUnits: admin
    };
}

module.exports = { filterExistingShareUserIds, listShareTargets };
