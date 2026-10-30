'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { withDocumentOrphanGuard } = require('../../repositories/document-orphan-references');
const { getBeijingTimestamp } = require('../../time');
const { documentRoot, pagesRoot, outputsRoot, resolveStoredDocumentPath } = require('./paths');

// 仅处理新版受任务锁保护、带 gc1 标记的随机文件。原文件、通用 tmp、历史格式和缺少任务记录的文件不自动删除。
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RETENTION_DAYS = 30;
const MAX_SCAN_FILES = 2000;
const MAX_CANDIDATES = 25;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PAGE_NAME = new RegExp(`^(\\d+)-gc1-page-\\d{4,}-${UUID}\\.png$`, 'i');
const OUTPUT_NAME = new RegExp(`^(\\d+)-gc1-[a-z0-9_-]+-${UUID}\\.[a-z0-9]+$`, 'i');
let scanCursor = null;
let activeCleanup = null;

function comparePosition(left, right) {
    return left.kind.localeCompare(right.kind) || left.user.localeCompare(right.user) || left.name.localeCompare(right.name);
}

function pathKey(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function safeDirectory(directory, expected) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return pathKey(await fs.realpath(directory)) === pathKey(expected);
}

async function collectCandidates({ cutoffMs, limit, scanLimit }) {
    const candidates = [];
    let scanned = 0;
    let last = null;
    let more = false;
    for (const [kind, root, pattern] of [['outputs', outputsRoot, OUTPUT_NAME], ['pages', pagesRoot, PAGE_NAME]]) {
        try {
            if (!await safeDirectory(documentRoot, documentRoot) || !await safeDirectory(root, root)) continue;
        } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const users = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[1-9]\d*$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
        for (const user of users) {
            const userId = Number(user.name);
            if (!Number.isSafeInteger(userId)) continue;
            const dir = path.join(root, user.name);
            try { if (!await safeDirectory(dir, dir)) continue; }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            const files = (await fs.readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name));
            for (const file of files) {
                const position = { kind, user: user.name, name: file.name };
                if (scanCursor && comparePosition(position, scanCursor) <= 0) continue;
                last = position;
                scanned += 1;
                const match = pattern.exec(file.name);
                const jobId = match ? Number(match[1]) : 0;
                if (Number.isSafeInteger(jobId) && jobId > 0) {
                    const target = path.join(dir, file.name);
                    try {
                        const stat = await fs.lstat(target);
                        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoffMs) candidates.push({ target, dir, root, name: file.name, userId, jobId, stat });
                    } catch (error) { if (error.code !== 'ENOENT') throw error; }
                }
                if (candidates.length >= limit || scanned >= scanLimit) { more = true; break; }
            }
            if (more) break;
        }
        if (more) break;
    }
    scanCursor = more ? last : null;
    return { candidates, scanned, more };
}

async function removeIfUnreferenced(candidate, cutoff) {
    return withDocumentOrphanGuard({ jobId: candidate.jobId, userId: candidate.userId, cutoff, name: candidate.name }, async refs => {
        for (const row of refs) {
            try {
                const resolved = resolveStoredDocumentPath(row.stored_path);
                if (resolved && pathKey(resolved) === pathKey(candidate.target)) return 'referenced';
            } catch (_) { return 'referenced'; }
        }
        if (!await safeDirectory(documentRoot, documentRoot) || !await safeDirectory(candidate.root, candidate.root) || !await safeDirectory(candidate.dir, candidate.dir)) return 'changed';
        let current;
        try { current = await fs.lstat(candidate.target); }
        catch (error) { if (error.code === 'ENOENT') return 'changed'; throw error; }
        if (!current.isFile() || current.isSymbolicLink() || current.mtimeMs !== candidate.stat.mtimeMs || current.size !== candidate.stat.size || current.ino !== candidate.stat.ino) return 'changed';
        await fs.unlink(candidate.target);
        return 'deleted';
    });
}

async function runCleanup(options = {}) {
    const requestedDays = Number.parseInt(options.retentionDays, 10);
    const retentionDays = Math.min(3650, Math.max(MIN_RETENTION_DAYS, Number.isFinite(requestedDays) ? requestedDays : MIN_RETENTION_DAYS));
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const cutoffMs = nowMs - retentionDays * DAY_MS;
    const cutoff = getBeijingTimestamp(new Date(cutoffMs));
    const limit = Math.min(MAX_CANDIDATES, Math.max(1, Number.parseInt(options.limit, 10) || MAX_CANDIDATES));
    const scanLimit = Math.min(MAX_SCAN_FILES, Math.max(1, Number.parseInt(options.scanLimit, 10) || MAX_SCAN_FILES));
    const { candidates, scanned, more } = await collectCandidates({ cutoffMs, limit, scanLimit });
    let deleted = 0;
    for (const candidate of candidates) if (await removeIfUnreferenced(candidate, cutoff) === 'deleted') deleted += 1;
    return { scanned, candidates: candidates.length, deleted, retentionDays, more };
}

async function cleanupDocumentOrphans(options = {}) {
    if (activeCleanup) return activeCleanup;
    const task = runCleanup(options).finally(() => { if (activeCleanup === task) activeCleanup = null; });
    activeCleanup = task;
    return await task;
}

module.exports = { cleanupDocumentOrphans };
