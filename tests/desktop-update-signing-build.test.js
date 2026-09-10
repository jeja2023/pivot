const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    hasWindowsSigningCredential,
    normalizeWindowsUpdatePublisher,
    normalizeWindowsCertificateSha1,
    prepareWindowsUpdateSigningProfile
} = require('../scripts/desktop_update_signing');

test('Windows 更新签名构建资料需要发布者和实际 electron-builder 签名凭据', () => {
    assert.equal(normalizeWindowsUpdatePublisher('  Pivot   Release Signing '), 'Pivot Release Signing');
    assert.equal(normalizeWindowsUpdatePublisher(''), '');
    assert.equal(normalizeWindowsCertificateSha1('b1 acd270-210b82e9 add6cb09 5337 3e81 abd8 0ffc'), 'B1ACD270210B82E9ADD6CB0953373E81ABD80FFC');
    assert.equal(hasWindowsSigningCredential({ CSC_NAME: 'Pivot Certificate' }), false);
    assert.equal(hasWindowsSigningCredential({ PIVOT_WINDOWS_CERTIFICATE_SHA1: 'B1ACD270210B82E9ADD6CB0953373E81ABD80FFC' }), true);
    assert.equal(hasWindowsSigningCredential({ WIN_CSC_LINK: 'release.pfx' }), true);
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
            env: {
                PIVOT_WINDOWS_UPDATE_PUBLISHER: 'Pivot Release Signing',
                PIVOT_WINDOWS_CERTIFICATE_SHA1: 'B1ACD270210B82E9ADD6CB0953373E81ABD80FFC'
            }
        });
        const duringBuild = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        assert.equal(profile.publisherName, 'Pivot Release Signing');
        assert.equal(duringBuild.build.win.signtoolOptions.publisherName, 'Pivot Release Signing');
        assert.equal(duringBuild.build.win.signtoolOptions.certificateSha1, 'B1ACD270210B82E9ADD6CB0953373E81ABD80FFC');
        assert.equal(duringBuild.build.win.verifyUpdateCodeSignature, true);
        assert.equal(duringBuild.build.win.forceCodeSigning, true);
        profile.restore();
        assert.equal(fs.readFileSync(packagePath, 'utf8'), original);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
