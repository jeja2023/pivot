'use strict';

/**
 * Docker 生产依赖树中，MySQL / SQL Server / MongoDB 仅由数据库 MCP 按需加载。
 * 该脚本根据实际 package.json 依赖图删除未选连接器及其不可达闭包，避免维护一份
 * 容易漂移的传递依赖删除名单。仅用于已经 `npm ci --omit=dev` 的构建目录。
 */
const fs = require('fs');
const path = require('path');

const CONNECTORS = Object.freeze({
    mysql: 'mysql2',
    mssql: 'mssql',
    mongodb: 'mongodb'
});

function assertInside(parent, target) {
    const relative = path.relative(parent, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`拒绝清理 node_modules 目录之外的路径：${target}`);
    }
}

function parseConnectorList(value = '') {
    const names = new Set(String(value || '')
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean));
    const unsupported = [...names].filter(name => !Object.hasOwn(CONNECTORS, name));
    if (unsupported.length) {
        throw new Error(`未知的 PIVOT_DB_CONNECTORS 值：${unsupported.join(', ')}。仅支持 mysql、mssql、mongodb。`);
    }
    return names;
}

function readManifest(packagePath) {
    const manifestPath = path.join(packagePath, 'package.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error(`无法读取依赖清单：${manifestPath}（${error.message}）`);
    }
}

function resolveDependency(packagePath, dependencyName, nodeModulesDir) {
    let current = path.resolve(packagePath);
    const root = path.resolve(nodeModulesDir);
    while (current.startsWith(root)) {
        const direct = path.join(current, 'node_modules', dependencyName);
        if (fs.existsSync(path.join(direct, 'package.json'))) return path.resolve(direct);
        if (path.basename(current) === 'node_modules') {
            const hoisted = path.join(current, dependencyName);
            if (fs.existsSync(path.join(hoisted, 'package.json'))) return path.resolve(hoisted);
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

function dependencyNames(manifest = {}) {
    return new Set([
        ...Object.keys(manifest.dependencies || {}),
        ...Object.keys(manifest.optionalDependencies || {}),
        ...Object.keys(manifest.peerDependencies || {})
    ]);
}

function collectReachablePackages(nodeModulesDir, projectManifest, enabledConnectors) {
    const root = path.resolve(nodeModulesDir);
    const rootDependencies = new Set(Object.keys(projectManifest?.dependencies || {}));
    Object.entries(CONNECTORS).forEach(([connector, packageName]) => {
        if (!enabledConnectors.has(connector)) rootDependencies.delete(packageName);
    });

    const reachable = new Set();
    const pending = [];
    rootDependencies.forEach(name => {
        const packagePath = resolveDependency(root, name, root);
        if (!packagePath) throw new Error(`生产依赖缺失，无法计算裁剪闭包：${name}`);
        pending.push(packagePath);
    });

    while (pending.length) {
        const packagePath = pending.pop();
        if (reachable.has(packagePath)) continue;
        const manifest = readManifest(packagePath);
        if (!manifest) throw new Error(`依赖目录缺少 package.json：${packagePath}`);
        reachable.add(packagePath);
        dependencyNames(manifest).forEach(name => {
            const dependencyPath = resolveDependency(packagePath, name, root);
            // optionalDependencies 会按 OS/CPU 缺失；缺失时不把正常的平台筛选当成构建错误。
            if (dependencyPath) pending.push(dependencyPath);
        });
    }
    return reachable;
}

function collectPackageDirectories(dir, nodeModulesDir, packages = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '.bin' || entry.name.startsWith('.')) continue;
        const target = path.join(dir, entry.name);
        if (entry.name.startsWith('@')) {
            collectPackageDirectories(target, nodeModulesDir, packages);
            continue;
        }
        if (fs.existsSync(path.join(target, 'package.json'))) {
            packages.push(path.resolve(target));
        }
        const nested = path.join(target, 'node_modules');
        if (fs.existsSync(nested)) collectPackageDirectories(nested, nodeModulesDir, packages);
    }
    return packages;
}

function isNestedBelow(candidate, parent) {
    const relative = path.relative(parent, candidate);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function pruneOptionalDatabaseConnectors({ nodeModulesDir, projectManifest, connectors = '', dryRun = false } = {}) {
    const root = path.resolve(nodeModulesDir || path.join(process.cwd(), 'node_modules'));
    if (!fs.statSync(root).isDirectory()) throw new Error(`node_modules 目录不存在：${root}`);
    const enabledConnectors = connectors instanceof Set ? connectors : parseConnectorList(connectors);
    const manifest = projectManifest || readManifest(path.resolve(root, '..'));
    if (!manifest) throw new Error('无法读取项目 package.json，拒绝裁剪依赖。');

    const reachable = collectReachablePackages(root, manifest, enabledConnectors);
    const allPackages = collectPackageDirectories(root, root);
    const unreachable = allPackages.filter(packagePath => !reachable.has(packagePath));
    const removableRoots = unreachable
        .filter(candidate => !unreachable.some(parent => parent !== candidate && isNestedBelow(candidate, parent)))
        .sort((a, b) => a.length - b.length);
    const removed = removableRoots.map(packagePath => path.relative(root, packagePath).replace(/\\/g, '/'));

    if (!dryRun) {
        removableRoots.forEach(packagePath => {
            assertInside(root, packagePath);
            fs.rmSync(packagePath, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
        });
    }
    return {
        enabledConnectors: [...enabledConnectors].sort(),
        reachableCount: reachable.size,
        removed,
        dryRun: Boolean(dryRun)
    };
}

function parseArgs(args) {
    const readValue = name => {
        const index = args.indexOf(name);
        if (index === -1) return '';
        const value = args[index + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`${name} 必须提供值。`);
        return value;
    };
    return {
        nodeModulesDir: readValue('--node-modules') || path.join(process.cwd(), 'node_modules'),
        connectors: readValue('--connectors'),
        dryRun: args.includes('--dry-run')
    };
}

if (require.main === module) {
    const result = pruneOptionalDatabaseConnectors(parseArgs(process.argv.slice(2)));
    console.log(`[prune-optional-db-connectors] ${result.dryRun ? '预览' : '已裁剪'}：保留 ${result.enabledConnectors.join(', ') || '无可选连接器'}；移除 ${result.removed.length} 个不可达包。`);
}

module.exports = {
    CONNECTORS,
    collectReachablePackages,
    parseConnectorList,
    pruneOptionalDatabaseConnectors,
    resolveDependency
};
