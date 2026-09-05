const PROVIDER_TYPES = new Set(['database', 'objectStorage', 'queue', 'lock']);

const PROVIDER_REGISTRY = {
    database: {
        postgres: {
            key: 'postgres',
            label: 'PostgreSQL',
            interface: 'DatabaseProvider',
            local: false,
            multiNodeReady: true,
            adapterWired: true,
            status: 'active',
            capabilities: ['multi_node', 'transactional']
        },
        sqlite: {
            key: 'sqlite',
            label: 'SQLite (Legacy)',
            interface: 'DatabaseProvider',
            local: true,
            multiNodeReady: false,
            adapterWired: true,
            status: 'deprecated',
            capabilities: ['single_node']
        }
    },
    objectStorage: {
        local_fs: {
            key: 'local_fs',
            label: 'Local filesystem',
            interface: 'ObjectStorageProvider',
            local: true,
            multiNodeReady: false,
            adapterWired: true,
            status: 'active',
            capabilities: ['single_node']
        },
        shared_fs: {
            key: 'shared_fs',
            label: 'Shared POSIX filesystem',
            interface: 'ObjectStorageProvider',
            local: false,
            multiNodeReady: true,
            adapterWired: true,
            status: 'active',
            capabilities: ['multi_node', 'shared_volume', 'atomic_rename']
        },
        s3_compatible: {
            key: 's3_compatible',
            label: 'S3 compatible object storage',
            interface: 'ObjectStorageProvider',
            local: false,
            // 仅识别 S3 环境变量不代表已经有可用的对象存储适配器。
            // 在适配器真正接入前，部署画像必须保持 not_ready。
            multiNodeReady: false,
            adapterWired: false,
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
            adapterWired: true,
            status: 'active',
            capabilities: ['single_node']
        },
        postgres: {
            key: 'postgres',
            label: 'PostgreSQL durable queue',
            interface: 'QueueProvider',
            local: false,
            multiNodeReady: true,
            adapterWired: true,
            status: 'active',
            capabilities: ['multi_node', 'retry', 'visibility_timeout', 'skip_locked']
        },
        distributed: {
            key: 'distributed',
            label: 'Distributed queue',
            interface: 'QueueProvider',
            local: false,
            multiNodeReady: false,
            adapterWired: false,
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
            adapterWired: true,
            status: 'active',
            capabilities: ['single_node']
        },
        postgres: {
            key: 'postgres',
            label: 'PostgreSQL lease lock',
            interface: 'LockProvider',
            local: false,
            multiNodeReady: true,
            adapterWired: true,
            status: 'active',
            capabilities: ['multi_node', 'lease_renewal', 'fencing_token', 'row_lock']
        },
        distributed: {
            key: 'distributed',
            label: 'Distributed lock',
            interface: 'LockProvider',
            local: false,
            multiNodeReady: false,
            adapterWired: false,
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
    if (!PROVIDER_TYPES.has(key)) throw new Error(`不支持的部署服务商类型: ${value}`);
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
        multiNodeReady: false,
        adapterWired: false,
        status: 'planned',
        capabilities: ['external', 'multi_node']
    };
}

function resolveProviderKey(type, env = process.env) {
    if (type === 'database') {
        return String(env.PIVOT_DB_PROVIDER || env.DB_PROVIDER || 'postgres').trim().toLowerCase() || 'postgres';
    }
    if (type === 'objectStorage') {
        if (hasEnv(env, ['PIVOT_OBJECT_STORAGE_URL', 'S3_BUCKET', 'AWS_S3_BUCKET'])) return 's3_compatible';
        return hasEnv(env, ['PIVOT_SHARED_STORAGE_ROOT']) ? 'shared_fs' : 'local_fs';
    }
    if (type === 'queue') {
        if (hasEnv(env, ['PIVOT_QUEUE_URL', 'REDIS_URL', 'RABBITMQ_URL'])) return 'distributed';
        return String(env.PIVOT_DB_PROVIDER || env.DB_PROVIDER || 'postgres').trim().toLowerCase() === 'postgres'
            ? 'postgres'
            : 'in_process';
    }
    if (type === 'lock') {
        if (hasEnv(env, ['PIVOT_LOCK_URL', 'REDIS_URL', 'ETCD_ENDPOINTS'])) return 'distributed';
        return String(env.PIVOT_DB_PROVIDER || env.DB_PROVIDER || 'postgres').trim().toLowerCase() === 'postgres'
            ? 'postgres'
            : 'in_process_or_sqlite';
    }
    return '';
}

function getDeploymentProviders(env = process.env) {
    const databaseConfigured = hasEnv(env, ['DATABASE_URL', 'TEST_DATABASE_URL']);
    return Array.from(PROVIDER_TYPES).reduce((acc, type) => {
        const requestedKey = resolveProviderKey(type, env);
        const provider = providerFor(type, requestedKey);
        const defaultKeys = { database: 'postgres', objectStorage: 'local_fs', queue: 'in_process', lock: 'in_process_or_sqlite' };
        // 默认 Provider 代表当前单节点运行时已经存在的本地/数据库实现；外部
        // Provider 则由环境变量显式选择。这里的 configured 只表示“选中了”，
        // ready 还必须经过 adapterWired + active 检查。
        const configured = provider.local
            || (type === 'database' ? databaseConfigured
                : provider.key === 'postgres' ? databaseConfigured
                    : provider.key === 'shared_fs' ? hasEnv(env, ['PIVOT_SHARED_STORAGE_ROOT'])
                        : requestedKey !== defaultKeys[type]);
        const ready = provider.local
            ? true
            : configured && provider.adapterWired === true && provider.multiNodeReady === true && provider.status === 'active';
        acc[type] = {
            ...provider,
            requestedKey,
            configured,
            adapterWired: provider.adapterWired === true,
            ready,
            adapterRequiredForMultiNode: !ready && !provider.local
        };
        return acc;
    }, {});
}

function createProviderPlaceholder(type, key) {
    const provider = providerFor(type, key);
    return {
        ...provider,
        createClient() {
            if (provider.local) {
                return { provider: provider.key, status: 'local-placeholder' };
            }
            throw new Error(`${provider.interface} ${provider.key} 为预留服务商占位符，暂未接入适配器。`);
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
