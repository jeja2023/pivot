'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

async function prepareDesktopSqliteBinding(root, platform, arch, manifestPath) {
    if (platform !== process.platform || arch !== process.arch) throw new Error('SQLite 原生绑定必须在目标平台和架构上构建。');
    const staging = path.dirname(path.resolve(manifestPath));
    const moduleRoot = path.join(staging, 'sqlite-runtime');
    if (fs.existsSync(moduleRoot)) throw new Error('SQLite 隔离构建目录已存在。');
    const source = path.join(root, 'node_modules', 'better-sqlite3');
    const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
    const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
    fs.mkdirSync(path.join(moduleRoot, 'node_modules'), { recursive: true });
    for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
        fs.cpSync(path.join(root, 'node_modules', name), path.join(moduleRoot, 'node_modules', name), { recursive: true, force: false, errorOnExist: true });
    }
    fs.writeFileSync(path.join(moduleRoot, 'package.json'), JSON.stringify({ name: 'pivot-desktop-sqlite-build', private: true, version: '1.0.0', dependencies: { 'better-sqlite3': version } }));
    try {
        execFileSync(process.execPath, [require.resolve('prebuild-install/bin.js'), `--runtime=electron`, `--target=${electronVersion}`, `--platform=${platform}`, `--arch=${arch}`], {
            cwd: path.join(moduleRoot, 'node_modules', 'better-sqlite3'), windowsHide: true, stdio: 'inherit', timeout: 180000
        });
    } catch (_) {
        const { rebuild } = await import('@electron/rebuild');
        await rebuild({ buildPath: moduleRoot, electronVersion, platform, arch, force: true, buildFromSource: true, onlyModules: ['better-sqlite3'], mode: 'sequential' });
    }
    const binding = path.join(moduleRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    const executable = require(path.join(root, 'node_modules', 'electron'));
    const probe = "const D=require(process.argv[1]);const d=new D(':memory:',{nativeBinding:process.argv[2]});const r=d.prepare('SELECT sqlite_version() AS version, 1 AS n').get();d.close();if(r.n!==1)throw Error('SQLite query failed');console.log(JSON.stringify({sqlite:r.version,abi:process.versions.modules,electron:process.versions.electron}));";
    const actual = JSON.parse(execFileSync(executable, ['-e', probe, path.join(moduleRoot, 'node_modules', 'better-sqlite3'), binding], { windowsHide: true, encoding: 'utf8', timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim());
    if (actual.electron !== electronVersion) throw new Error('SQLite 自检未使用目标 Electron。');
    const result = { version: 1, platform, arch, packageVersion: version, electronVersion, binding, sha256: crypto.createHash('sha256').update(fs.readFileSync(binding)).digest('hex'), ...actual };
    fs.writeFileSync(manifestPath, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ sqliteBindingReady: true, platform, arch, packageVersion: version, ...actual }));
    return result;
}

function readDesktopSqliteBinding(manifestPath, platform, arch) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== 1 || manifest.platform !== platform || manifest.arch !== arch) throw new Error('SQLite 构建清单与打包目标不符。');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(manifest.binding)).digest('hex');
    if (digest !== manifest.sha256) throw new Error('SQLite 构建绑定摘要不符。');
    return manifest;
}

function verifyPackagedDesktopSqlite(context, platform, arch) {
    const manifest = process.env.PIVOT_DESKTOP_SQLITE_MANIFEST
        ? readDesktopSqliteBinding(process.env.PIVOT_DESKTOP_SQLITE_MANIFEST, platform, arch) : null;
    const name = context.packager.appInfo.productFilename;
    const executable = platform === 'win32' ? path.join(context.appOutDir, `${name}.exe`)
        : platform === 'darwin' ? path.join(context.appOutDir, `${name}.app`, 'Contents', 'MacOS', name)
            : path.join(context.appOutDir, context.packager.executableName);
    const resources = platform === 'darwin' ? path.resolve(executable, '../../Resources') : path.join(context.appOutDir, 'resources');
    const probe = "const p=require('node:path'),D=require(p.join(process.argv[1],'node_modules/better-sqlite3'));const d=new D(':memory:');const row=d.prepare('SELECT sqlite_version() AS version, 1 AS n').get();d.close();if(row.n!==1)throw Error('Packaged SQLite query failed');console.log(JSON.stringify({sqlite:row.version,electron:process.versions.electron,abi:process.versions.modules}));";
    const actual = JSON.parse(execFileSync(executable, ['-e', probe, path.join(resources, 'app.asar')], { windowsHide: true, encoding: 'utf8', timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim());
    if (manifest && (actual.electron !== manifest.electronVersion || actual.abi !== manifest.abi || actual.sqlite !== manifest.sqlite)) throw new Error('打包后 SQLite 运行身份或查询结果不符。');
    console.log(`[afterPack] 实际安装目录 SQLite 查询通过：Electron ${actual.electron} / ABI ${actual.abi} / SQLite ${actual.sqlite}。`);
}

module.exports = { prepareDesktopSqliteBinding, readDesktopSqliteBinding, verifyPackagedDesktopSqlite };

if (require.main === module) {
    prepareDesktopSqliteBinding(path.resolve(process.argv[2]), process.argv[3], process.argv[4], path.resolve(process.argv[5])).catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}
