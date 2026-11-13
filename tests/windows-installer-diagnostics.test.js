'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

test('Windows 安装诊断仅输出更新策略白名单且不覆盖已有报告', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-installer-diagnostics-'));
    const config = path.join(root, 'resources/config.json');
    const output = path.join(root, 'report.json');
    const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = path.resolve(__dirname, '../scripts/collect_windows_installer_diagnostics.ps1');
    const args = ['-NoProfile', '-NonInteractive', '-File', script, '-InstallDirectory', root, '-OutputPath', output];
    try {
        await fs.mkdir(path.dirname(config));
        await fs.writeFile(config, JSON.stringify({ mode: 'remote', stealthSecret: 'test-secret-not-in-report', remoteUrl: 'http://user:private-password@example.test', autoUpdate: { enabled: true, publisherName: 'Pivot Local Dev', certificateSha256: 'ab'.repeat(32) } }));
        const before = await fs.readFile(config, 'utf8');
        await execute(executable, args, { windowsHide: true, timeout: 20000 });
        const text = await fs.readFile(output, 'utf8');
        const report = JSON.parse(text);
        const policy = report.updatePolicies.find(item => item.source === config.replaceAll('/', '\\'));
        assert.ok(policy);
        assert.equal(policy.publisherName, 'Pivot Local Dev');
        assert.equal(policy.certificateSha256, 'ab'.repeat(32));
        assert.doesNotMatch(text, /test-secret-not-in-report|private-password/);
        assert.equal(await fs.readFile(config, 'utf8'), before);
        await assert.rejects(execute(executable, args, { windowsHide: true, timeout: 20000 }));
        assert.equal(await fs.readFile(output, 'utf8'), text);
    } finally {
        assert.equal(path.dirname(root), os.tmpdir());
        await fs.rm(root, { recursive: true, force: true });
    }
});
