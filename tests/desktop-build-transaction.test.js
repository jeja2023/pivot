const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    beginDesktopBuildTransaction,
    recoverPendingDesktopBuildTransaction,
    statePathFor
} = require('../scripts/desktop_build_transaction');

test('中断的桌面构建会在下一次启动前恢复 package 与客户端配置', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-build-transaction-'));
    const packagePath = path.join(root, 'package.json');
    const configPath = path.join(root, 'config.json');
    const originalPackage = '{"name":"fixture"}\n';
    const originalConfig = '{"mode":"remote"}\n';
    try {
        fs.writeFileSync(packagePath, originalPackage);
        fs.writeFileSync(configPath, originalConfig);
        const transaction = beginDesktopBuildTransaction(root);
        fs.writeFileSync(packagePath, '{"name":"temporary"}\n');
        fs.writeFileSync(configPath, '{"mode":"temporary"}\n');
        assert.equal(fs.existsSync(transaction.statePath), true);
        assert.equal(recoverPendingDesktopBuildTransaction(root), true);
        assert.equal(fs.readFileSync(packagePath, 'utf8'), originalPackage);
        assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
        assert.equal(fs.existsSync(statePathFor(root)), false);
    } finally {
        fs.rmSync(statePathFor(root), { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('构建事务拒绝伪造状态中的工作区外恢复目标', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-build-transaction-invalid-'));
    try {
        fs.writeFileSync(path.join(root, 'package.json'), '{}');
        fs.writeFileSync(path.join(root, 'config.json'), '{}');
        fs.writeFileSync(statePathFor(root), JSON.stringify({ root, files: { '../outside': 'x' } }));
        assert.throws(() => recoverPendingDesktopBuildTransaction(root), /无效|未授权/);
    } finally {
        fs.rmSync(statePathFor(root), { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});
