const { getDeploymentProviders } = require('./deployment-providers');
function normalizeDeploymentMode(value) {
    const mode = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (mode === 'multi_node' || mode === 'cluster') return 'multi_node';
    if (mode === 'enterprise') return 'enterprise_planned';
    return 'single_node';
}

function hasEnv(env, keys = []) {
    return keys.some(key => String(env[key] || '').trim().length > 0);
}

function getDeploymentProfile(env = process.env) {
    const requestedMode = normalizeDeploymentMode(env.PIVOT_DEPLOYMENT_MODE || env.DEPLOYMENT_MODE);
    const databaseProvider = String(env.PIVOT_DB_PROVIDER || env.DB_PROVIDER || 'postgres').trim().toLowerCase() || 'postgres';
    const objectStorageConfigured = hasEnv(env, ['PIVOT_OBJECT_STORAGE_URL', 'S3_BUCKET', 'AWS_S3_BUCKET']);
    const queueConfigured = hasEnv(env, ['PIVOT_QUEUE_URL', 'REDIS_URL', 'RABBITMQ_URL']);
    const lockConfigured = hasEnv(env, ['PIVOT_LOCK_URL', 'REDIS_URL', 'ETCD_ENDPOINTS']);
    const multiNodeReady = databaseProvider !== 'sqlite' && objectStorageConfigured && queueConfigured && lockConfigured;
    const providers = getDeploymentProviders(env);
    const warnings = [];

    if (requestedMode !== 'single_node' && !multiNodeReady) {
        warnings.push('multi_node_requires_postgres_object_storage_distributed_queue_and_lock');
    }

    return {
        requestedMode,
        effectiveMode: multiNodeReady ? requestedMode : 'single_node',
        database: {
            provider: databaseProvider,
            walRecommended: false,
            multiNodeReady: databaseProvider !== 'sqlite',
            adapterRequiredForMultiNode: databaseProvider === 'sqlite'
        },
        objectStorage: {
            provider: objectStorageConfigured ? 'external' : 'local_fs',
            configured: objectStorageConfigured,
            adapterRequiredForMultiNode: !objectStorageConfigured
        },
        queue: {
            provider: queueConfigured ? 'external' : 'in_process',
            configured: queueConfigured,
            adapterRequiredForMultiNode: !queueConfigured
        },
        locks: {
            provider: lockConfigured ? 'external' : 'in_process_or_sqlite',
            configured: lockConfigured,
            adapterRequiredForMultiNode: !lockConfigured
        },
        providers,
        capabilities: {
            multiNodeReady,
            organizationAccess: false,
            teamAccess: false,
            tenantOwnedSecrets: false,
            auditExport: false,
            distributedTasks: queueConfigured,
            distributedLocks: lockConfigured
        },
        warnings
    };
}

module.exports = {
    getDeploymentProfile,
    normalizeDeploymentMode
};
