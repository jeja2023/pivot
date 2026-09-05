const path = require('path');
const { getDeploymentProviders } = require('./deployment-providers');
function normalizeDeploymentMode(value) {
    const mode = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (mode === 'multi_node' || mode === 'cluster') return 'multi_node';
    if (mode === 'enterprise') return 'enterprise_planned';
    return 'single_node';
}

function isPathInside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function getSharedStorageLayout(env = process.env, provider = {}) {
    const rootRaw = String(env.PIVOT_SHARED_STORAGE_ROOT || '').trim();
    if (!rootRaw || provider.key !== 'shared_fs') {
        return { root: '', dataDir: '', uploadDir: '', coversData: false, coversUploads: false, ready: false };
    }
    const root = path.resolve(rootRaw);
    const dataDir = path.resolve(env.DATA_DIR || path.join(root, 'data'));
    const uploadDir = path.resolve(env.PIVOT_UPLOAD_DIR || env.UPLOAD_DIR || path.join(root, 'uploads'));
    const coversData = isPathInside(root, dataDir);
    const coversUploads = isPathInside(root, uploadDir);
    return { root, dataDir, uploadDir, coversData, coversUploads, ready: coversData && coversUploads };
}

function getDeploymentProfile(env = process.env) {
    const requestedMode = normalizeDeploymentMode(env.PIVOT_DEPLOYMENT_MODE || env.DEPLOYMENT_MODE);
    const databaseProvider = String(env.PIVOT_DB_PROVIDER || env.DB_PROVIDER || 'postgres').trim().toLowerCase() || 'postgres';
    const providers = getDeploymentProviders(env);
    const sharedStorage = getSharedStorageLayout(env, providers.objectStorage);
    const databaseReady = providers.database?.ready === true && databaseProvider !== 'sqlite';
    const objectStorageOperational = providers.objectStorage?.ready === true
        && (providers.objectStorage?.key !== 'shared_fs' || sharedStorage.ready);
    const objectStorageReady = objectStorageOperational && providers.objectStorage?.multiNodeReady === true;
    const multiNodeReady = databaseReady
        && objectStorageReady
        && providers.queue?.ready === true
        && providers.lock?.ready === true;
    const warnings = [];

    if (requestedMode !== 'single_node' && !multiNodeReady) {
        warnings.push('multi_node_requires_postgres_object_storage_distributed_queue_and_lock');
    }
    if (requestedMode !== 'single_node' && [providers.objectStorage, providers.queue, providers.lock].some(provider => provider?.configured && !provider?.ready)) {
        warnings.push('multi_node_provider_adapter_not_wired');
    }
    if (requestedMode !== 'single_node' && providers.objectStorage?.key === 'shared_fs' && !sharedStorage.ready) {
        warnings.push('multi_node_shared_storage_must_cover_data_and_uploads');
    }
    if (requestedMode !== 'single_node' && providers.objectStorage?.key === 'local_fs') {
        warnings.push('multi_node_shared_storage_required');
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
            provider: providers.objectStorage?.key || 'local_fs',
            configured: providers.objectStorage?.configured === true,
            adapterWired: providers.objectStorage?.adapterWired === true,
            ready: objectStorageOperational,
            adapterRequiredForMultiNode: !objectStorageReady,
            sharedStorage
        },
        queue: {
            provider: providers.queue?.key || 'in_process',
            configured: providers.queue?.configured === true,
            adapterWired: providers.queue?.adapterWired === true,
            ready: providers.queue?.ready === true,
            adapterRequiredForMultiNode: providers.queue?.ready !== true
        },
        locks: {
            provider: providers.lock?.key || 'in_process_or_sqlite',
            configured: providers.lock?.configured === true,
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
            distributedLocks: providers.lock?.ready === true,
            sharedFileStorage: objectStorageReady,
            sharedFileStorageCoverage: sharedStorage.ready ? ['data', 'uploads'] : []
        },
        warnings
    };
}

function isDeploymentReadinessRequired(env = process.env) {
    return ['1', 'true', 'yes', 'on'].includes(String(env.PIVOT_REQUIRE_DEPLOYMENT_READY || '').trim().toLowerCase());
}

function assertDeploymentReady(env = process.env) {
    const profile = getDeploymentProfile(env);
    if (!isDeploymentReadinessRequired(env) || profile.requestedMode !== 'multi_node' || profile.capabilities.multiNodeReady === true) {
        return profile;
    }
    const error = new Error(`多节点部署预检未通过：${profile.warnings.join(', ') || '缺少共享基础设施'}`);
    error.code = 'PIVOT_DEPLOYMENT_NOT_READY';
    error.profile = profile;
    throw error;
}

module.exports = {
    assertDeploymentReady,
    getDeploymentProfile,
    getSharedStorageLayout,
    isDeploymentReadinessRequired,
    isPathInside,
    normalizeDeploymentMode
};
