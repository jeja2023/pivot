const fs = require('node:fs');
const path = require('node:path');
const { LruCache } = require('../cache');
const { logger } = require('../logger');

const DEFAULT_MAX_DEPTH = 32;

let cache = new LruCache({ max: 64, ttlMs: 0 });
let maxDepth = DEFAULT_MAX_DEPTH;

function configureDirSizeCache({ ttlMs = 0, max = 64, depth = DEFAULT_MAX_DEPTH } = {}) {
    const safeMax = Math.max(1, Number.parseInt(max, 10) || 64);
    const safeTtl = Math.max(0, Number.parseInt(ttlMs, 10) || 0);
    maxDepth = Math.max(1, Number.parseInt(depth, 10) || DEFAULT_MAX_DEPTH);
    cache = new LruCache({ max: safeMax, ttlMs: safeTtl });
}

async function getDirSizeAsync(dir, depth = 0) {
    if (!fs.existsSync(dir)) return 0;
    if (depth >= maxDepth) {
        logger.warn({ dir, depth, maxDepth }, '目录大小扫描已达到递归深度上限');
        return 0;
    }
    let total = 0;
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                total += await getDirSizeAsync(fullPath, depth + 1);
            } else if (entry.isFile()) {
                const stats = await fs.promises.stat(fullPath);
                total += stats.size;
            }
        }
    } catch (err) {
        logger.warn({ dir, err: err.message }, '目录大小扫描失败');
    }
    return total;
}

async function getCachedDirSize(dir) {
    const key = path.resolve(dir);
    if (cache.ttlMs > 0) {
        const cached = cache.get(key);
        if (cached !== undefined) return cached;
    }
    const value = await getDirSizeAsync(key);
    if (cache.ttlMs > 0) cache.set(key, value);
    return value;
}

function clearDirSizeCache() {
    cache.clear();
}

function invalidateDirSizeCacheForPath(_targetPath) {
    clearDirSizeCache();
}

module.exports = {
    clearDirSizeCache,
    configureDirSizeCache,
    getCachedDirSize,
    invalidateDirSizeCacheForPath
};
