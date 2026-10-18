'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const MAX_FILES = 1000;
const MAX_BYTES = 20 * 1024 * 1024;
function snapshotError(message, code) { const error = new Error(message); error.code = code; return error; }
function snapshotRoot(env = process.env) { return path.resolve(String(env.PIVOT_AGENT_RECOVERY_SNAPSHOT_ROOT || '').trim() || path.join(String(env.DATA_DIR || '').trim() || path.join(os.homedir(), '.pivot'), 'workspace-recovery-snapshots')); }
function isWithin(root, target) { const relative = path.relative(root, target); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
function isSensitiveSnapshotFile(target) {
    const name = path.basename(target).toLowerCase();
    return name === '.env' || name === '.npmrc' || name === '.pypirc' || name === 'credentials.json'
        || /(?:^|\.)pem$|(?:^|\.)key$|\.pfx$|\.p12$|\.kdbx$/.test(name);
}
function collectFiles(root) {
    const output = [];
    const visit = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            const target = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) visit(target);
            else if (entry.isFile() && !isSensitiveSnapshotFile(target)) output.push(target);
            if (output.length > MAX_FILES) throw snapshotError('工作区恢复快照文件数超过安全上限。', 'AGENT_WORKSPACE_RECOVERY_SNAPSHOT_TOO_MANY_FILES');
        }
    };
    visit(root); return output;
}
function createWorkspaceRecoverySnapshot({ root, worktreeName, branch = '', head = '', revision = '', env = process.env } = {}) {
    const workspace = fs.realpathSync(String(root || ''));
    if (!fs.statSync(workspace).isDirectory()) throw snapshotError('恢复快照必须来自目录工作区。', 'AGENT_WORKSPACE_RECOVERY_SNAPSHOT_ROOT_INVALID');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(worktreeName || ''))) throw snapshotError('恢复快照必须关联受控影子工作树。', 'AGENT_WORKSPACE_RECOVERY_SNAPSHOT_WORKTREE_INVALID');
    let bytes = 0;
    const files = collectFiles(workspace).map(file => {
        const stat = fs.statSync(file); bytes += stat.size;
        if (bytes > MAX_BYTES) throw snapshotError('工作区恢复快照超过 20MB 安全上限。', 'AGENT_WORKSPACE_RECOVERY_SNAPSHOT_TOO_LARGE');
        return { path: path.relative(workspace, file).replace(/\\/g, '/'), content: fs.readFileSync(file).toString('base64') };
    });
    const archive = { version: 1, worktreeName, branch: String(branch).slice(0, 160), head: String(head).slice(0, 40), revision: String(revision).slice(0, 64), files };
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify(archive)), { level: 9 });
    const archiveDigest = crypto.createHash('sha256').update(payload).digest('hex');
    const rootDir = snapshotRoot(env); fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const target = path.join(rootDir, `${archiveDigest}.json.gz`);
    if (!isWithin(rootDir, target)) throw snapshotError('恢复快照路径无效。', 'AGENT_WORKSPACE_RECOVERY_SNAPSHOT_PATH_INVALID');
    if (!fs.existsSync(target)) fs.writeFileSync(target, payload, { mode: 0o600, flag: 'wx' });
    return { archiveDigest, restoreHandle: `local-recovery:${archiveDigest}`, fileCount: files.length, byteCount: bytes };
}
function restoreWorkspaceRecoverySnapshot({ archiveDigest, restoreHandle, targetRoot, env = process.env } = {}) {
    const digest = String(archiveDigest || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest) || restoreHandle !== `local-recovery:${digest}`) throw snapshotError('恢复句柄或归档摘要无效。', 'AGENT_WORKSPACE_RECOVERY_RESTORE_HANDLE_INVALID');
    const target = path.resolve(String(targetRoot || ''));
    if (!target || fs.existsSync(target)) throw snapshotError('恢复目标必须是不存在的新目录，不能覆盖现有工作区。', 'AGENT_WORKSPACE_RECOVERY_RESTORE_TARGET_EXISTS');
    const source = path.join(snapshotRoot(env), `${digest}.json.gz`);
    const payload = fs.readFileSync(source);
    if (crypto.createHash('sha256').update(payload).digest('hex') !== digest) throw snapshotError('恢复归档摘要校验失败。', 'AGENT_WORKSPACE_RECOVERY_RESTORE_DIGEST_MISMATCH');
    let archive;
    try { archive = JSON.parse(zlib.gunzipSync(payload).toString('utf8')); } catch (_) { throw snapshotError('恢复归档格式无效。', 'AGENT_WORKSPACE_RECOVERY_RESTORE_ARCHIVE_INVALID'); }
    if (!Array.isArray(archive.files) || archive.files.length > MAX_FILES) throw snapshotError('恢复归档文件清单无效。', 'AGENT_WORKSPACE_RECOVERY_RESTORE_ARCHIVE_INVALID');
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    let bytes = 0;
    try {
        for (const item of archive.files) {
            const relative = String(item?.path || '').replace(/\\/g, '/');
            const output = path.resolve(target, relative);
            if (!relative || relative.includes('..') || !isWithin(target, output)) throw snapshotError('恢复归档包含越界路径。', 'AGENT_WORKSPACE_RECOVERY_RESTORE_PATH_DENIED');
            const content = Buffer.from(String(item?.content || ''), 'base64'); bytes += content.length;
            if (bytes > MAX_BYTES) throw snapshotError('恢复归档超过安全上限。', 'AGENT_WORKSPACE_RECOVERY_RESTORE_TOO_LARGE');
            fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.writeFileSync(output, content, { mode: 0o600, flag: 'wx' });
        }
    } catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
    return { worktreeName: String(archive.worktreeName || ''), restoredFileCount: archive.files.length, restoredByteCount: bytes, archiveDigest: digest, restoreHandle };
}
module.exports = { createWorkspaceRecoverySnapshot, restoreWorkspaceRecoverySnapshot, snapshotRoot };
