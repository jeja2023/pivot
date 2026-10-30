const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { removeClosedBrowserProfile } = require('../server/services/agent-browser-profile-cleanup');

test('只删除受控会话的浏览器目录', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-profile-test-'));
    const id = `browser_${'a'.repeat(32)}`;
    try {
        await fs.mkdir(path.join(root, id));
        await fs.writeFile(path.join(root, id, 'profile'), 'data');
        await fs.writeFile(path.join(root, 'keep'), 'data');
        assert.equal(await removeClosedBrowserProfile('../keep', root), false);
        assert.equal(await removeClosedBrowserProfile(id, root), true);
        await assert.rejects(fs.stat(path.join(root, id)), { code: 'ENOENT' });
        assert.equal(await fs.readFile(path.join(root, 'keep'), 'utf8'), 'data');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
