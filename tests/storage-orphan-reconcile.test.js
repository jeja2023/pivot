const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { reconcileUploadStorage } = require('../server/services/storage-gc');

test('storage reconciliation removes only aged unreferenced files inside the upload root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-orphan-storage-'));
    const referenced = path.join(root, 'referenced.txt');
    const orphan = path.join(root, 'nested', 'orphan.txt');
    const recent = path.join(root, 'recent.txt');
    const nowMs = Date.now();
    try {
        fs.mkdirSync(path.dirname(orphan), { recursive: true });
        fs.writeFileSync(referenced, 'keep');
        fs.writeFileSync(orphan, 'delete');
        fs.writeFileSync(recent, 'keep');
        fs.utimesSync(referenced, (nowMs - 3 * 86400000) / 1000, (nowMs - 3 * 86400000) / 1000);
        fs.utimesSync(orphan, (nowMs - 3 * 86400000) / 1000, (nowMs - 3 * 86400000) / 1000);
        const result = await reconcileUploadStorage({
            uploadDirectory: root,
            referencedPaths: [referenced],
            retentionDays: 1,
            nowMs,
            remove: true
        });
        assert.equal(result.deletedFiles, 1);
        assert.equal(fs.existsSync(referenced), true);
        assert.equal(fs.existsSync(recent), true);
        assert.equal(fs.existsSync(orphan), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
