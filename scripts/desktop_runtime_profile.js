'use strict';

const fs = require('fs');
const path = require('path');

const BROWSER_RUNTIME_RESOURCE = Object.freeze({
    from: 'artifacts/agent-browser-pack',
    to: 'agent-runtime/browser'
});
const RUNTIME_PROFILES = new Set(['remote', 'local']);

function normalizeDesktopRuntimeProfile(value) {
    const profile = String(value || '').trim().toLowerCase();
    if (!profile) return '';
    if (!RUNTIME_PROFILES.has(profile)) {
        throw new Error('PIVOT_DESKTOP_RUNTIME_PROFILE 只能是 remote 或 local。');
    }
    return profile;
}

function resolveDesktopRuntimeProfile(config = {}, requestedProfile = process.env.PIVOT_DESKTOP_RUNTIME_PROFILE) {
    const mode = String(config.mode || 'remote').trim().toLowerCase();
    const requested = normalizeDesktopRuntimeProfile(requestedProfile);
    if (mode === 'local' && requested === 'remote') {
        throw new Error('本地模式配置必须使用 local 桌面运行时包，不能排除 Chromium。');
    }
    return requested || (mode === 'local' ? 'local' : 'remote');
}

function isBrowserRuntimeResource(resource) {
    return resource
        && resource.from === BROWSER_RUNTIME_RESOURCE.from
        && resource.to === BROWSER_RUNTIME_RESOURCE.to;
}

function applyDesktopRuntimeProfile(packageJson, profile) {
    const normalized = normalizeDesktopRuntimeProfile(profile);
    if (!normalized) throw new Error('桌面运行时构建档位不能为空。');
    const build = packageJson?.build;
    if (!build || typeof build !== 'object') throw new Error('package.json 缺少 build 配置。');
    const resources = Array.isArray(build.extraResources) ? build.extraResources : [];
    const retained = resources.filter(resource => !isBrowserRuntimeResource(resource));
    if (normalized === 'local') retained.push({ ...BROWSER_RUNTIME_RESOURCE });
    build.extraResources = retained;
    return {
        profile: normalized,
        includesBrowserRuntime: normalized === 'local'
    };
}

function prepareDesktopRuntimeProfile(rootDir, { config = {}, profile } = {}) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '..'));
    const packagePath = path.join(root, 'package.json');
    const original = fs.readFileSync(packagePath, 'utf8');
    const packageJson = JSON.parse(original);
    const resolvedProfile = resolveDesktopRuntimeProfile(config, profile);
    const result = applyDesktopRuntimeProfile(packageJson, resolvedProfile);
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    return {
        ...result,
        restore: () => fs.writeFileSync(packagePath, original, 'utf8')
    };
}

module.exports = {
    BROWSER_RUNTIME_RESOURCE,
    applyDesktopRuntimeProfile,
    normalizeDesktopRuntimeProfile,
    prepareDesktopRuntimeProfile,
    resolveDesktopRuntimeProfile
};
