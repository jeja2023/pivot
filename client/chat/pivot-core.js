/* Pivot 前端核心工具命名空间 Pivot Core Utilities
 *
 * 集中收纳跨模块复用的小工具：
 *   - 防抖/节流/帧调度
 *   - 简单的 LRU 缓存
 *   - 文件大小格式化、token 数格式化
 *   - DOM 工具：replaceChildren 安全包装、命名空间事件绑定
 *
 * 设计目标：
 *   - 不替换现有 window.* 全局函数，向前兼容；新代码使用 Pivot.xxx
 *   - 不引入任何依赖，单文件即可在浏览器加载
 *   - 与 safe-html.js 互补（safe-html 负责 HTML 转义，本文件负责行为工具）
 */
(function () {
    const existingPivot = window.Pivot || {};

    function throttle(fn, wait) {
        let lastCall = 0;
        let timer = null;
        let lastArgs = null;
        const invoke = (args) => {
            lastCall = Date.now();
            fn.apply(null, args);
        };
        const wrapped = function (...args) {
            const now = Date.now();
            const remaining = wait - (now - lastCall);
            lastArgs = args;
            if (remaining <= 0) {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                invoke(args);
            } else if (!timer) {
                timer = setTimeout(() => {
                    timer = null;
                    invoke(lastArgs);
                }, remaining);
            }
        };
        wrapped.cancel = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            lastArgs = null;
        };
        wrapped.flush = () => {
            if (!timer || !lastArgs) return;
            clearTimeout(timer);
            timer = null;
            invoke(lastArgs);
        };
        return wrapped;
    }

    function debounce(fn, wait) {
        let timer = null;
        const wrapped = function (...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                fn.apply(null, args);
            }, wait);
        };
        wrapped.cancel = () => {
            if (timer) clearTimeout(timer);
            timer = null;
        };
        return wrapped;
    }

    // 通过 requestAnimationFrame 合并多次调用，适合长流式渲染
    function rafThrottle(fn) {
        let scheduled = false;
        let lastArgs = null;
        const wrapped = function (...args) {
            lastArgs = args;
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                fn.apply(null, lastArgs);
            });
        };
        return wrapped;
    }

    function formatBytes(value) {
        const num = Number(value);
        if (!Number.isFinite(num) || num <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let v = num;
        let i = 0;
        while (v >= 1024 && i < units.length - 1) {
            v /= 1024;
            i += 1;
        }
        return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
    }

    function formatNumber(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        return num.toLocaleString('zh-CN');
    }

    // 简单 LRU 缓存：用于会话标题渲染、知识库片段等热路径
    function createLruCache(max = 128) {
        const cap = Math.max(1, Number.parseInt(max, 10) || 128);
        const map = new Map();
        return {
            get size() { return map.size; },
            has(key) { return map.has(key); },
            get(key) {
                if (!map.has(key)) return undefined;
                const value = map.get(key);
                map.delete(key);
                map.set(key, value);
                return value;
            },
            set(key, value) {
                if (map.has(key)) map.delete(key);
                map.set(key, value);
                if (map.size > cap) {
                    const oldestKey = map.keys().next().value;
                    if (oldestKey !== undefined) map.delete(oldestKey);
                }
            },
            delete(key) { return map.delete(key); },
            clear() { map.clear(); }
        };
    }

    // 安全的 replaceChildren：避免使用 innerHTML=''，更适合频繁刷新的容器
    function clearChildren(node) {
        if (!node) return;
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    // 命名空间事件绑定：自动 cleanup，避免重复绑定
    function on(target, event, handler, options) {
        if (!target || typeof target.addEventListener !== 'function') return () => {};
        target.addEventListener(event, handler, options);
        return () => target.removeEventListener(event, handler, options);
    }

    // 流式渲染节流策略：根据已积累内容长度自适应间隔
    // 思路：内容越长，每帧 marked.parse 越贵，应该降低刷新频率
    function chooseStreamInterval(contentLength) {
        const len = Number(contentLength) || 0;
        if (len < 600) return 80;
        if (len < 2000) return 140;
        if (len < 6000) return 220;
        return 320;
    }

    existingPivot.throttle = throttle;
    existingPivot.debounce = debounce;
    existingPivot.rafThrottle = rafThrottle;
    existingPivot.formatBytes = formatBytes;
    existingPivot.formatNumber = formatNumber;
    existingPivot.createLruCache = createLruCache;
    existingPivot.clearChildren = clearChildren;
    existingPivot.on = on;
    existingPivot.chooseStreamInterval = chooseStreamInterval;
    existingPivot.html = window.PivotSafeHtml || existingPivot.html || null;
    window.Pivot = existingPivot;
})();
