'use strict';

const { transaction, query, queryOne } = require('../db/client');
const { biError } = require('../services/data-analysis/bi/errors');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');

const SWITCHES = Object.freeze({ create: ['create_enabled', '新建正式模型'], publish: ['publish_enabled', '发布或切换模型版本'], admission: ['admission_enabled', '提交新的分析任务'], dispatch: ['dispatch_enabled', '领取分析任务'] });

async function releaseLock(trx, { exclusive = false } = {}) {
    // 管理操作同样先取得共同恢复锁，再取得发布控制锁。
    await trx.queryOne("SELECT pg_advisory_xact_lock_shared(hashtext('pivot:common-recovery'),hashtext(current_database()))");
    if (exclusive) await trx.queryOne("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:release'),hashtext(current_database()||':'||current_schema()))");
    else await trx.queryOne("SELECT pg_advisory_xact_lock_shared(hashtext('pivot:analysis:release'),hashtext(current_database()||':'||current_schema()))");
}

async function releaseReadLock(trx) {
    // 在读取事故状态行前取得发布共享锁，避免开关写入者持发布排他锁等待读者，
    // 而同一读者又在发布或准入阶段反向等待发布共享锁。
    await trx.queryOne("SELECT pg_advisory_xact_lock_shared(hashtext('pivot:analysis:release'),hashtext(current_database()||':'||current_schema()))");
}

function releaseRecord(row) {
    if (!row) throw biError('ANALYSIS_RELEASE_CONTROL_UNAVAILABLE', '数据建模发布控制尚未完成迁移，请联系维护者。', 503);
    return { createEnabled: row.create_enabled, publishEnabled: row.publish_enabled, admissionEnabled: row.admission_enabled, dispatchEnabled: row.dispatch_enabled,
        revision: Number(row.release_revision), actorId: row.release_actor === null ? null : Number(row.release_actor), reason: row.release_reason, updatedAt: row.updated_at };
}

async function assertReleaseAllowed(trx, operation, { locked = false } = {}) {
    if (!SWITCHES[operation]) throw new Error('未知数据建模发布控制。');
    if (!locked) await releaseLock(trx);
    const row = await trx.queryOne("SELECT * FROM analysis_operation_state WHERE id='main'");
    releaseRecord(row);
    if (!row[SWITCHES[operation][0]]) throw biError(`ANALYSIS_RELEASE_${operation.toUpperCase()}_PAUSED`, `维护期间暂不${SWITCHES[operation][1]}，请稍后重试。草稿仍可保存。`, 503);
}

async function dispatchAllowed(trx) {
    await releaseLock(trx);
    const row = await trx.queryOne("SELECT * FROM analysis_operation_state WHERE id='main'");
    releaseRecord(row);
    return row.dispatch_enabled;
}

async function releaseState() { return releaseRecord(await queryOne("SELECT * FROM analysis_operation_state WHERE id='main'")); }

async function changeReleaseControls({ userId, reason, expectedRevision, flags, action, requireIdle = false }) {
    return transaction(async trx => {
        await trx.queryOne("SELECT set_config('lock_timeout','5s',true)");
        await releaseLock(trx, { exclusive: true });
        await require('./analysis-authorization').lockPrincipals(trx, [userId]);
        const actor = await trx.queryOne('SELECT * FROM users WHERE id=?', [userId]);
        if (!actor || actor.deleted_at || actor.status !== 'active' || !require('../permissions').hasPermissionCapability(actor, 'manageGlobalSettings')) throw biError('ANALYSIS_OPERATIONS_FORBIDDEN', '仅当前有效的系统管理员可以变更发布控制。', 403);
        const row = await trx.queryOne("SELECT * FROM analysis_operation_state WHERE id='main' FOR UPDATE"), before = releaseRecord(row);
        if (Number(row.release_revision) !== expectedRevision) throw biError('ANALYSIS_RELEASE_CONTROL_CONFLICT', '发布控制已变化，请重新核对当前状态后重试。', 409);
        if (requireIdle) {
            const active = await trx.queryOne("SELECT EXISTS(SELECT 1 FROM analysis_query_jobs WHERE status IN ('queued','retry_wait','running','cancelling')) OR EXISTS(SELECT 1 FROM analysis_runtime_slots WHERE job_id IS NOT NULL) AS busy");
            if (active.busy) throw biError('ANALYSIS_RELEASE_WORKLOAD_BUSY', '仍有分析任务或执行单元未停止，请完成排空或取消后重试。', 409);
        }
        const after = { ...before, ...flags };
        if (['createEnabled', 'publishEnabled', 'admissionEnabled', 'dispatchEnabled'].some(key => after[key] && !before[key])) {
            await require('../services/data-analysis/bi/security-journal').assertResources(trx, [{ kind: 'principal', id: String(userId) }]);
        }
        const changed = ['createEnabled', 'publishEnabled', 'admissionEnabled', 'dispatchEnabled'].some(key => after[key] !== before[key]);
        if (!changed) return before;
        const next = await trx.queryOne(`UPDATE analysis_operation_state SET create_enabled=?,publish_enabled=?,admission_enabled=?,dispatch_enabled=?,release_actor=?,release_reason=?,updated_at=NOW()
            WHERE id='main' RETURNING *`, [after.createEnabled, after.publishEnabled, after.admissionEnabled, after.dispatchEnabled, userId, reason]);
        await require('./analysis-production-models').audit(trx, { userId, action: `model_release_${action}`, details: { reason, previousRevision: before.revision,
            revision: Number(next.release_revision), beforeHash: canonicalHash(before), afterHash: canonicalHash(releaseRecord(next)) } });
        return releaseRecord(next);
    }).catch(error => {
        if (['55P03', '40P01'].includes(error.code)) throw biError('ANALYSIS_RELEASE_CONTROL_BUSY', '发布控制正在等待现有操作结束，请保留当前修订号并稍后重试。', 503);
        throw error;
    });
}

async function releaseWorkload() {
    const [jobs, slots] = await Promise.all([
        query("SELECT id,user_id,execution_kind,status,execution_epoch,lease_owner,container_id,slot_id,lease_expires_at FROM analysis_query_jobs WHERE status IN ('queued','retry_wait','running','cancelling') ORDER BY created_at,id LIMIT 501"),
        query('SELECT id,job_id,execution_epoch,lease_expires_at FROM analysis_runtime_slots WHERE job_id IS NOT NULL ORDER BY id')
    ]);
    return { idle: jobs.length === 0 && slots.length === 0, truncated: jobs.length > 500, jobs: jobs.slice(0, 500), slots };
}

module.exports = { lock: releaseLock, readLock: releaseReadLock, assertAllowed: assertReleaseAllowed, dispatchAllowed, state: releaseState, change: changeReleaseControls, workload: releaseWorkload };
