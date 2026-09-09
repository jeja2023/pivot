'use strict';

/**
 * 桌面端将服务端一同封装。MySQL、SQL Server、MongoDB 驱动只由数据库 MCP
 * 按需 require，标准安装包可排除未选择驱动的完整依赖闭包。这里复用 Docker
 * 裁剪器的依赖可达性算法，但只生成 electron-builder 的 files 排除规则，不会
 * 改动开发工作区 node_modules。
 */
const fs = require('fs');
const path = require('path');
const {
    CONNECTORS,
    collectReachablePackages,
    parseConnectorList
} = require('./prune_optional_database_connectors');

const CONNECTOR_FILE_RULE = /^!node_modules\/(?:mysql2|mssql|mongodb)(?:\/|$)/;

function isNestedBelow(candidate, parent) {
    const relative = path.relative(parent, candidate);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function buildDesktopConnectorExcludes({ nodeModulesDir, projectManifest, connectors = '' } = {}) {
    const nodeModules = path.resolve(nodeModulesDir || path.join(process.cwd(), 'node_modules'));
    if (!fs.statSync(nodeModules).isDirectory()) throw new Error(`node_modules 目录不存在：${nodeModules}`);
    const enabled = connectors instanceof Set ? connectors : parseConnectorList(connectors);
    const manifest = projectManifest || JSON.parse(fs.readFileSync(path.join(nodeModules, '..', 'package.json'), 'utf8'));
    const allConnectorNames = new Set(Object.keys(CONNECTORS));
    const reachableWithAllConnectors = collectReachablePackages(nodeModules, manifest, allConnectorNames);
    const reachableWithProfile = collectReachablePackages(nodeModules, manifest, enabled);
    const selected = new Set(reachableWithProfile);
    const disabledPackages = [...reachableWithAllConnectors].filter(packagePath => !selected.has(packagePath));
    const disabledRoots = disabledPackages
        .filter(candidate => !disabledPackages.some(parent => parent !== candidate && isNestedBelow(candidate, parent)))
        .sort((a, b) => a.length - b.length);
    return {
        enabledConnectors: [...enabled].sort(),
        excludes: disabledRoots.map(packagePath => `!node_modules/${path.relative(nodeModules, packagePath).replace(/\\/g, '/')}/**`)
    };
}

function prepareDesktopConnectorProfile(rootDir, { connectors } = {}) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '..'));
    const packagePath = path.join(root, 'package.json');
    const original = fs.readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(original);
    // 为兼容既有桌面客户端，未显式指定档位时保留全部可选驱动；只有发布方
    // 明确设置 PIVOT_DESKTOP_DB_CONNECTORS 才裁剪。此处不改变 remote 模式
    // local_database 授权桥的资源范围，后者仍由本机授权协议单独控制。
    const selectedConnectors = connectors === undefined
        ? (String(process.env.PIVOT_DESKTOP_DB_CONNECTORS || '').trim() || Object.keys(CONNECTORS).join(','))
        : connectors;
    const profile = buildDesktopConnectorExcludes({
        nodeModulesDir: path.join(root, 'node_modules'),
        projectManifest: pkg,
        connectors: selectedConnectors
    });
    const baseFiles = Array.isArray(pkg.build?.files) ? pkg.build.files.filter(item => !CONNECTOR_FILE_RULE.test(String(item))) : [];
    pkg.build = { ...pkg.build, files: [...baseFiles, ...profile.excludes] };
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`[desktop-db-connectors] 标准构建保留：${profile.enabledConnectors.join(', ') || '无可选连接器'}；排除 ${profile.excludes.length} 个依赖闭包根。`);
    let restored = false;
    return {
        ...profile,
        restore() {
            if (restored) return;
            restored = true;
            fs.writeFileSync(packagePath, original, 'utf8');
        }
    };
}

module.exports = {
    buildDesktopConnectorExcludes,
    prepareDesktopConnectorProfile
};
