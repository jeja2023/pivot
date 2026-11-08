'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const journal = require('./security-journal');
const journalRepository = require('../../../repositories/analysis-security-journal');
const recovery = require('../../../repositories/analysis-security-recovery');
const files = require('./security-journal-files');
const { canonicalHash } = require('./canonical');
const { biError } = require('./errors');

function invalid() { return biError('ANALYSIS_SECURITY_RECONCILIATION_REQUIRED', '当前身份与授权核对证明无效或不完整，恢复读取保持关闭。', 503); }

async function replay({ reason }) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw invalid();
    return journalRepository.withPump(async (client, state) => {
        // Persist closure before touching recovered rows, including on later
        // missing-key, corrupt-entry or transaction failure paths.
        await journalRepository.close(client, reason.trim());
        const config = await files.configuration(), chain = await files.readChain(config, state.origin_id);
        if (Number(state.journal_position) > chain.position || Number(state.journal_position) > 0 && chain.entries[Number(state.journal_position) - 1]?.hash !== state.journal_hash) throw files.unavailable();
        const latest = new Map();
        for (const entry of chain.entries) {
            const record = entry.record, key = `${record.target_table}:${record.target_id}`;
            if (!latest.has(key) || BigInt(record.revision) >= BigInt(latest.get(key).revision)) latest.set(key, record);
        }
        await recovery.replay(client, chain, latest);
        return { mode: 'recovery_required', originId: state.origin_id, position: chain.position, hash: chain.hash, eventsReplayed: chain.position,
            message: '安全事件与删除墓碑已重放，旧凭据及执行租约已失效；仍需当前身份源和业务授权签认后才能开放读取。' };
    });
}

async function validateAuthority(envelope, state, chain) {
    const body = envelope?.body;
    const resuming = body && state.pending_reconciliation_hash === canonicalHash(body);
    const matchingHead = body && (resuming ? body.journalPosition === 0 ? body.journalHash === files.EMPTY_HASH : chain.entries[body.journalPosition - 1]?.hash === body.journalHash : body.journalPosition === chain.position && body.journalHash === chain.hash);
    if (!body || body.version !== 1 || body.requiresCurrentAuthorityReview !== false || body.originId !== state.origin_id || !matchingHead
        || !Array.isArray(body.resources) || body.resources.length > 100000 || !body.authority || !body.approvedBy || !body.reason) throw invalid();
    const approvedAt = Date.parse(body.approvedAt), expiresAt = Date.parse(body.expiresAt), startedAt = Number(state.recovery_started_epoch_ms);
    if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(startedAt) || approvedAt < startedAt || approvedAt > Date.now() + 30000 || expiresAt < Date.now() || expiresAt - approvedAt > 3600000) throw invalid();
    const publicFile = String(process.env.DATA_ANALYSIS_SECURITY_AUTHORITY_PUBLIC_KEY_FILE || '').trim();
    const stat = await fs.lstat(publicFile).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw invalid();
    const publicKey = crypto.createPublicKey(await fs.readFile(publicFile));
    if (publicKey.asymmetricKeyType !== 'ed25519') throw invalid();
    if (!crypto.verify(null, Buffer.from(canonicalHash(body)), publicKey, Buffer.from(String(envelope.signature || ''), 'base64url'))) throw invalid();
    const allowed = new Set(recovery.TARGET_TABLES), seen = new Set();
    for (const row of body.resources) {
        if (!allowed.has(row.target_table) || typeof row.target_id !== 'string' || !row.target_id || row.target_id.length > 160 || !row.payload_json || typeof row.payload_json !== 'object' || Array.isArray(row.payload_json)) throw invalid();
        const key = `${row.target_table}:${row.target_id}`;
        if (seen.has(key)) throw invalid(); seen.add(key);
        const value = row.payload_json;
        if (String(value.id) !== row.target_id || typeof row.tombstone !== 'boolean') throw invalid();
        if (row.target_table === 'users' && (!['active', 'disabled'].includes(value.status) || !['admin', 'user'].includes(value.role) || typeof value.username !== 'string')) throw invalid();
        if (['analysis_datasets', 'analysis_data_models'].includes(row.target_table) && (!Number.isSafeInteger(Number(value.user_id)) || !['personal', 'shared'].includes(value.scope))) throw invalid();
        if (row.target_table === 'analysis_datasets' && (!Array.isArray(value.columnKeys) || value.columnKeys.some(key => typeof key !== 'string'))) throw invalid();
        if (row.target_table === 'analysis_data_models' && !/^[a-f0-9]{64}$/.test(value.definitionHash || '')) throw invalid();
        if (row.target_table === 'analysis_field_governance' && (typeof value.dataset_id !== 'string' || typeof value.field_key !== 'string')) throw invalid();
    }
    return body;
}

async function reconcile(envelope) {
    const applied = await journalRepository.withPump(async (client, state) => {
        if (state.mode !== 'recovery_required') throw invalid();
        const config = await files.configuration(), chain = await files.readChain(config, state.origin_id);
        const body = await validateAuthority(envelope, state, chain);
        // The repository holds table write locks while checking completeness
        // and credential fingerprints, so a concurrent row cannot be omitted.
        if (state.pending_reconciliation_hash !== canonicalHash(body)) try { await recovery.applyAuthority(client, body, chain, canonicalHash(body)); } catch (_) { throw invalid(); }
        return { authorityDigest: canonicalHash(body) };
    });
    await journal.flush({ force: true, allowRecovery: true, full: true });
    return journalRepository.withPump(async (client) => {
        const pending = await journalRepository.pending(client); if (pending.length) throw invalid();
        if (!await recovery.finalizeAuthority(client, applied.authorityDigest)) throw invalid();
        return { mode: 'ready', authorityDigest: applied.authorityDigest, message: '当前身份、凭据指纹和授权已完成独立签认，安全记录确认后恢复读取。' };
    });
}

async function prepareAuthorityDraft() {
    return journalRepository.withPump(async (client, state) => {
        if (state.mode !== 'recovery_required') throw invalid();
        const config = await files.configuration(), chain = await files.readChain(config, state.origin_id);
        return { version: 1, originId: state.origin_id, journalPosition: chain.position, journalHash: chain.hash, requiresCurrentAuthorityReview: true,
            authority: '', approvedBy: '', reason: '', approvedAt: '', expiresAt: '', resources: await recovery.authorityDraft(client) };
    });
}

module.exports = { replay, reconcile, prepareAuthorityDraft };
