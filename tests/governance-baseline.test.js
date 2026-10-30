const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

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

test('字节门禁阻止压缩行数绕过大文件限制，且跨换行格式一致', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-governance-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const dir of ['scripts', 'server', 'client', 'desktop', 'tests/e2e']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../scripts/check_governance_metrics.js'), path.join(root, 'scripts/check_governance_metrics.js'));
    const baseline = { largeFileThreshold: 1000, largeFileByteThreshold: 61440, legacyWindowGlobalBudget: 0, files: {}, byteFiles: {} };
    const saveBaseline = () => fs.writeFileSync(path.join(root, 'scripts/governance_baseline.json'), JSON.stringify(baseline));
    const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/check_governance_metrics.js')], { encoding: 'utf8' });
    const file = path.join(root, 'client', 'large.js');
    const source = `${'x'.repeat(61440)}\n`;
    fs.writeFileSync(file, source);
    saveBaseline();
    assert.notEqual(run().status, 0, '新增超限文件应被拒绝');
    baseline.byteFiles['client/large.js'] = Buffer.byteLength(source);
    saveBaseline();
    fs.writeFileSync(file, source.replace(/\n/g, '\r\n'));
    assert.equal(run().status, 0, 'CRLF 检出应与 LF 使用同一字节预算');
    fs.appendFileSync(file, 'x');
    assert.notEqual(run().status, 0, '存量超限文件增长应被拒绝');
    fs.writeFileSync(file, 'short');
    assert.notEqual(run().status, 0, '降至阈值以下后应移除基线');
});
