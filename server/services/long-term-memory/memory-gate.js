const { query, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const {
    MEMORY_SETTING_KEY,
    MEMORY_REVISION_SETTING_KEY,
    MEMORY_JOB_STATUS
} = require('./memory-utils');

function parseMemoryRevision(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function getMemoryGateState(userId, executor = { query }) {
    const rows = await executor.query(`
        SELECT key, value
        FROM user_settings
        WHERE user_id = ?
          AND key IN (?, ?)
    `, [Number(userId), MEMORY_SETTING_KEY, MEMORY_REVISION_SETTING_KEY]);
    const values = new Map((rows || []).map(row => [String(row.key), String(row.value ?? '')]));
    return {
        enabled: values.get(MEMORY_SETTING_KEY) !== 'false',
        revision: parseMemoryRevision(values.get(MEMORY_REVISION_SETTING_KEY))
    };
}

async function lockMemoryGateState(userId, trx) {
    const now = getBeijingTimestamp();
    await trx.execute(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, '0', ?)
        ON CONFLICT(user_id, key) DO NOTHING
    `, [Number(userId), MEMORY_REVISION_SETTING_KEY, now]);
    const rows = await trx.query(`
        SELECT key, value
        FROM user_settings
        WHERE user_id = ? AND key IN (?, ?)
        FOR UPDATE
    `, [Number(userId), MEMORY_SETTING_KEY, MEMORY_REVISION_SETTING_KEY]);
    const values = new Map((rows || []).map(row => [String(row.key), String(row.value ?? '')]));
    return {
        enabled: values.get(MEMORY_SETTING_KEY) !== 'false',
        revision: parseMemoryRevision(values.get(MEMORY_REVISION_SETTING_KEY))
    };
}

async function assertMemoryWriteGate(userId, options = {}) {
    const gate = await getMemoryGateState(userId);
    if (!gate.enabled) return { allowed: false, reason: 'disabled', gate };
    const expectedRevision = options.memoryRevision ?? options.expectedMemoryRevision;
    if (expectedRevision !== undefined && Number(expectedRevision) !== gate.revision) {
        return { allowed: false, reason: 'memory_revision_changed', gate };
    }
    return { allowed: true, reason: '', gate };
}

// 修订号是用户级写入栅栏。撤回路径先推进它，旧快照中的任务便无法在随后提交。
async function bumpMemoryRevision(userId, trx) {
    const gate = await lockMemoryGateState(userId, trx);
    const revision = gate.revision + 1;
    await trx.queryOne(`
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        RETURNING user_id
    `, [Number(userId), MEMORY_REVISION_SETTING_KEY, String(revision), getBeijingTimestamp()]);
    return { ...gate, revision };
}

async function isLongTermMemoryEnabled(userId) {
    return (await getMemoryGateState(userId)).enabled;
}

async function setLongTermMemoryEnabled(userId, enabled) {
    const now = getBeijingTimestamp();
    const desired = enabled === true;
    await transaction(async trx => {
        await bumpMemoryRevision(userId, trx);
        await trx.queryOne(`
            INSERT INTO user_settings (user_id, key, value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            RETURNING user_id
        `, [Number(userId), MEMORY_SETTING_KEY, desired ? 'true' : 'false', now]);
        if (!desired) {
            await trx.execute(`
                UPDATE memory_extraction_jobs
                SET status = ?, locked_at = NULL, last_error = ?, completed_at = ?, updated_at = ?
                WHERE user_id = ? AND status = ?
            `, [MEMORY_JOB_STATUS.skipped, 'MEMORY_DISABLED', now, now, Number(userId), MEMORY_JOB_STATUS.queued]);
        }
    });
    return desired;
}

module.exports = {
    bumpMemoryRevision,
    lockMemoryGateState,
    assertMemoryWriteGate,
    isLongTermMemoryEnabled,
    setLongTermMemoryEnabled
};
