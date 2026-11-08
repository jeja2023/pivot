'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { encryptSecretWithKey, decryptSecretWithKey } = require('../../../security');
const { canonicalHash } = require('./canonical');
const { biError } = require('./errors');

const MAX_ENTRY_BYTES = 1024 * 1024;
const EMPTY_HASH = '0'.repeat(64);

function unavailable() { return biError('ANALYSIS_SECURITY_JOURNAL_UNAVAILABLE', '独立安全记录不可验证，已停止数据读取；请联系维护者核对安全日志和密钥。', 503); }
function within(root, target) { const relative = path.relative(root, target); return !relative || !relative.startsWith('..') && !path.isAbsolute(relative); }

async function journalConfiguration() {
    const root = String(process.env.DATA_ANALYSIS_SECURITY_JOURNAL_DIR || '').trim();
    const keyFile = String(process.env.DATA_ANALYSIS_SECURITY_KEY_FILE || '').trim();
    if (!root || !keyFile || !path.isAbsolute(root) || !path.isAbsolute(keyFile)) throw unavailable();
    const resolved = path.resolve(root), keyPath = path.resolve(keyFile);
    const primaryRoots = [process.env.DATA_DIR || path.resolve(__dirname, '../../../../data'), ...Object.values(require('../../offline-backup-bundle').backupPaths())];
    for (const primary of primaryRoots) if (within(path.resolve(primary), resolved) || within(resolved, path.resolve(primary)) || within(path.resolve(primary), keyPath)) throw unavailable();
    if (within(resolved, keyPath)) throw unavailable();
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(resolved), keyStat = await fs.lstat(keyPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.size > 4096 || process.platform !== 'win32' && (rootStat.mode & 0o077)) throw unavailable();
    const actual = await fs.realpath(resolved), actualKey = await fs.realpath(keyPath);
    if (actual !== resolved || actualKey !== keyPath) throw unavailable();
    const key = (await fs.readFile(keyPath, 'utf8')).trim();
    if (!/^[a-f0-9]{64,128}$/i.test(key) || process.platform !== 'win32' && (keyStat.mode & 0o077)) throw unavailable();
    return { root: resolved, key, durability: process.platform === 'win32' ? 'file-fsync-windows-local-validation' : 'file-and-directory-fsync' };
}

async function syncDirectory(directory) {
    let handle;
    try { handle = await fs.open(directory, 'r'); await handle.sync(); }
    catch (error) { if (process.platform !== 'win32' || !['EISDIR', 'EPERM', 'EINVAL', 'EBADF'].includes(error.code)) throw error; }
    finally { await handle?.close(); }
}

async function readChain(config, originId) {
    if (!/^[a-f0-9-]{36}$/i.test(originId)) throw unavailable();
    if ((await fs.readdir(config.root)).some(name => /^[a-f0-9-]{36}$/i.test(name) && name !== originId)) throw unavailable();
    const directory = path.join(config.root, originId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077)) throw unavailable();
    await syncDirectory(config.root);
    const names = (await fs.readdir(directory)).sort();
    const entries = [], byId = new Map(); let previous = EMPTY_HASH;
    for (const name of names) {
        if (!/^\d{16}\.entry$/.test(name)) throw unavailable();
        const position = entries.length + 1;
        if (name !== `${String(position).padStart(16, '0')}.entry`) throw unavailable();
        const file = path.join(directory, name), info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENTRY_BYTES) throw unavailable();
        const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
        if (envelope.position !== position || envelope.previous !== previous || envelope.originId !== originId || !String(envelope.sealed).startsWith('enc:v2:')) throw unavailable();
        const record = JSON.parse(decryptSecretWithKey(envelope.sealed, config.key, `pivot.bi.security:${originId}:${position}:${previous}`));
        if (record.origin_id !== originId || !record.event_id || byId.has(record.event_id)) throw unavailable();
        const hash = canonicalHash(envelope);
        entries.push({ position, hash, record }); byId.set(record.event_id, { position, hash, record }); previous = hash;
    }
    return { directory, entries, byId, position: entries.length, hash: previous };
}

async function appendSecurityRecord(config, chain, record) {
    const duplicate = chain.byId.get(record.event_id);
    if (duplicate) {
        if (canonicalHash(duplicate.record) !== canonicalHash(record)) throw unavailable();
        return duplicate;
    }
    const position = chain.position + 1;
    const envelope = { version: 1, originId: record.origin_id, position, previous: chain.hash,
        sealed: encryptSecretWithKey(JSON.stringify(record), config.key, `pivot.bi.security:${record.origin_id}:${position}:${chain.hash}`) };
    const bytes = Buffer.from(JSON.stringify(envelope));
    if (bytes.length > MAX_ENTRY_BYTES) throw unavailable();
    const file = path.join(chain.directory, `${String(position).padStart(16, '0')}.entry`);
    const temporary = path.join(config.root, `pending-${crypto.randomUUID()}`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
        // Publish only fully written bytes. A hard link is atomic and cannot
        // replace an entry won by another writer, unlike rename on POSIX.
        await fs.link(temporary, file);
        await syncDirectory(chain.directory);
    } finally { await fs.unlink(temporary).catch(() => {}); await syncDirectory(config.root); }
    const entry = { position, hash: canonicalHash(envelope), record };
    chain.entries.push(entry); chain.byId.set(record.event_id, entry); chain.position = position; chain.hash = entry.hash;
    return entry;
}

module.exports = { configuration: journalConfiguration, readChain, append: appendSecurityRecord, unavailable, EMPTY_HASH };
