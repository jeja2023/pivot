/* 通用本地缓存工具 Local Cache Utilities
 *
 * 提供两类基础数据结构：
 *   - LruCache：固定容量 + 可选 TTL，超过容量时按最近最少使用淘汰。
 *   - TtlCache：按时间过期的 Map，懒清理，适合存放小规模会话级数据。
 *
 * 设计目标：
 *   - 替换 server/index.js 中无上限的 dirSizeCache 等 Map，避免长时间运行出现内存膨胀。
 *   - 提供同步 API，方便在日志、统计、工具列表过滤等热路径直接使用。
 *
 * 注意：不引入第三方依赖，保持私有化部署友好。
 */

class LruCache {
    constructor(options = {}) {
        const max = Number.parseInt(options.max, 10);
        this.max = Number.isFinite(max) && max > 0 ? max : 256;
        const ttl = Number.parseInt(options.ttlMs, 10);
        this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
        this.map = new Map();
    }

    get size() {
        return this.map.size;
    }

    has(key) {
        const entry = this.map.get(key);
        if (!entry) return false;
        if (this.ttlMs > 0 && Date.now() - entry.at > this.ttlMs) {
            this.map.delete(key);
            return false;
        }
        return true;
    }

    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (this.ttlMs > 0 && Date.now() - entry.at > this.ttlMs) {
            this.map.delete(key);
            return undefined;
        }
        // 命中后移到 Map 末尾，保留"最近使用"顺序
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, { value, at: Date.now() });
        if (this.map.size > this.max) {
            const oldestKey = this.map.keys().next().value;
            if (oldestKey !== undefined) this.map.delete(oldestKey);
        }
    }

    delete(key) {
        return this.map.delete(key);
    }

    clear() {
        this.map.clear();
    }
}

class TtlCache {
    constructor(ttlMs) {
        const ttl = Number.parseInt(ttlMs, 10);
        this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : 60000;
        this.map = new Map();
    }

    get size() {
        return this.map.size;
    }

    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.at > this.ttlMs) {
            this.map.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key, value) {
        this.map.set(key, { value, at: Date.now() });
    }

    delete(key) {
        return this.map.delete(key);
    }

    // 触发懒清理：调用方按需在低频路径上调用以释放内存
    prune() {
        const now = Date.now();
        for (const [key, entry] of this.map) {
            if (now - entry.at > this.ttlMs) this.map.delete(key);
        }
    }

    clear() {
        this.map.clear();
    }
}

module.exports = {
    LruCache,
    TtlCache
};
