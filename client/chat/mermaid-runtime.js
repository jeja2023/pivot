(function () {
    'use strict';
    const cache = new Map();
    const pending = new Map();
    const queue = [];
    let frame = null;
    let ready = null;
    let readyResolve = null;
    let readyReject = null;
    let loadTimer = null;
    let idleTimer = null;
    let active = null;
    let running = false;
    let cacheBytes = 0;
    let sequence = 0;
    const user = () => String(window.Pivot?.legacy?.currentUser?.id || 'current-page');

    function dropFrame() {
        clearTimeout(loadTimer); clearTimeout(idleTimer);
        frame?.remove(); frame = null; ready = null; readyResolve = null; readyReject = null;
    }

    function ensureFrame() {
        clearTimeout(idleTimer);
        if (ready) return ready;
        ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        frame = document.createElement('iframe');
        frame.className = 'mermaid-render-host';
        frame.title = '流程图隔离渲染';
        frame.setAttribute('aria-hidden', 'true');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.tabIndex = -1;
        frame.src = '/common/mermaid-render.html';
        frame.addEventListener('error', () => {
            const reject = readyReject;
            dropFrame(); reject?.(new Error('本地绘图组件加载失败，请重试或刷新页面。'));
        }, { once: true });
        loadTimer = setTimeout(() => {
            const reject = readyReject;
            dropFrame(); reject?.(new Error('本地绘图组件加载超时，请重试。'));
        }, 20000);
        document.body.appendChild(frame);
        return ready;
    }

    function remember(key, svg) {
        if (svg.length > 2 * 1024 * 1024) return;
        while (cache.size && (cache.size >= 12 || cacheBytes + svg.length > 4 * 1024 * 1024)) {
            const oldest = cache.keys().next().value;
            cacheBytes -= cache.get(oldest).length; cache.delete(oldest);
        }
        cache.set(key, svg); cacheBytes += svg.length;
    }

    async function drain() {
        if (running) return;
        running = true;
        try {
            while (queue.length) {
                const job = queue.shift();
                try {
                    await ensureFrame();
                    if (job.userId !== user()) throw new Error('账号已切换，请重新打开当前回复。');
                    const source = await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => {
                            if (active?.id !== job.id) return;
                            active = null; dropFrame(); reject(new Error('图形渲染超时，请减少节点或连线后重试。'));
                        }, 15000);
                        active = { id: job.id, resolve, reject, timer };
                        frame.contentWindow.postMessage({ type: 'pivot:mermaid-render', id: job.id, source: job.source, palette: job.palette }, '*');
                    });
                    const svg = window.Pivot.moduleApi('chat.mermaidSvg').sanitize(source);
                    if (job.userId !== user()) throw new Error('账号已切换，请重新打开当前回复。');
                    remember(job.key, svg); job.resolve(svg);
                } catch (error) { job.reject(error); }
                finally { pending.delete(job.key); }
            }
        } finally {
            running = false;
            if (!queue.length) idleTimer = setTimeout(dropFrame, 60000);
        }
    }

    function render(source, palette, { retry = false } = {}) {
        if (typeof source !== 'string' || !source.trim() || source.length > 65536) return Promise.reject(new Error('源码为空或超过 64KB，请检查并拆分图形。'));
        const userId = user();
        const key = `${userId}\0${JSON.stringify(palette)}\0${source}`;
        if (retry && cache.has(key)) { cacheBytes -= cache.get(key).length; cache.delete(key); }
        if (cache.has(key)) return Promise.resolve(cache.get(key));
        if (pending.has(key)) return pending.get(key);
        if (queue.length >= 24) return Promise.reject(new Error('当前图形较多，请稍后点击重试。'));
        const promise = new Promise((resolve, reject) => queue.push({ id: `mermaid-${++sequence}`, source, palette, key, userId, resolve, reject }));
        pending.set(key, promise);
        void drain();
        return promise;
    }

    window.addEventListener('message', event => {
        if (!frame || event.source !== frame.contentWindow) return;
        const data = event.data;
        if (data?.type === 'pivot:mermaid-unavailable') {
            const reject = readyReject;
            dropFrame(); reject?.(new Error('本地绘图组件加载失败，请重试或刷新页面。'));
        } else if (data?.type === 'pivot:mermaid-ready') {
            clearTimeout(loadTimer); readyResolve?.(); readyResolve = null; readyReject = null;
        } else if (data?.type === 'pivot:mermaid-result' && active && active.id === data.id) {
            const job = active; active = null; clearTimeout(job.timer);
            if (typeof data.svg === 'string') job.resolve(data.svg);
            else {
                const message = typeof data.error === 'string' ? data.error.slice(0, 320) : '图形渲染失败，请检查源码后重试。';
                job.reject(new Error(message));
            }
        }
    });
    window.addEventListener('pagehide', () => {
        const error = new Error('页面已离开，停止渲染。');
        for (const job of queue.splice(0)) { pending.delete(job.key); job.reject(error); }
        if (active) { clearTimeout(active.timer); active.reject(error); active = null; }
        readyReject?.(error); dropFrame(); cache.clear(); cacheBytes = 0;
    });
    window.Pivot.exposeModule('chat.mermaidRuntime', { render });
})();
