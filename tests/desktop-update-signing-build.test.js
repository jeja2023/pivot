const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    hasWindowsSigningCredential,
    normalizeWindowsUpdatePublisher,
    prepareWindowsUpdateSigningProfile
} = require('../scripts/desktop_update_signing');

test('Windows 更新签名构建资料需要发布者和实际 electron-builder 签名凭据', () => {
    assert.equal(normalizeWindowsUpdatePublisher('  Pivot   Release Signing '), 'Pivot Release Signing');
    assert.equal(normalizeWindowsUpdatePublisher(''), '');
    assert.equal(hasWindowsSigningCredential({ CSC_NAME: 'Pivot Certificate' }), true);
    assert.equal(hasWindowsSigningCredential({}), false);
});

test('Windows 更新签名构建配置仅临时写入 publisherName，并在结束后恢复', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-update-signing-build-'));
    const packagePath = path.join(root, 'package.json');
    const original = JSON.stringify({ name: 'fixture', build: { win: { target: ['nsis'] } } }, null, 2) + '\n';
    try {
        fs.writeFileSync(packagePath, original);
        assert.throws(
            () => prepareWindowsUpdateSigningProfile(root, { required: true, env: {} }),
            /PIVOT_WINDOWS_UPDATE_PUBLISHER/
        );
        const profile = prepareWindowsUpdateSigningProfile(root, {
            required: true,
            env: { PIVOT_WINDOWS_UPDATE_PUBLISHER: 'Pivot Release Signing', CSC_NAME: 'Pivot Release Signing' }
        });
        const duringBuild = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        assert.equal(profile.publisherName, 'Pivot Release Signing');
        assert.equal(duringBuild.build.win.publisherName, 'Pivot Release Signing');
        assert.equal(duringBuild.build.win.verifyUpdateCodeSignature, true);
        profile.restore();
        assert.equal(fs.readFileSync(packagePath, 'utf8'), original);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
