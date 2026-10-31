const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    BROWSER_RUNTIME_RESOURCE,
    PDF_SOURCE_MAP_EXCLUDES,
    applyDesktopRuntimeProfile,
    prepareDesktopRuntimeProfile,
    resolveDesktopRuntimeProfile
} = require('../scripts/desktop_runtime_profile');

function packageManifest(resources = []) {
    return { build: { extraResources: resources.map(resource => ({ ...resource })) } };
}

test('远程桌面包默认不携带本地 Chromium 运行时，本地档位才注入它', () => {
    const remote = packageManifest([BROWSER_RUNTIME_RESOURCE, { from: 'config.json', to: 'config.json' }]);
    assert.deepEqual(applyDesktopRuntimeProfile(remote, 'remote'), { profile: 'remote', includesBrowserRuntime: false });
    assert.equal(remote.build.extraResources.some(resource => resource.from === BROWSER_RUNTIME_RESOURCE.from), false);

    const local = packageManifest([{ from: 'config.json', to: 'config.json' }]);
    assert.deepEqual(applyDesktopRuntimeProfile(local, 'local'), { profile: 'local', includesBrowserRuntime: true });
    assert.equal(local.build.extraResources.some(resource => resource.from === BROWSER_RUNTIME_RESOURCE.from && resource.to === BROWSER_RUNTIME_RESOURCE.to), true);
});

test('桌面包只排除 PDF 依赖的源码映射，保留运行文件和本地模式', () => {
    for (const mode of ['remote', 'local']) {
        const manifest = { build: { files: ['desktop/**', 'server/**', 'client/**', 'assets/fonts/cjk/**'], extraResources: [] } };
        applyDesktopRuntimeProfile(manifest, mode);
        applyDesktopRuntimeProfile(manifest, mode);
        assert.deepEqual(manifest.build.files.slice(0, 4), ['desktop/**', 'server/**', 'client/**', 'assets/fonts/cjk/**']);
        assert.deepEqual(manifest.build.files.slice(4), PDF_SOURCE_MAP_EXCLUDES);
        assert.ok(PDF_SOURCE_MAP_EXCLUDES.every(pattern => pattern.endsWith('/**/*.map')));
    }
});

test('本地模式不能构建为缺少 Chromium 的远程档位', () => {
    assert.equal(resolveDesktopRuntimeProfile({ mode: 'remote' }, ''), 'remote');
    assert.equal(resolveDesktopRuntimeProfile({ mode: 'local' }, ''), 'local');
    assert.equal(resolveDesktopRuntimeProfile({ mode: 'remote' }, 'local'), 'local');
    assert.throws(() => resolveDesktopRuntimeProfile({ mode: 'local' }, 'remote'), /本地模式配置/);
});

test('构建档位只临时改写 package.json，并在构建后完整恢复', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-runtime-profile-'));
    const packagePath = path.join(root, 'package.json');
    const original = JSON.stringify(packageManifest([{ from: 'config.json', to: 'config.json' }]), null, 2) + '\n';
    try {
        fs.writeFileSync(packagePath, original, 'utf8');
        const profile = prepareDesktopRuntimeProfile(root, { config: { mode: 'remote' } });
        assert.equal(profile.profile, 'remote');
        assert.equal(profile.includesBrowserRuntime, false);
        profile.restore();
        assert.equal(fs.readFileSync(packagePath, 'utf8'), original);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
