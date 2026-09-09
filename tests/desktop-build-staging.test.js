const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDesktopBuildStaging } = require('../scripts/desktop_build_staging');

function writePackage(root, name) {
    const packageDir = path.join(root, 'node_modules', ...name.split('/'));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}

test('桌面构建把分发密钥和构建覆盖写入系统 staging，而不改写工作区配置', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-staging-root-'));
    const originalConfig = '{"mode":"remote","stealthSecret":"development-only"}\n';
    try {
        fs.writeFileSync(path.join(root, 'config.json'), originalConfig);
        ['mysql2', 'mssql', 'mongodb'].forEach(name => writePackage(root, name));
        const staging = createDesktopBuildStaging(root, {
            bundledConfig: { mode: 'remote', remoteUrl: 'https://pivot.example.com/', stealthSecret: 'release-secret' },
            packageJson: {
                name: 'fixture',
                dependencies: { mysql2: '1.0.0', mssql: '1.0.0', mongodb: '1.0.0' },
                build: {
                    files: ['desktop/**'],
                    extraResources: [{ from: 'config.json', to: 'config.json' }]
                }
            },
            runtimeProfile: { config: { mode: 'remote' } },
            environment: {}
        });
        const buildConfig = JSON.parse(fs.readFileSync(staging.builderConfigPath, 'utf8'));
        assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), originalConfig);
        assert.equal(JSON.parse(fs.readFileSync(staging.configPath, 'utf8')).stealthSecret, 'release-secret');
        assert.equal(buildConfig.extraResources.some(item => item.from === staging.configPath && item.to === 'config.json'), true);
        assert.equal(buildConfig.extraResources.some(item => item.from === 'config.json'), false);
        assert.equal(staging.desktopRuntimeProfile.profile, 'remote');
        staging.cleanup();
        assert.equal(fs.existsSync(staging.stagingDir), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('桌面打包只清理显式目标目录并校验独立输出路径', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package_desktop.js'), 'utf8');
    assert.match(source, /--output-dir=/);
    assert.match(source, /path\.basename\(target\)\.startsWith\('dist-electron'\)/);
    assert.match(source, /fs\.rmSync\(electronOutputDir/);
    assert.doesNotMatch(source, /readdirSync\(root[\s\S]*startsWith\('dist-electron'\)/);
});
