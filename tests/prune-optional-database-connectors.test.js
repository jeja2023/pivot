const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    parseConnectorList,
    pruneOptionalDatabaseConnectors
} = require('../scripts/prune_optional_database_connectors');
const { buildDesktopConnectorExcludes, prepareDesktopConnectorProfile } = require('../scripts/desktop_optional_database_connectors');

function writePackage(root, name, manifest = {}) {
    const target = path.join(root, ...name.split('/'));
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
    return target;
}

test('可选数据库连接器裁剪仅移除未选连接器的不可达依赖闭包', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-connector-prune-'));
    const nodeModules = path.join(root, 'node_modules');
    try {
        writePackage(nodeModules, 'core', { dependencies: { shared: '1.0.0' } });
        writePackage(nodeModules, 'shared');
        writePackage(nodeModules, 'mysql2', { dependencies: { mysql_only: '1.0.0', shared: '1.0.0' } });
        writePackage(nodeModules, 'mssql', { dependencies: { mssql_only: '1.0.0' } });
        writePackage(nodeModules, 'mongodb', { dependencies: { mongo_only: '1.0.0' } });
        writePackage(nodeModules, 'mysql_only');
        writePackage(nodeModules, 'mssql_only');
        writePackage(nodeModules, 'mongo_only');
        const projectManifest = { dependencies: { core: '1.0.0', mysql2: '1.0.0', mssql: '1.0.0', mongodb: '1.0.0' } };

        const result = pruneOptionalDatabaseConnectors({ nodeModulesDir: nodeModules, projectManifest, connectors: 'mysql' });

        assert.deepEqual(result.enabledConnectors, ['mysql']);
        assert.equal(fs.existsSync(path.join(nodeModules, 'core')), true);
        assert.equal(fs.existsSync(path.join(nodeModules, 'shared')), true);
        assert.equal(fs.existsSync(path.join(nodeModules, 'mysql2')), true);
        assert.equal(fs.existsSync(path.join(nodeModules, 'mysql_only')), true);
        assert.equal(fs.existsSync(path.join(nodeModules, 'mssql')), false);
        assert.equal(fs.existsSync(path.join(nodeModules, 'mssql_only')), false);
        assert.equal(fs.existsSync(path.join(nodeModules, 'mongodb')), false);
        assert.equal(fs.existsSync(path.join(nodeModules, 'mongo_only')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('可选连接器参数只接受明确的产品名称', () => {
    assert.deepEqual([...parseConnectorList('mysql, mongodb')].sort(), ['mongodb', 'mysql']);
    assert.throws(() => parseConnectorList('oracle'), /未知的 PIVOT_DB_CONNECTORS/);
});

test('桌面标准版排除未选数据库连接器的完整依赖闭包而保留公共依赖', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-connector-profile-'));
    const nodeModules = path.join(root, 'node_modules');
    try {
        writePackage(nodeModules, 'core', { dependencies: { shared: '1.0.0' } });
        writePackage(nodeModules, 'shared');
        writePackage(nodeModules, 'mysql2', { dependencies: { mysql_only: '1.0.0', shared: '1.0.0' } });
        writePackage(nodeModules, 'mssql', { dependencies: { mssql_only: '1.0.0' } });
        writePackage(nodeModules, 'mongodb', { dependencies: { mongo_only: '1.0.0' } });
        writePackage(nodeModules, 'mysql_only');
        writePackage(nodeModules, 'mssql_only');
        writePackage(nodeModules, 'mongo_only');
        const projectManifest = { dependencies: { core: '1.0.0', mysql2: '1.0.0', mssql: '1.0.0', mongodb: '1.0.0' } };

        const profile = buildDesktopConnectorExcludes({ nodeModulesDir: nodeModules, projectManifest, connectors: 'mysql' });

        assert.deepEqual(profile.enabledConnectors, ['mysql']);
        assert.deepEqual(profile.excludes.sort(), [
            '!node_modules/mongo_only/**',
            '!node_modules/mongodb/**',
            '!node_modules/mssql/**',
            '!node_modules/mssql_only/**'
        ]);
        assert.equal(profile.excludes.some(item => /(?:mysql2|mysql_only|shared)/.test(item)), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('桌面连接器构建配置只临时改写 package.json，并在构建后可完整恢复', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-connector-restore-'));
    const nodeModules = path.join(root, 'node_modules');
    const packagePath = path.join(root, 'package.json');
    try {
        const manifest = {
            name: 'fixture',
            dependencies: { core: '1.0.0', mysql2: '1.0.0', mssql: '1.0.0', mongodb: '1.0.0' },
            build: { files: ['desktop/**', 'node_modules/**'] }
        };
        const original = JSON.stringify(manifest, null, 2) + '\n';
        fs.writeFileSync(packagePath, original);
        writePackage(nodeModules, 'core');
        writePackage(nodeModules, 'mysql2');
        writePackage(nodeModules, 'mssql');
        writePackage(nodeModules, 'mongodb');

        const profile = prepareDesktopConnectorProfile(root, { connectors: 'mysql' });
        const duringBuild = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        assert.deepEqual(profile.enabledConnectors, ['mysql']);
        assert.equal(duringBuild.build.files.includes('!node_modules/mssql/**'), true);
        assert.equal(duringBuild.build.files.includes('!node_modules/mongodb/**'), true);
        assert.equal(duringBuild.build.files.includes('!node_modules/mysql2/**'), false);

        profile.restore();
        assert.equal(fs.readFileSync(packagePath, 'utf8'), original);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('未指定裁剪档位时桌面构建默认保留三类可选数据库连接器', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-desktop-local-connectors-'));
    const nodeModules = path.join(root, 'node_modules');
    try {
        const manifest = {
            name: 'fixture',
            dependencies: { mysql2: '1.0.0', mssql: '1.0.0', mongodb: '1.0.0' },
            build: { files: ['desktop/**', 'node_modules/**'] }
        };
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
        for (const name of ['mysql2', 'mssql', 'mongodb']) writePackage(nodeModules, name);
        const previous = process.env.PIVOT_DESKTOP_DB_CONNECTORS;
        delete process.env.PIVOT_DESKTOP_DB_CONNECTORS;
        const profile = prepareDesktopConnectorProfile(root);
        assert.deepEqual(profile.enabledConnectors, ['mongodb', 'mssql', 'mysql']);
        assert.deepEqual(profile.excludes, []);
        profile.restore();
        if (previous === undefined) delete process.env.PIVOT_DESKTOP_DB_CONNECTORS;
        else process.env.PIVOT_DESKTOP_DB_CONNECTORS = previous;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
