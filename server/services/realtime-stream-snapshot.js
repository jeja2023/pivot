'use strict';

const { queryOne, execute } = require('../db/client');
const { encryptSecret, decryptSecret } = require('../security');
const { logger } = require('../logger');
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_AGE_SECONDS = 300;
let lastCleanup = 0;

function context(runId, userId) { return `realtime.stream:${userId}:${runId}`; }

async function writeSnapshot({ runId, userId, leaseOwner, leaseEpoch, step, snapshot }) {
    if (!runId || !userId || !leaseOwner || !/^[1-9]\d{0,18}$/.test(String(leaseEpoch || '')) || !Number.isSafeInteger(step) || step < 0) return false;
    if (!snapshot || String(snapshot.runId) !== String(runId) || Number(snapshot.step) !== step) throw new Error('实时快照身份不匹配');
    const json = JSON.stringify(snapshot);
    if (Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES) throw new Error('实时快照超过大小上限');
    const encrypted = encryptSecret(json, context(runId, userId));
    const row = await queryOne(`
        WITH owned AS (
            SELECT id, user_id FROM agent_runs WHERE id = ? AND user_id = ? AND locked_by = ? AND realtime_lease_epoch = ?::bigint
                AND lock_expires_at > NOW() AND deleted_at IS NULL
                AND status IN ('running','planning','executing','observing','diagnosing','replanning','resuming') FOR UPDATE
        )
        INSERT INTO realtime_stream_snapshots (run_id, user_id, lease_owner, lease_epoch, step, snapshot_ciphertext, byte_length, updated_at)
        SELECT id, user_id, ?, ?::bigint, ?, ?, ?, NOW() FROM owned
        ON CONFLICT (run_id) DO UPDATE SET user_id = EXCLUDED.user_id, lease_owner = EXCLUDED.lease_owner,
            lease_epoch = EXCLUDED.lease_epoch, step = EXCLUDED.step, snapshot_ciphertext = EXCLUDED.snapshot_ciphertext, byte_length = EXCLUDED.byte_length,
            revision = realtime_stream_snapshots.revision + 1, updated_at = NOW()
        WHERE realtime_stream_snapshots.lease_epoch <> EXCLUDED.lease_epoch OR realtime_stream_snapshots.step <= EXCLUDED.step
        RETURNING revision::text AS revision
    `, [runId, userId, leaseOwner, leaseEpoch, leaseOwner, leaseEpoch, step, encrypted, Buffer.byteLength(json)]);
    if (Date.now() - lastCleanup > 60000) {
        lastCleanup = Date.now();
        await execute("DELETE FROM realtime_stream_snapshots WHERE run_id IN (SELECT run_id FROM realtime_stream_snapshots WHERE updated_at < NOW() - INTERVAL '1 day' LIMIT 100)")
            .catch(error => logger.warn({ code: error.code || 'REALTIME_SNAPSHOT_CLEANUP_FAILED' }, '流式快照清理失败'));
    }
    return Boolean(row);
}

async function readSnapshot(runId, userId) {
    const row = await queryOne(`
        SELECT s.snapshot_ciphertext, s.lease_epoch::text AS lease_epoch, s.revision::text AS revision FROM realtime_stream_snapshots s JOIN agent_runs r ON r.id = s.run_id
        JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL AND COALESCE(u.status, 'active') = 'active'
        WHERE s.run_id = ? AND s.user_id = ? AND r.user_id = ? AND r.deleted_at IS NULL
          AND s.lease_owner = r.locked_by AND s.lease_epoch = r.realtime_lease_epoch AND r.lock_expires_at > NOW()
          AND r.status IN ('running','planning','executing','observing','diagnosing','replanning','resuming')
          AND s.updated_at > NOW() - (? * INTERVAL '1 second')
    `, [String(runId), userId, userId, MAX_AGE_SECONDS]);
    if (!row || !String(row.snapshot_ciphertext || '').startsWith('enc:v2:')) return null;
    const snapshot = JSON.parse(decryptSecret(row.snapshot_ciphertext, context(String(runId), userId)));
    return { ...snapshot, streamLeaseEpoch: row.lease_epoch, streamRevision: row.revision };
}

function createSnapshotWriter({ runId, userId, leaseOwner, leaseEpoch, enabled, notify, publishLocal }) {
    let pending = null; let timer = null; let active = null; let stopped = false;
    function measure(snapshot) {
        try {
            const bytes = Buffer.byteLength(JSON.stringify(snapshot));
            return bytes <= MAX_SNAPSHOT_BYTES ? bytes : -1;
        } catch (_) { return -1; }
    }
    function pump() {
        if (active || !pending || stopped) return active || Promise.resolve();
        const next = pending; pending = null;
        active = writeSnapshot({ runId, userId, leaseOwner, leaseEpoch, step: next.step, snapshot: next }).then(async written => {
            if (written) {
                if (await readSnapshot(runId, userId) === null) return;
                publishLocal?.(userId, 'agent.streaming', next, { crossNode: false });
                notify?.(userId, 'agent.streaming', next);
            }
        }).catch(error => logger.warn({ code: error.code || 'REALTIME_SNAPSHOT_FAILED', runId }, '流式快照保存失败'))
            .finally(() => { active = null; if (pending && !stopped) void pump(); });
        return active;
    }
    function push(snapshot) {
        if (!enabled || !leaseOwner || !leaseEpoch || stopped) return false;
        if (measure(snapshot) < 0) { pending = null; logger.warn({ runId, code: 'REALTIME_SNAPSHOT_TOO_LARGE' }, '流式快照超出可恢复上限'); return false; }
        pending = snapshot;
        if (!timer && !active) { timer = setTimeout(() => { timer = null; void pump(); }, 250); timer.unref?.(); }
        return true;
    }
    async function finish() {
        if (timer) clearTimeout(timer); timer = null;
        while (pending || active) { if (!active) await pump(); else await active; }
        stopped = true;
    }
    function publishesLocally() { return Boolean(enabled && leaseOwner && leaseEpoch); }
    return { push, finish, publishesLocally };
}

module.exports = { createSnapshotWriter, readSnapshot, writeSnapshot };
