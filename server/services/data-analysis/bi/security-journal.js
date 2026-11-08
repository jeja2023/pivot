'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const repository = require('../../../repositories/analysis-security-journal');
const files = require('./security-journal-files');
const { biError } = require('./errors');

let cached = null, running = null;
let enforcedRuntime = false;

function enabled() { return enforcedRuntime || process.env.DATA_ANALYSIS_MODEL_ENABLED === 'true' || Boolean(process.env.DATA_ANALYSIS_SECURITY_JOURNAL_DIR); }

async function pendingIn(client) {
    if (!enabled()) enforcedRuntime = await repository.enforcement(client);
    if (!enabled()) return false;
    return repository.pendingIn(client);
}

async function chainState(config, originId, force) {
    const key = `${config.root}:${originId}:${crypto.createHash('sha256').update(config.key).digest('hex')}`;
    if (cached?.key === key && !force) {
        if (Date.now() - cached.verifiedAt > 90000) throw files.unavailable();
        const names = await fs.readdir(cached.chain.directory);
        const last = cached.chain.position ? await fs.stat(path.join(cached.chain.directory, `${String(cached.chain.position).padStart(16, '0')}.entry`)) : null;
        if (names.length === cached.chain.position && (!last || last.size === cached.last?.size && last.mtimeMs === cached.last?.mtimeMs)) return cached.chain;
    }
    const chain = await files.readChain(config, originId);
    cached = { key, chain, verifiedAt: Date.now(), last: null };
    return chain;
}

async function flushSecurityJournal({ force = false, allowRecovery = false, transactionId = '', full = false } = {}) {
    if (!enabled()) enforcedRuntime = await repository.enforcement();
    if (!enabled()) return { disabled: true };
    if (running) { await running; if (!force) return flushSecurityJournal({ allowRecovery, transactionId, full }); }
    running = repository.withPump(async (client, state) => {
        if (!await repository.protections(client)) { await repository.close(client, 'security_capture_protection_missing'); throw files.unavailable(); }
        if (String(state.accepted_database_timeline) !== String(state.current_database_timeline) || Number(state.current_database_timeline) === 0 || state.accepted_database_system_identifier !== state.current_database_system_identifier) {
            if (state.mode !== 'recovery_required') await repository.close(client, 'database_physical_recovery_detected');
            if (!allowRecovery) throw files.unavailable();
        }
        const config = await files.configuration();
        // 在管道中独立于响应交付事务重新校验全部受保护历史；读取方核对其锚点并拒绝过期的完整性审计，
        // 而非同步扫描所有历史文件。

        const chain = await chainState(config, state.origin_id, force || Boolean(cached && Date.now() - cached.verifiedAt >= 60000));
        const checkpoint = Number(state.journal_position);
        if (checkpoint > chain.position || checkpoint > 0 && chain.entries[checkpoint - 1]?.hash !== state.journal_hash) {
            await repository.close(client, 'independent_journal_missing_or_changed'); throw files.unavailable();
        }
        // 缺失的已提交事件 ID 用于区分已恢复的旧业务数据库与独立追加和 SQL 确认之间的崩溃。

        for (let offset = force ? 0 : checkpoint; offset < chain.entries.length; offset += 500) {
            const ids = chain.entries.slice(offset, offset + 500).map(entry => entry.record.event_id);
            const known = await repository.records(client, ids);
            if (known.length !== ids.length) { await repository.close(client, 'database_behind_independent_security_log'); if (!allowRecovery) throw files.unavailable(); }
        }
        const inventory = await require('../../../repositories/analysis-security-inventory').backfill(client);
        let delivered = 0;
        const deadline = Date.now() + (transactionId || full ? 30000 : 1000), maxEvents = transactionId || full ? 10000 : 500;
        while (delivered < maxEvents && Date.now() < deadline) {
            const pending = await repository.pending(client, transactionId, transactionId || full ? 500 : 100);
            if (!pending.length) break;
            for (const record of pending) {
                const entry = await files.append(config, chain, record);
                await repository.acknowledge(client, entry); delivered++;
            }
            if (transactionId && !await repository.transactionPending(transactionId, client)) break;
        }
        const mode = await repository.ready(client, chain, inventory.complete);
        enforcedRuntime = true;
        if (chain.position) cached.last = await fs.stat(path.join(chain.directory, `${String(chain.position).padStart(16, '0')}.entry`));
        return { delivered, inventory, originId: state.origin_id, position: chain.position, hash: chain.hash, durability: config.durability, mode };
    }).catch(() => { cached = null; throw files.unavailable(); }).finally(() => { running = null; });
    return running;
}

