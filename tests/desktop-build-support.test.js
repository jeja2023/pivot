const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    assertBuildHost,
    assertLinuxPackageMetadata,
    assertRuntimeManifest,
    parseChecksumManifest,
    resolveBuildTarget,
    writePlatformChecksumManifest
} = require('../scripts/desktop-build-support');

test('desktop build targets only expose supported Linux architectures', () => {
    assert.deepEqual(resolveBuildTarget(['deb', '--x64'], { arch: 'x64' }), {
        platform: 'linux', arch: 'x64', target: 'deb', key: 'linux-amd64'
    });
    assert.deepEqual(resolveBuildTarget(['AppImage', '--arm64'], { arch: 'x64' }), {
        platform: 'linux', arch: 'arm64', target: 'AppImage', key: 'linux-arm64'
    });
    assert.throws(() => resolveBuildTarget(['deb', '--loong64']), /LoongArch64/);
});

test('Linux build host validation rejects accidental cross-architecture node_modules', () => {
    assert.doesNotThrow(() => assertBuildHost({ platform: 'linux', arch: 'arm64' }, { platform: 'linux', arch: 'arm64' }, {}));
    assert.throws(
        () => assertBuildHost({ platform: 'linux', arch: 'arm64' }, { platform: 'win32', arch: 'x64' }, {}),
        /Linux.*构建机|目标架构/
    );
    assert.throws(() => assertBuildHost({ platform: 'linux', arch: 'arm64' }, { platform: 'linux', arch: 'x64' }, {}), /目标架构/);
});

test('Linux metadata and icon checks reject incomplete packages', () => {
    const pkg = {
        author: { name: 'Pivot', email: 'release@example.com' },
        homepage: 'https://example.com/pivot',
        license: 'UNLICENSED',
        build: { linux: { icon: 'icon.png' } }
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-build-'));
    try {
        fs.writeFileSync(path.join(root, 'icon.png'), 'png');
        assert.doesNotThrow(() => assertLinuxPackageMetadata(pkg, root));
        assert.throws(() => assertLinuxPackageMetadata({ ...pkg, homepage: '' }, root), /homepage/);
        assert.throws(() => assertLinuxPackageMetadata({ ...pkg, build: { linux: { icon: 'icon.ico' } } }, root), /PNG/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('platform checksum manifests do not overwrite other architecture entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-checksums-'));
    try {
        fs.writeFileSync(path.join(root, 'pivot_amd64.deb'), 'amd64');
        fs.writeFileSync(path.join(root, 'pivot_arm64.deb'), 'arm64');
        writePlatformChecksumManifest(root, ['pivot_amd64.deb'], { key: 'linux-amd64' });
        writePlatformChecksumManifest(root, ['pivot_arm64.deb'], { key: 'linux-arm64' });
        assert.equal(parseChecksumManifest(fs.readFileSync(path.join(root, 'SHA256SUMS-linux-amd64.txt'), 'utf8')).size, 1);
        assert.equal(parseChecksumManifest(fs.readFileSync(path.join(root, 'SHA256SUMS-linux-arm64.txt'), 'utf8')).size, 1);
        assert.equal(parseChecksumManifest(fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8')).size, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime manifest validation enforces target platform and architecture', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-runtime-manifest-'));
    const manifestPath = path.join(root, 'manifest.json');
    try {
        fs.mkdirSync(path.join(root, 'bin'));
        fs.writeFileSync(path.join(root, 'bin', 'runtime'), 'runtime');
        fs.writeFileSync(manifestPath, JSON.stringify({ platform: 'linux', arch: 'arm64', bundled: true, executable: 'bin/runtime' }));
        assert.doesNotThrow(() => assertRuntimeManifest(manifestPath, { platform: 'linux', arch: 'arm64' }, { requireBundled: true }));
        assert.throws(() => assertRuntimeManifest(manifestPath, { platform: 'linux', arch: 'x64' }), /架构不匹配/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('desktop package excludes build-time scripts that have no runtime import path', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.build.files.includes('scripts/**'), false);
    assert.equal(pkg.build.extraResources.some(item => item.from === 'artifacts/agent-browser-pack'), false);
});

test('desktop packaging applies the optional database connector profile before electron-builder runs', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package_desktop.js'), 'utf8');
    const profile = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'desktop_optional_database_connectors.js'), 'utf8');
    assert.match(script, /prepareDesktopConnectorProfile\(root\)/);
    assert.match(profile, /PIVOT_DESKTOP_DB_CONNECTORS/);
    assert.match(script, /restoreDesktopConnectorProfile\(\)/);
});

test('unpacked Windows smoke builds disable auto update unless a signed publisher profile is injected', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package_desktop.js'), 'utf8');
    assert.match(script, /config\.autoUpdate\.enabled = false/);
    assert.match(script, /windowsTarget: buildTarget\.platform === 'win32'/);
    assert.match(script, /windowsUpdatePublisher: windowsUpdateSigningProfile\.publisherName/);
});

test('release desktop builds require a dedicated distribution configuration rather than the development config', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package_desktop.js'), 'utf8');
    const distributionConfig = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'desktop_distribution_config.js'), 'utf8');
    assert.match(script, /requireDistributionConfig: !rawBuilderArgs\.includes\('--dir'\)/);
    assert.match(distributionConfig, /PIVOT_DISTRIBUTION_CONFIG/);
});

test('desktop packaging only assembles and verifies Chromium for the local runtime profile', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package_desktop.js'), 'utf8');
    assert.match(script, /prepareDesktopRuntimeProfile\(root/);
    assert.match(script, /if \(desktopRuntimeProfile\.includesBrowserRuntime\)/);
    assert.match(script, /PIVOT_VERIFY_DESKTOP_BROWSER_RUNTIME/);
});
