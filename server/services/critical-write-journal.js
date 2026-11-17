'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createContentStore } = require('./content-addressed-files');
const { encryptSecret, decryptSecret } = require('../security');

const root = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'critical-write-journal');
const store = createContentStore({ rootResolver: () => root, durable: true, errorPrefix: 'CRITICAL_WRITE' });
const kinds = new Set(['auditLogs', 'modelUsageEvents']);
const filename = /^[a-f0-9-]{36}\.json$/;

async function save(kind, item) {
    if (!kinds.has(kind)) throw new Error('关键写入类型未登记。');
    const deliveryId = item.deliveryId || crypto.randomUUID();
    if (!filename.test(`${deliveryId}.json`)) throw new Error('关键写入标识无效。');
    const record = { ...item, deliveryId };
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Error('关键写入记录超过安全上限，请缩短审计摘要。');
    const payload = encryptSecret(serialized, `pivot.critical-write:${kind}:${deliveryId}`);
    const temp = await store.writeBufferToTemp(Buffer.from(payload));
    try { await store.promoteTempToStorage(temp, `${kind}/${deliveryId}.json`); }
    finally { await store.removeTempFile(temp); }
    return record;
}

async function remove(kind, deliveryId) {
    if (!kinds.has(kind) || !filename.test(`${deliveryId}.json`)) throw new Error('关键写入标识无效。');
    if (!await store.removeStorageFile(`${kind}/${deliveryId}.json`)) throw new Error('关键写入回执清理失败，将在恢复时复核。');
}

async function recover(accept) {
    await store.sweepTemporaryFiles();
    for (const kind of kinds) {
        let directory;
        try { directory = await fs.opendir(path.join(root, kind)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for await (const entry of directory) {
            if (!entry.isFile() || !filename.test(entry.name)) throw new Error('关键写入目录包含异常文件，请检查存储。');
            const deliveryId = entry.name.slice(0, -5);
            const stat = await fs.lstat(path.join(root, kind, entry.name));
            if (stat.size > 4 * 1024 * 1024) throw new Error('关键写入记录超限，请检查存储。');
            const text = await store.readStorageFile(`${kind}/${entry.name}`);
            const item = JSON.parse(decryptSecret(text.toString('utf8'), `pivot.critical-write:${kind}:${deliveryId}`));
            if (item.deliveryId !== deliveryId) throw new Error('关键写入身份不匹配，请检查存储。');
            if (!await accept(kind, item)) return false;
        }
    }
    return true;
}

module.exports = { save, remove, recover };
