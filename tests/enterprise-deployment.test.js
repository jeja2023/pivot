const assert = require('node:assert/strict');
const test = require('node:test');
const Sqlite = require('better-sqlite3');

const migrations = require('../server/db/migrations');
const { runVersionedMigrations } = require('../server/db/migrations/runner');
const { getDeploymentProfile } = require('../server/services/deployment-profile');
const {
    createProviderPlaceholder,
    getDeploymentProviders,
    normalizeProviderType,
    providerFor
} = require('../server/services/deployment-providers');
const {
    normalizeResourceType,
    normalizeSubjectType
} = require('../server/services/enterprise-access');

test('enterprise deployment migration creates provider and policy tables', () => {
    const db = new Sqlite(':memory:');
    try {
        db.exec(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT,
                password_hash TEXT
            );
        `);
        const applied = runVersionedMigrations(db, migrations);
        assert.ok(applied.includes('202607030001_rag_debug_enterprise_contracts'));
        [
            'rag_debug_queries',
            'organizations',
            'teams',
            'team_members',
            'resource_permissions',
            'policy_objects',
            'deployment_provider_configs'
        ].forEach(table => {
            assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
        });
        assert.deepEqual(runVersionedMigrations(db, migrations), []);
    } finally {
        db.close();
    }
});

test('deployment providers do not claim multi-node readiness before adapters are wired', () => {
    const env = {
        PIVOT_DEPLOYMENT_MODE: 'multi_node',
        PIVOT_DB_PROVIDER: 'postgres',
        S3_BUCKET: 'pivot-test',
        REDIS_URL: 'redis://127.0.0.1:6379'
    };
    const providers = getDeploymentProviders(env);
    assert.equal(providers.database.key, 'postgres');
    assert.equal(providers.objectStorage.key, 's3_compatible');
    assert.equal(providers.queue.key, 'distributed');
    assert.equal(providers.lock.key, 'distributed');
    assert.equal(getDeploymentProfile(env).capabilities.multiNodeReady, false);
    assert.equal(getDeploymentProfile(env).effectiveMode, 'single_node');
    assert.equal(providers.objectStorage.adapterWired, false);
    assert.equal(providers.queue.adapterWired, false);
    assert.equal(providers.lock.adapterWired, false);
    assert.equal(providers.objectStorage.ready, false);
    assert.equal(providers.queue.ready, false);
    assert.equal(providers.lock.ready, false);
    assert.equal(getDeploymentProfile(env).providers.database.interface, 'DatabaseProvider');
});

test('enterprise provider and access helpers normalize extension inputs', () => {
    assert.equal(normalizeProviderType('queue'), 'queue');
    assert.throws(() => normalizeProviderType('unknown'), /Unsupported|不支持/);
    assert.equal(providerFor('database', 'mysql').status, 'planned');
    assert.equal(createProviderPlaceholder('database', 'sqlite').createClient().status, 'local-placeholder');
    assert.throws(() => createProviderPlaceholder('queue', 'distributed').createClient(), /placeholder|预留服务商占位符|占位符/);
    assert.equal(normalizeResourceType('mcp-tool'), 'mcp_tool');
    assert.equal(normalizeSubjectType('team'), 'team');
});
