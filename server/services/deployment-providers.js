const PROVIDER_TYPES = new Set(['database', 'objectStorage', 'queue', 'lock']);

const PROVIDER_REGISTRY = {
    database: {
        sqlite: {
            key: 'sqlite',
            label: 'SQLite WAL',
            interface: 'DatabaseProvider',
            local: true,
            multiNodeReady: false,
            status: 'active',
            capabilities: ['single_node', 'wal']
        },
        postgres: {
            key: 'postgres',
            label: 'PostgreSQL',
            interface: 'DatabaseProvider',
            local: false,
            multiNodeReady: true,
            status: 'planned',
            capabilities: ['multi_node', 'transactional']
        }
    },
    objectStorage: {
        local_fs: {
            key: 'local_fs',
            label: 'Local filesystem',
            interface: 'ObjectStorageProvider',
            local: true,
            multiNodeReady: false,
            status: 'active',
            capabilities: ['single_node']
        },
        s3_compatible: {
            key: 's3_compatible',
            label: 'S3 compatible object storage',
            interface: 'ObjectStorageProvider',
            local: false,
            multiNodeReady: true,
            status: 'planned',
            capabilities: ['multi_node', 'presigned_url']
        }
    },
    queue: {
        in_process: {
            key: 'in_process',
            label: 'In-process queue',
            interface: 'QueueProvider',
            local: true,
            multiNodeReady: false,
            status: 'active',
            capabilities: ['single_node']
        },
        distributed: {
            key: 'distributed',
            label: 'Distributed queue',
            interface: 'QueueProvider',
            local: false,
            multiNodeReady: true,
            status: 'planned',
            capabilities: ['multi_node', 'retry', 'visibility_timeout']
        }
    },
    lock: {
        in_process_or_sqlite: {
            key: 'in_process_or_sqlite',
            label: 'In-process or SQLite lock',
            interface: 'LockProvider',
            local: true,
            multiNodeReady: false,
            status: 'active',
            capabilities: ['single_node']
        },
        distributed: {
            key: 'distributed',
            label: 'Distributed lock',
            interface: 'LockProvider',
            local: false,
            multiNodeReady: true,
            status: 'planned',
            capabilities: ['multi_node', 'lease_renewal', 'fencing_token']
        }
    }
};

function hasEnv(env, keys = []) {
    return keys.some(key => String(env[key] || '').trim().length > 0);
}

function normalizeProviderType(value) {
    const key = String(value || '').trim();
    if (!PROVIDER_TYPES.has(key)) throw new Error(`Unsupported deployment provider type: ${value}`);
    return key;
}

function providerFor(type, key) {
    const safeType = normalizeProviderType(type);
    const registry = PROVIDER_REGISTRY[safeType] || {};
    if (registry[key]) return registry[key];
    const fallback = registry[Object.keys(registry)[0]];
    return {
        key: String(key || fallback?.key || 'external'),
        label: `External ${safeType} provider`,
        interface: fallback?.interface || 'DeploymentProvider',
        local: false,
        multiNodeReady: true,
        status: 'planned',
        capabilities: ['external', 'multi_node']
    };
}

function resolveProviderKey(type, env = process.env) {
    if (type === 'database') {
        return String(env.PIVOT_DB_PROVIDER || env.DB_PROVIDER || 'sqlite').trim().toLowerCase() || 'sqlite';
    }
    if (type === 'objectStorage') {
        return hasEnv(env, ['PIVOT_OBJECT_STORAGE_URL', 'S3_BUCKET', 'AWS_S3_BUCKET']) ? 's3_compatible' : 'local_fs';
    }
    if (type === 'queue') {
        return hasEnv(env, ['PIVOT_QUEUE_URL', 'REDIS_URL', 'RABBITMQ_URL']) ? 'distributed' : 'in_process';
    }
    if (type === 'lock') {
        return hasEnv(env, ['PIVOT_LOCK_URL', 'REDIS_URL', 'ETCD_ENDPOINTS']) ? 'distributed' : 'in_process_or_sqlite';
    }
    return '';
}

function getDeploymentProviders(env = process.env) {
    return Array.from(PROVIDER_TYPES).reduce((acc, type) => {
        const requestedKey = resolveProviderKey(type, env);
        const provider = providerFor(type, requestedKey);
        acc[type] = {
            ...provider,
            requestedKey,
            configured: provider.multiNodeReady || provider.local === true,
            adapterRequiredForMultiNode: provider.multiNodeReady !== true
        };
        return acc;
    }, {});
}

function createProviderPlaceholder(type, key) {
    const provider = providerFor(type, key);
    return {
        ...provider,
        createClient() {
            if (provider.status === 'active' && provider.local) {
                return { provider: provider.key, status: 'local-placeholder' };
            }
            throw new Error(`${provider.interface} ${provider.key} is a provider placeholder and has no adapter yet.`);
        }
    };
}

module.exports = {
    PROVIDER_REGISTRY,
    createProviderPlaceholder,
    getDeploymentProviders,
    normalizeProviderType,
    providerFor,
    resolveProviderKey
};
