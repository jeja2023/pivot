'use strict';

/**
 * 清理确定不会被 Node 生产运行时加载的依赖文件。
 *
 * 这个脚本只处理经过运行时探针验证的白名单，不能把“可选数据库驱动”
 * 一并删掉：后者是否需要由具体部署的 MCP 数据库类型决定。
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const PRUNABLE_PATHS = [
    '@types',
    '@azure/msal-browser'
];

function assertInside(parent, target) {
    const relative = path.relative(parent, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`拒绝清理 node_modules 目录之外的路径：${target}`);
    }
}

function verifyAzureIdentityDoesNotLoadBrowserPackage(nodeModulesDir) {
    const browserPackage = path.join(nodeModulesDir, '@azure', 'msal-browser');
    if (!fs.existsSync(browserPackage)) return;

    const probePath = path.join(nodeModulesDir, '__pivot_runtime_probe__.js');
    const requireFromTarget = createRequire(probePath);
    let identityPath;
    try {
        identityPath = requireFromTarget.resolve('@azure/identity');
    } catch (error) {
        throw new Error(`无法验证 @azure/msal-browser 是否可裁剪：未找到 @azure/identity（${error.message}）。`);
    }
    requireFromTarget(identityPath);

    const browserRoot = path.resolve(browserPackage) + path.sep;
    const loadedBrowserModule = Object.keys(require.cache).find(file => {
        const resolved = path.resolve(file);
        return resolved === browserPackage || resolved.startsWith(browserRoot);
    });
    if (loadedBrowserModule) {
        throw new Error(`@azure/identity 在 Node 运行时加载了浏览器包，拒绝裁剪：${loadedBrowserModule}`);
    }
}

function pruneRuntimeModules(nodeModulesDir, options = {}) {
    const root = path.resolve(nodeModulesDir || path.join(process.cwd(), 'node_modules'));
    if (!fs.statSync(root).isDirectory()) throw new Error(`node_modules 目录不存在：${root}`);

    if (options.verifyAzureIdentity !== false) {
        verifyAzureIdentityDoesNotLoadBrowserPackage(root);
    }

    const removed = [];
    for (const relativePath of PRUNABLE_PATHS) {
        const target = path.resolve(root, relativePath);
        assertInside(root, target);
        if (!fs.existsSync(target)) continue;
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
        removed.push(relativePath);
    }
    return { nodeModulesDir: root, removed };
}

function parseNodeModulesArg(args) {
    const index = args.indexOf('--node-modules');
    if (index === -1) return path.join(process.cwd(), 'node_modules');
    const value = args[index + 1];
    if (!value || value.startsWith('-')) throw new Error('--node-modules 必须提供目录路径。');
    return value;
}

if (require.main === module) {
    const result = pruneRuntimeModules(parseNodeModulesArg(process.argv.slice(2)));
    console.log(`[prune-runtime-modules] 已移除：${result.removed.length ? result.removed.join(', ') : '无'}。`);
}

module.exports = {
    PRUNABLE_PATHS,
    assertInside,
    pruneRuntimeModules,
    verifyAzureIdentityDoesNotLoadBrowserPackage
};
