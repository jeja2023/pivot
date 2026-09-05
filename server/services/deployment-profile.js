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
    const providers = getDeploymentProviders(env);
    const objectStorageConfigured = hasEnv(env, ['PIVOT_OBJECT_STORAGE_URL', 'S3_BUCKET', 'AWS_S3_BUCKET']);
    const queueConfigured = hasEnv(env, ['PIVOT_QUEUE_URL', 'REDIS_URL', 'RABBITMQ_URL']);
    const lockConfigured = hasEnv(env, ['PIVOT_LOCK_URL', 'REDIS_URL', 'ETCD_ENDPOINTS']);
    const databaseReady = providers.database?.ready === true && databaseProvider !== 'sqlite';
    const multiNodeReady = databaseReady
        && providers.objectStorage?.key === 's3_compatible'
        && providers.objectStorage?.ready === true
        && providers.queue?.key === 'distributed'
        && providers.queue?.ready === true
        && providers.lock?.key === 'distributed'
        && providers.lock?.ready === true;
    const warnings = [];

    if (requestedMode !== 'single_node' && !multiNodeReady) {
        warnings.push('multi_node_requires_postgres_object_storage_distributed_queue_and_lock');
    }
    if (requestedMode !== 'single_node' && [providers.objectStorage, providers.queue, providers.lock].some(provider => provider?.configured && !provider?.ready)) {
        warnings.push('multi_node_provider_adapter_not_wired');
    }

    return {
        requestedMode,
        effectiveMode: multiNodeReady ? requestedMode : 'single_node',
        database: {
            provider: databaseProvider,
            walRecommended: false,
            configured: providers.database?.configured === true,
            adapterWired: providers.database?.adapterWired === true,
            ready: databaseReady,
            multiNodeReady: databaseReady,
            adapterRequiredForMultiNode: !databaseReady
        },
        objectStorage: {
            provider: objectStorageConfigured ? 'external' : 'local_fs',
            configured: objectStorageConfigured,
            adapterWired: providers.objectStorage?.adapterWired === true,
            ready: providers.objectStorage?.ready === true,
            adapterRequiredForMultiNode: providers.objectStorage?.ready !== true
        },
        queue: {
            provider: queueConfigured ? 'external' : 'in_process',
            configured: queueConfigured,
            adapterWired: providers.queue?.adapterWired === true,
            ready: providers.queue?.ready === true,
            adapterRequiredForMultiNode: providers.queue?.ready !== true
        },
        locks: {
            provider: lockConfigured ? 'external' : 'in_process_or_sqlite',
            configured: lockConfigured,
            adapterWired: providers.lock?.adapterWired === true,
            ready: providers.lock?.ready === true,
            adapterRequiredForMultiNode: providers.lock?.ready !== true
        },
        providers,
        capabilities: {
            multiNodeReady,
            organizationAccess: false,
            teamAccess: false,
            tenantOwnedSecrets: false,
            auditExport: false,
            distributedTasks: providers.queue?.ready === true,
            distributedLocks: providers.lock?.ready === true
        },
        warnings
    };
}

module.exports = {
    getDeploymentProfile,
    normalizeDeploymentMode
};
