'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyDesktopConnectorProfile } = require('./desktop_optional_database_connectors');
const { applyDesktopRuntimeProfile, resolveDesktopRuntimeProfile } = require('./desktop_runtime_profile');
const { applyWindowsUpdateSigningProfile } = require('./desktop_update_signing');

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function writePrivateJson(target, value) {
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch (_) {}
}

function isBundledConfigResource(resource) {
    return resource && resource.from === 'config.json' && resource.to === 'config.json';
}

function createDesktopBuildStaging(rootDir, {
    bundledConfig,
    connectors,
    environment = process.env,
    packageJson,
    runtimeProfile,
    windowsRelease = false
} = {}) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '..'));
    if (!bundledConfig || typeof bundledConfig !== 'object') throw new Error('桌面构建 staging 缺少分发配置。');
    const manifest = cloneJson(packageJson || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-build-'));
    const configPath = path.join(stagingDir, 'config.json');
    const builderConfigPath = path.join(stagingDir, 'electron-builder.json');
    try {
        writePrivateJson(configPath, bundledConfig);
        const connectorProfile = applyDesktopConnectorProfile(manifest, { rootDir: root, connectors });
        const signingProfile = applyWindowsUpdateSigningProfile(manifest, {
            env: environment,
            required: windowsRelease
        });
        const resolvedRuntimeProfile = resolveDesktopRuntimeProfile(runtimeProfile?.config || {}, runtimeProfile?.profile);
        const desktopRuntimeProfile = applyDesktopRuntimeProfile(manifest, resolvedRuntimeProfile);
        manifest.build.extraResources = (manifest.build.extraResources || [])
            .filter(resource => !isBundledConfigResource(resource));
        manifest.build.extraResources.push({ from: configPath, to: 'config.json' });
        // staging 配置不再依赖配置文件所在目录；所有脚本都显式相对工作区解析。
        manifest.build.afterPack = path.join(root, 'scripts', 'after-pack.js');
        writePrivateJson(builderConfigPath, manifest.build);
        return {
            builderConfigPath,
            configPath,
            connectorProfile,
            desktopRuntimeProfile,
            stagingDir,
            signingProfile,
            cleanup() {
                fs.rmSync(stagingDir, { recursive: true, force: true });
            }
        };
    } catch (error) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw error;
    }
}

module.exports = { createDesktopBuildStaging, isBundledConfigResource };
