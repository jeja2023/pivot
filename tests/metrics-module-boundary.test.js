const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('metrics startup path does not read RAG recorders through a circular dependency', () => {
    const root = path.resolve(__dirname, '..');
    const result = spawnSync(process.execPath, [
        '--trace-warnings',
        '-e',
        "require('./server/metrics'); setTimeout(() => process.exit(0), 500)"
    ], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000
    });
    const diagnostics = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.status, 0, diagnostics);
    assert.doesNotMatch(diagnostics, /circular dependency/i);
    assert.doesNotMatch(diagnostics, /recordRagRetrieval|recordRagIngest/);
});
