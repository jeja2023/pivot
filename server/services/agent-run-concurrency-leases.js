const { transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const ADVISORY_LOCK_NAMESPACE = 9471;

function normalizePositiveInt(value, fallback = 1, maximum = 1000) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, maximum);
}

function normalizeLeaseMs(value, fallback = 24 * 60 * 60 * 1000) {
    const parsed = Number.parseInt(value, 10);
    return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, 60 * 1000), 7 * 24 * 60 * 60 * 1000);
}

function leaseError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/**
 * 用数据库租约记录用户运行槽位。事务内 advisory lock 串行化同一用户的清理、
 * 计数和插入，避免多个进程各自的内存调度器突破共同配额。
 */
function createRunConcurrencyLeaseStore({
    transaction: runTransaction = transaction,
    getTimestamp = getBeijingTimestamp,
    now = () => Date.now()
} = {}) {
    const expiresAt = leaseMs => getTimestamp(new Date(now() + normalizeLeaseMs(leaseMs)));

    async function acquireRunConcurrencyLease({ runId, userId, leaseOwner, limit, leaseMs } = {}) {
        if (!runId || !userId || !leaseOwner) throw leaseError('运行并发租约缺少必要标识。', 'AGENT_RUN_LEASE_INVALID');
        const safeLimit = normalizePositiveInt(limit, 1, 128);
        const safeLeaseMs = normalizeLeaseMs(leaseMs);
        return await runTransaction(async trx => {
            // PostgreSQL 是运行时真相源。哈希命名空间与用户 ID 既支持 BIGINT，
            // 也避免与其他 advisory lock 使用方冲突。
            await trx.queryOne(
                'SELECT pg_advisory_xact_lock(hashtextextended(?, ?))',
                [`agent_run_concurrency:${String(userId)}`, ADVISORY_LOCK_NAMESPACE]
            );
            const current = getTimestamp();
            await trx.execute('DELETE FROM agent_run_concurrency_leases WHERE user_id = ? AND lease_expires_at <= ?', [userId, current]);
            const existing = await trx.queryOne('SELECT run_id, user_id, lease_owner FROM agent_run_concurrency_leases WHERE run_id = ? FOR UPDATE', [runId]);
            if (existing && String(existing.user_id) !== String(userId)) {
                throw leaseError('运行租约所属用户不一致。', 'AGENT_RUN_LEASE_OWNER_MISMATCH');
            }
            const expiration = expiresAt(safeLeaseMs);
            if (existing) {
                await trx.execute(`
                    UPDATE agent_run_concurrency_leases
                    SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
                    WHERE run_id = ?
                `, [leaseOwner, expiration, current, runId]);
                return { acquired: true, renewed: true, expiresAt: expiration };
            }
            const countRow = await trx.queryOne('SELECT COUNT(*) AS count FROM agent_run_concurrency_leases WHERE user_id = ? AND lease_expires_at > ?', [userId, current]);
            if (Number(countRow?.count || 0) >= safeLimit) {
                return { acquired: false, reason: 'per_user_concurrency_exceeded' };
            }
            await trx.execute(`
                INSERT INTO agent_run_concurrency_leases (run_id, user_id, lease_owner, lease_expires_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [runId, userId, leaseOwner, expiration, current, current]);
            return { acquired: true, renewed: false, expiresAt: expiration };
        });
    }

    async function renewRunConcurrencyLease({ runId, userId, leaseOwner, leaseMs } = {}) {
        if (!runId || !userId || !leaseOwner) return { renewed: false, reason: 'invalid' };
        const current = getTimestamp();
        const changes = await runTransaction(async trx => await trx.execute(`
            UPDATE agent_run_concurrency_leases
            SET lease_expires_at = ?, updated_at = ?
            WHERE run_id = ? AND user_id = ? AND lease_owner = ? AND lease_expires_at > ?
        `, [expiresAt(leaseMs), current, runId, userId, leaseOwner, current]));
        return { renewed: changes === 1, reason: changes === 1 ? '' : 'lease_lost' };
    }

    async function releaseRunConcurrencyLease({ runId, userId, leaseOwner } = {}) {
        if (!runId || !leaseOwner) return false;
        const clauses = ['run_id = ?', 'lease_owner = ?'];
        const params = [runId, leaseOwner];
        if (userId) {
            clauses.push('user_id = ?');
            params.push(userId);
        }
        const changes = await runTransaction(async trx => await trx.execute(
            `DELETE FROM agent_run_concurrency_leases WHERE ${clauses.join(' AND ')}`,
            params
        ));
        return changes === 1;
    }

    return { acquireRunConcurrencyLease, releaseRunConcurrencyLease, renewRunConcurrencyLease };
}

const defaultStore = createRunConcurrencyLeaseStore();

module.exports = {
    acquireRunConcurrencyLease: defaultStore.acquireRunConcurrencyLease,
    createRunConcurrencyLeaseStore,
    releaseRunConcurrencyLease: defaultStore.releaseRunConcurrencyLease,
    renewRunConcurrencyLease: defaultStore.renewRunConcurrencyLease
};
