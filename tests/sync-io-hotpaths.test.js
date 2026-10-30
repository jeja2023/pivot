'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('热路径门禁识别同步子进程和压缩调用并避免 DuckDB 误报', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-sync-io-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'server/routes'), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../scripts/check_sync_io_hotpaths.js'), path.join(root, 'scripts/check_sync_io_hotpaths.js'));
    const file = path.join(root, 'server/routes/example.js');
    const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/check_sync_io_hotpaths.js')], {
        encoding: 'utf8', env: { ...process.env, NODE_PATH: path.resolve(__dirname, '../node_modules') }
    });
    fs.writeFileSync(file, 'connection.closeSync();\n');
    assert.equal(run().status, 0);
    fs.writeFileSync(file, "const { execFileSync: execute } = require('node:child_process');\nconst zip = require('zlib');\nexecute('x');\nzip.gzipSync('x');\nrequire('child_process').spawnSync('x');\n");
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /execFileSync/);
    assert.match(result.stderr, /gzipSync/);
    assert.match(result.stderr, /spawnSync/);
});
