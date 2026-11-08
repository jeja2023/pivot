'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createContentStore } = require('../../content-addressed-files');
const { analysisRoot } = require('../shared');
const repository = require('../../../repositories/analysis-objects');
const { biError } = require('./errors');

const store = createContentStore({ rootResolver: () => path.join(analysisRoot, 'objects'), namespaceLabel: '用户', errorPrefix: 'ANALYSIS_OBJECT', durable: true });

async function digestFile(file, signal) {
    const digest = crypto.createHash('sha256'); let byteSize = 0;
    for await (const chunk of fs.createReadStream(file, { signal })) { byteSize += chunk.length; digest.update(chunk); }
    return { digest: digest.digest('hex'), byteSize };
}

async function verify(row, { signal } = {}) {
    if (!row || row.state !== 'ready' && row.state !== 'staging') throw biError('ANALYSIS_OBJECT_NOT_READY', '数据对象未就绪，请重新检查来源。', 409);
    const key = row.storage_key;
    if (key !== `${row.purpose}/${store.buildStorageKey(row.user_id, row.digest)}`) throw biError('ANALYSIS_OBJECT_STORAGE_INVALID', '数据对象归属校验失败，请联系维护者。', 409);
    const physical = store.resolveStoragePath(key);
    try {
        const root = await fs.promises.realpath(store.casRoot()), real = await fs.promises.realpath(physical);
        if (path.relative(root, real).startsWith('..') || path.isAbsolute(path.relative(root, real)) || real !== path.resolve(root, path.relative(store.casRoot(), physical))) throw new Error('对象路径越界或包含链接');
        const stat = await fs.promises.lstat(physical);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('对象不是受控文件');
        const checked = await digestFile(physical, signal);
        if (checked.digest !== row.digest || BigInt(checked.byteSize) !== BigInt(row.byte_length)) throw new Error('对象摘要不符');
        return physical;
    } catch (error) {
        if (signal?.aborted || error.code === 'ABORT_ERR') throw error;
        await repository.quarantine(row.id);
        throw biError('ANALYSIS_OBJECT_CORRUPTED', '数据对象校验失败，已隔离；请重新导入来源或联系维护者恢复。', 409);
    }
}

async function importFile({ file, userId, purpose = 'source', leaseId = crypto.randomUUID(), maxBytes = 64 * 1024 * 1024 * 1024, fault, signal }) {
    const staged = await store.writeStreamToTemp(fs.createReadStream(file, { signal }), maxBytes);
    try {
        await fault?.('temp_written');
        const storageKey = `${purpose}/${store.buildStorageKey(userId, staged.digest)}`;
        const row = await repository.stage({ id: `object_${crypto.randomUUID()}`, userId, purpose, storageKey, ...staged });
        if (!['staging', 'ready'].includes(row.state)) throw biError('ANALYSIS_OBJECT_NOT_READY', '相同内容的对象正在回收或已隔离，请联系维护者。', 409);
        await fault?.('object_staged');
        await store.promoteTempToStorage(staged.tempPath, storageKey);
        await fault?.('file_promoted');
        await verify(row);
        const ready = await repository.ready(row.id, leaseId);
        await fault?.('object_ready');
        return { ...ready, leaseId };
    } finally { await store.removeTempFile(staged.tempPath); }
}

async function garbageCollect({ limit = 100, fault } = {}) {
    let deleted = 0;
    for (const candidate of await repository.expired(limit)) {
        const row = await repository.claimDeletion(candidate.id);
        if (!row) continue;
        await fault?.('deletion_claimed', row);
        const root = await fs.promises.realpath(store.casRoot()), parent = await fs.promises.realpath(path.dirname(store.resolveStoragePath(row.storage_key))).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        const expectedParent = path.resolve(root, path.relative(store.casRoot(), path.dirname(store.resolveStoragePath(row.storage_key))));
        if (parent && (parent !== expectedParent || path.relative(root, parent).startsWith('..') || path.isAbsolute(path.relative(root, parent)))) throw biError('ANALYSIS_OBJECT_STORAGE_INVALID', '回收路径校验失败，请联系维护者检查存储目录。', 409);
        await store.removeStorageFile(row.storage_key);
        if ((await store.statStorageFile(row.storage_key)).exists) throw biError('ANALYSIS_OBJECT_DELETE_FAILED', '对象文件未能删除，将保留回收状态并重试。', 503);
        await fault?.('file_deleted', row);
        await repository.finishDeletion(row); deleted++;
    }
    return { deleted };
}

module.exports = { store, importFile, verify, digestFile, garbageCollect };
