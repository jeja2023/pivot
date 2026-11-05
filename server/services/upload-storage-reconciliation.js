'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const cursors = new Map();
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const ordered = (left, right) => left < right ? -1 : left > right ? 1 : 0;

async function realDirectory(directory) {
    const stat = await fs.lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && pathKey(await fs.realpath(directory)) === pathKey(directory);
}

async function safeParents(root, target) {
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    let directory = root;
    if (!await realDirectory(directory)) return false;
    for (const part of relative.split(path.sep).slice(0, -1)) {
        directory = path.join(directory, part);
        if (!await realDirectory(directory)) return false;
    }
    return true;
}

async function scanUploadBatch(root, limit, after) {
    const files = []; let scanned = 0; let last = ''; let more = false;
    async function visit(directory, prefix = '') {
        if (!await realDirectory(directory)) return;
        const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => ordered(a.name + (a.isDirectory() ? '/' : ''), b.name + (b.isDirectory() ? '/' : '')));
        for (const entry of entries) {
            const position = prefix + entry.name + (entry.isDirectory() ? '/' : '');
            const passed = after && ordered(position, after) <= 0;
            if (passed && !(entry.isDirectory() && after.startsWith(position))) continue;
            if (!passed) {
                last = position; scanned += 1;
                if (entry.isFile() && !entry.isSymbolicLink()) files.push(path.join(directory, entry.name));
                if (scanned >= limit) { more = true; return; }
            }
            if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path.join(directory, entry.name), position);
            if (more) return;
        }
    }
    await visit(root);
    return { files, scanned, next: more ? last : '', more };
}

async function reconcile({ root, retentionDays, limit, nowMs, remove, references, getReferences, onDeleteError }) {
    const cutoff = nowMs - retentionDays * 86400000;
    const report = { root, retentionDays, referenced: 0, scanned: 0, candidates: 0, deletedFiles: 0, deletedBytes: 0, failedFiles: 0, more: false };
    try { if (!await realDirectory(root)) return { ...report, skipped: true }; }
    catch (error) { if (error.code === 'ENOENT') return report; throw error; }
    // 任一引用来源读取失败都停止清理，不能把数据库不可用当作文件无引用。
    const initial = references || await getReferences();
    report.referenced = initial.size;
    const key = pathKey(root);
    const batch = await scanUploadBatch(root, Math.max(1000, limit * 10), cursors.get(key) || '');
    report.scanned = batch.scanned; report.more = batch.more;
    const candidates = [];
    for (const target of batch.files) {
        if (initial.has(pathKey(target))) continue;
        try {
            const stat = await fs.lstat(target);
            if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) candidates.push({ target, stat });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (candidates.length >= limit) break;
    }
    report.candidates = candidates.length;
    if (remove && candidates.length) {
        const current = references || await getReferences();
        for (const candidate of candidates) {
            if (current.has(pathKey(candidate.target))) continue;
            try {
                if (!await safeParents(root, candidate.target)) continue;
                const stat = await fs.lstat(candidate.target);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs >= cutoff || stat.mtimeMs !== candidate.stat.mtimeMs || stat.size !== candidate.stat.size || stat.ino !== candidate.stat.ino || stat.dev !== candidate.stat.dev) continue;
                await fs.unlink(candidate.target);
                report.deletedFiles += 1; report.deletedBytes += stat.size;
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                report.failedFiles += 1; onDeleteError(error);
            }
        }
    }
    // 以本批实际检查位置推进，批次容量不足时不会跳过尚未检查的文件。
    const last = candidates.length >= limit ? path.relative(root, candidates.at(-1).target).split(path.sep).join('/') : batch.next;
    if (last) { cursors.delete(key); cursors.set(key, last); }
    else cursors.delete(key);
    if (cursors.size > 32) cursors.delete(cursors.keys().next().value);
    return report;
}

module.exports = { reconcile };
