const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { db } = require('../server/db');

test('测试同步数据库 facade 通过共享内存 Worker 执行查询，不再轮询临时 JSON 文件', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'test-sync-db.js'), 'utf8');
    assert.match(source, /SharedArrayBuffer/);
    assert.match(source, /new Worker/);
    assert.doesNotMatch(source, /mkdtempSync|request\.json|response\.json|existsSync/);
    assert.equal(db.prepare('SELECT 1 AS value').get().value, 1);
});
