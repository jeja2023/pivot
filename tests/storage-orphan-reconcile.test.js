const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { reconcileUploadStorage } = require('../server/services/storage-gc');

test('自定义上传目录通过数据库逻辑引用保护旧文件，查询失败停止清理', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-custom-storage-'));
    const referenced = path.join(root, '7', '会话', '资料.txt');
    const dotted = path.join(root, '..资料.txt');
    const orphan = path.join(root, 'orphan.txt');
    try {
        fs.mkdirSync(path.dirname(referenced), { recursive: true });
        for (const file of [referenced, dotted, orphan]) {
            fs.writeFileSync(file, '保留校验');
            const old = new Date(Date.now() - 40 * 86400000);
            fs.utimesSync(file, old, old);
        }
        await assert.rejects(reconcileUploadStorage({ uploadDirectory: root, queryFn: async () => { throw new Error('引用查询失败'); } }), /引用查询失败/);
        assert.ok(fs.existsSync(orphan));
        const result = await reconcileUploadStorage({ uploadDirectory: root, retentionDays: 30, queryFn: async sql => sql.includes('FROM attachments')
            ? [{ path: 'uploads/7/会话/资料.txt' }, { path: 'uploads/..资料.txt' }, { path: 'uploads/../../outside.txt' }] : [] });
        assert.equal(result.referenced, 2);
        assert.equal(result.deletedFiles, 1);
        assert.ok(fs.existsSync(referenced));
        assert.ok(fs.existsSync(dotted));
        assert.equal(fs.existsSync(orphan), false);
    } finally {
        assert.equal(path.dirname(path.resolve(root)), fs.realpathSync(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

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
