const fs = require('node:fs');
const path = require('node:path');
const { LruCache } = require('../cache');
const { logger } = require('../logger');

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_SCAN_TIMEOUT_MS = 2500;
const DEFAULT_MAX_SCAN_ITEMS = 5000;
const DEFAULT_DIR_SIZE_CACHE_TTL_MS = 300_000;

let cache = new LruCache({ max: 64, ttlMs: DEFAULT_DIR_SIZE_CACHE_TTL_MS });
let maxDepth = DEFAULT_MAX_DEPTH;
const inFlightScans = new Map();
const lastKnownSizes = new Map();

function configureDirSizeCache({ ttlMs = DEFAULT_DIR_SIZE_CACHE_TTL_MS, max = 64, depth = DEFAULT_MAX_DEPTH } = {}) {
    const safeMax = Math.max(1, Number.parseInt(max, 10) || 64);
    const safeTtl = Math.max(0, Number.parseInt(ttlMs, 10) || 0);
    maxDepth = Math.max(1, Number.parseInt(depth, 10) || DEFAULT_MAX_DEPTH);
    cache = new LruCache({ max: safeMax, ttlMs: safeTtl });
}

async function getDirSizeAsync(dir, depth = 0, ctx = null) {
    if (!fs.existsSync(dir)) return 0;
    if (depth >= maxDepth) {
        logger.warn({ dir, depth, maxDepth }, '目录大小扫描已达到递归深度上限');
        return 0;
    }
    const scanCtx = ctx || { startTime: Date.now(), itemCount: 0 };
    if (Date.now() - scanCtx.startTime > DEFAULT_SCAN_TIMEOUT_MS || scanCtx.itemCount >= DEFAULT_MAX_SCAN_ITEMS) {
        return 0;
    }

    let total = 0;
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            scanCtx.itemCount += 1;
            if (Date.now() - scanCtx.startTime > DEFAULT_SCAN_TIMEOUT_MS || scanCtx.itemCount >= DEFAULT_MAX_SCAN_ITEMS) {
                break;
            }
            const fullPath = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                total += await getDirSizeAsync(fullPath, depth + 1, scanCtx);
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

function triggerBackgroundScan(key) {
    if (inFlightScans.has(key)) return inFlightScans.get(key);
    const scanPromise = (async () => {
        try {
            const value = await getDirSizeAsync(key);
            if (cache.ttlMs > 0) cache.set(key, value);
            lastKnownSizes.set(key, value);
            return value;
        } finally {
            inFlightScans.delete(key);
        }
    })();
    inFlightScans.set(key, scanPromise);
    return scanPromise;
}

async function getCachedDirSize(dir) {
    const key = path.resolve(dir);
    if (cache.ttlMs > 0) {
        const cached = cache.get(key);
        if (cached !== undefined) return cached;
    }
    // SWR (Stale-While-Revalidate): 如果有历史缓存值，立即返回历史值并在后台异步刷新，绝不阻塞当前响应
    if (lastKnownSizes.has(key)) {
        triggerBackgroundScan(key);
        return lastKnownSizes.get(key);
    }
    return triggerBackgroundScan(key);
}

function clearDirSizeCache() {
    cache.clear();
    inFlightScans.clear();
    lastKnownSizes.clear();
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
