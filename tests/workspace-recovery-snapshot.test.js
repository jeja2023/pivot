'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspaceRecoverySnapshot, restoreWorkspaceRecoverySnapshot } = require('../desktop/workspace-recovery-snapshot');
test('workspace recovery snapshot is content addressed, local-only, and excludes git metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-recovery-workspace-')); const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-recovery-data-'));
    try { fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git', 'secret'), 'never'); fs.writeFileSync(path.join(root, '.env'), 'SECRET=never'); fs.writeFileSync(path.join(root, 'deploy.pem'), 'PRIVATE=never'); fs.writeFileSync(path.join(root, 'a.txt'), 'recover me'); const snapshot = createWorkspaceRecoverySnapshot({ root, worktreeName: 'recovery-one', env: { DATA_DIR: data } }); assert.match(snapshot.archiveDigest, /^[a-f0-9]{64}$/); assert.equal(snapshot.restoreHandle, `local-recovery:${snapshot.archiveDigest}`); assert.equal(snapshot.fileCount, 1); assert.equal(fs.existsSync(path.join(data, 'workspace-recovery-snapshots', `${snapshot.archiveDigest}.json.gz`)), true); } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); }
});
test('workspace recovery restores only to a new directory after digest and handle verification', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-recovery-source-')); const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-recovery-store-')); const target = path.join(os.tmpdir(), `pivot-recovery-target-${process.pid}-${Date.now()}`);
    try { fs.writeFileSync(path.join(root, 'a.txt'), 'recover me'); const snapshot = createWorkspaceRecoverySnapshot({ root, worktreeName: 'recovery-two', env: { DATA_DIR: data } }); const restored = restoreWorkspaceRecoverySnapshot({ ...snapshot, targetRoot: target, env: { DATA_DIR: data } }); assert.equal(restored.restoredFileCount, 1); assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'recover me'); assert.throws(() => restoreWorkspaceRecoverySnapshot({ ...snapshot, targetRoot: target, env: { DATA_DIR: data } }), error => error.code === 'AGENT_WORKSPACE_RECOVERY_RESTORE_TARGET_EXISTS'); } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); }
});
