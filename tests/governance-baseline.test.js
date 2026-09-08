const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('治理基线只保留仍超过大文件阈值的文件，并要求缩小后同步收紧', () => {
    const root = path.resolve(__dirname, '..');
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'governance_baseline.json'), 'utf8'));
    const checker = fs.readFileSync(path.join(root, 'scripts', 'check_governance_metrics.js'), 'utf8');
    Object.keys(baseline.files).forEach(file => {
        const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).length;
        assert.ok(lines > baseline.largeFileThreshold, `${file} 已不应享有大文件基线豁免`);
    });
    assert.match(checker, /BASELINE_SHRINK_GRACE/);
    assert.match(checker, /同步收紧治理基线/);
});
