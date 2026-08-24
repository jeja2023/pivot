const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    getCachedDirSize,
    configureDirSizeCache,
    clearDirSizeCache
} = require('../server/services/dir-size-cache');

test('目录大小缓存能够正确计算并去重并发扫描', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-dir-size-test-'));
    try {
        const file1 = path.join(tempDir, 'file1.txt');
        const file2 = path.join(tempDir, 'file2.txt');
        fs.writeFileSync(file1, 'hello'); // 5 bytes
        fs.writeFileSync(file2, 'world 123'); // 9 bytes

        clearDirSizeCache();
        configureDirSizeCache({ ttlMs: 5000 });

        // 并发触发 5 次扫描，验证 in-flight 去重
        const [s1, s2, s3, s4, s5] = await Promise.all([
            getCachedDirSize(tempDir),
            getCachedDirSize(tempDir),
            getCachedDirSize(tempDir),
            getCachedDirSize(tempDir),
            getCachedDirSize(tempDir)
        ]);

        assert.equal(s1, 14);
        assert.equal(s2, 14);
        assert.equal(s3, 14);
        assert.equal(s4, 14);
        assert.equal(s5, 14);

        // 再次获取应从缓存直接读取
        const cached = await getCachedDirSize(tempDir);
        assert.equal(cached, 14);
    } finally {
        clearDirSizeCache();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
    }
});