async function committed({ transactionId = '' } = {}) {
    if (!enabled()) return;
    try { await flushSecurityJournal({ transactionId }); if (transactionId && await repository.transactionPending(transactionId)) throw files.unavailable(); }
    catch (_) {
        const error = biError('ANALYSIS_SECURITY_COMMITTED_PENDING', '权限变更已在主库生效，权限已收紧，安全记录待持久确认；请勿当作回滚。', 503);
        error.applied = true; error.securityConfirmationPending = true; error.securityTransactionId = transactionId; throw error;
    }
}

async function assertResources(trx, resources) {
    // 即使繁重的工作进程开关被关闭，也必须执行完全恢复闭环；旧的探索客户端不能重新打开历史授权。

    const state = await repository.stateForRead(trx);
    if (state?.enforced) enforcedRuntime = true;
    if (String(state?.accepted_database_timeline) !== String(state?.current_database_timeline) || Number(state?.current_database_timeline) === 0 || state?.accepted_database_system_identifier !== state?.current_database_system_identifier) {
        const error = files.unavailable(); error.securityFenceReason = 'database_physical_recovery_detected'; throw error;
    }
    if (!enabled() && state?.mode !== 'recovery_required') return;
    if (!await repository.readProtections(trx)) {
        const error = files.unavailable(); error.securityFenceReason = 'security_capture_protection_missing'; throw error;
    }
    if (state?.mode === 'ready') {
        try {
            const config = await files.configuration(), chain = await chainState(config, state.origin_id, false), checkpoint = Number(state.journal_position);
            if (checkpoint > chain.position || checkpoint > 0 && chain.entries[checkpoint - 1]?.hash !== state.journal_hash) throw files.unavailable();
            for (let offset = checkpoint; offset < chain.entries.length; offset += 500) {
                const ids = chain.entries.slice(offset, offset + 500).map(entry => entry.record.event_id);
                if (await repository.knownEvents(trx, ids) !== ids.length) throw files.unavailable();
            }
        } catch (_) { cached = null; throw files.unavailable(); }
    }
    await repository.assertResources(trx, resources);
}

async function assertAccess(resources = []) { return require('../../../db/client').transaction(trx => assertResources(trx, resources)); }

async function health() {
    const state = await repository.health();
    if (state?.enforced) enforcedRuntime = true;
    if (!enabled() && state?.mode !== 'recovery_required') return { disabled: true, mode: state?.mode || 'uninitialized' };
    const result = { mode: state?.mode, pending: Number(state?.pending || 0), pendingAgeSeconds: Number(state?.pending_age_seconds || 0), position: Number(state?.journal_position || 0), hash: state?.journal_hash, independentAvailable: false,
        inventory: { remaining: Number(state?.inventory_remaining || 0), scanned: Number(state?.inventory_scanned || 0), captured: Number(state?.inventory_captured || 0) } };
    try {
        const config = await files.configuration(), chain = await chainState(config, state.origin_id, false);
        result.independentAvailable = chain.position >= result.position && (!result.position || chain.entries[result.position - 1]?.hash === state.journal_hash);
        result.durability = config.durability;
    } catch (_) { cached = null; }
    return result;
}

async function recordFence(client, reason) { return repository.close(client, reason); }

module.exports = { enabled, pendingIn, flush: flushSecurityJournal, committed, assertResources, assertAccess, health, recordFence };
