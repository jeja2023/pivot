'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');
const { getPgPool } = require('../../db/pg-connection');
const { ensureDocumentProcessingDirs, tempRoot } = require('./paths');
const { logger } = require('../../logger');

const NAME = /^qpdf-v2-([a-f0-9]{32})$/;
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
let scanCursor = '';

async function connect() {
    const client = new Client(getPgPool().options);
    client.on('error', () => {});
    try {
        await client.connect();
        await client.query("SET statement_timeout = '30s'");
        return client;
    } catch (error) {
        await client.end().catch(() => {});
        throw error;
    }
}

async function safeRoot() {
    const stat = await fs.lstat(tempRoot);
    return stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(await fs.realpath(tempRoot)) === path.resolve(tempRoot);
}

async function withQpdfLease(operation) {
    await ensureDocumentProcessingDirs();
    if (!await safeRoot()) throw new Error('qpdf 临时目录不是安全的实际目录');
    const id = crypto.randomBytes(16).toString('hex');
    const directory = path.join(tempRoot, `qpdf-v2-${id}`);
    const client = await connect();
    let lockLost = false;
    let created = false;
    const controller = new AbortController();
    const loseLock = () => { lockLost = true; controller.abort(); };
    client.on('error', loseLock);
    client.on('end', loseLock);
    try {
        await client.query("SELECT pg_advisory_lock(hashtext('pivot:qpdf-temp'), hashtext(current_schema() || ':' || $1))", [id]);
        await fs.mkdir(directory, { mode: 0o700 });
        created = true;
        if (lockLost) throw new Error('qpdf 临时目录租约已失效');
        const result = await operation(directory, controller.signal);
        if (lockLost) throw new Error('qpdf 临时目录租约已失效');
        return result;
    } finally {
        // 锁连接意外断开后不能证明仍拥有执行权，保留目录由后续巡检回收。
        if (created && !lockLost) await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
        if (created && lockLost) logger.warn({ id }, 'qpdf 临时目录租约连接已断开，保留目录等待巡检');
        await client.end().catch(() => {});
    }
}

async function cleanupQpdfWorkdirs({ now = Date.now(), ageMs = MIN_AGE_MS, limit = 25 } = {}) {
    await ensureDocumentProcessingDirs();
    if (!await safeRoot()) return { scanned: 0, removed: 0 };
    const cutoff = now - Math.max(MIN_AGE_MS, Number(ageMs) || MIN_AGE_MS);
    const max = Math.min(100, Math.max(1, Number(limit) || 25));
    const all = (await fs.readdir(tempRoot, { withFileTypes: true }))
        .filter(item => item.isDirectory() && !item.isSymbolicLink() && NAME.test(item.name))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const remaining = all.filter(item => item.name > scanCursor);
    const entries = remaining.slice(0, max);
    const client = await connect();
    let removed = 0;
    try {
        for (const entry of entries) {
            const id = NAME.exec(entry.name)[1];
            const directory = path.join(tempRoot, entry.name);
            let before;
            try { before = await fs.lstat(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!before.isDirectory() || before.isSymbolicLink() || before.mtimeMs >= cutoff) continue;
            const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('pivot:qpdf-temp'), hashtext(current_schema() || ':' || $1)) AS acquired", [id]);
            if (!lock.rows[0]?.acquired) continue;
            try {
                if (!await safeRoot()) break;
                const current = await fs.lstat(directory).catch(() => null);
                if (!current?.isDirectory() || current.isSymbolicLink() || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || current.mtimeMs >= cutoff) continue;
                await fs.rm(directory, { recursive: true, force: true });
                removed += 1;
            } finally {
                await client.query("SELECT pg_advisory_unlock(hashtext('pivot:qpdf-temp'), hashtext(current_schema() || ':' || $1))", [id]);
            }
        }
    } finally { await client.end(); }
    scanCursor = remaining.length > entries.length && entries.length ? entries[entries.length - 1].name : '';
    return { scanned: entries.length, removed };
}

module.exports = { cleanupQpdfWorkdirs, withQpdfLease };
