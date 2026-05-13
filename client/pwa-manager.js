(function () {
    const VERSION_URL = '/version.json';
    const SW_URL = '/sw.js';
    const VERSION_KEY = 'pivot-current-build';
    const CHECK_INTERVAL_MS = 5 * 60 * 1000;
    let refreshing = false;

    function clearPivotCaches() {
        if (!window.caches) return Promise.resolve([]);
        return caches.keys().then(keys => Promise.all(
            keys.filter(key => key.startsWith('pivot-')).map(key => caches.delete(key))
        ));
    }

    function showUpdateNotice(info) {
        if (document.getElementById('pwa-update-notice')) return;
        const notice = document.createElement('div');
        notice.id = 'pwa-update-notice';
        notice.style.cssText = [
            'position:fixed',
            'right:18px',
            'bottom:18px',
            'z-index:9999',
            'display:flex',
            'align-items:center',
            'gap:10px',
            'padding:12px 14px',
            'background:#0f172a',
            'color:#fff',
            'border-radius:10px',
            'box-shadow:0 16px 36px rgba(15,23,42,.24)',
            'font-size:13px'
        ].join(';');
        notice.innerHTML = `
            <span>检测到新版本 ${escapeText(info.version || '')}</span>
            <button type="button" style="height:30px;padding:0 10px;border:0;border-radius:7px;background:#10a37f;color:#fff;cursor:pointer;">刷新</button>
        `;
        notice.querySelector('button')?.addEventListener('click', () => {
            localStorage.setItem(VERSION_KEY, info.build || info.version || String(Date.now()));
            window.location.reload();
        });
        document.body.appendChild(notice);
    }

    function escapeText(value) {
        return String(value || '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[ch]));
    }

    async function checkVersion({ silent = false } = {}) {
        try {
            const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (!res.ok) return;
            const info = await res.json();
            const build = info.build || info.version || '';
            if (!build) return;
            const previous = localStorage.getItem(VERSION_KEY);
            if (!previous) {
                localStorage.setItem(VERSION_KEY, build);
                return;
            }
            if (previous !== build) showUpdateNotice(info);
        } catch (err) {
            if (!silent) console.warn('版本检测失败:', err);
        }
    }

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        try {
            const registration = await navigator.serviceWorker.register(SW_URL, { updateViaCache: 'none' });
            if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
            registration.addEventListener('updatefound', () => {
                const worker = registration.installing;
                worker?.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                        worker.postMessage({ type: 'SKIP_WAITING' });
                        checkVersion({ silent: true });
                    }
                });
            });
        } catch (err) {
            console.warn('Service Worker 注册失败:', err);
        }

        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            refreshing = true;
            checkVersion({ silent: true });
        });
    }

    window.PivotPwa = {
        checkVersion,
        clearPivotCaches,
        reset: async function () {
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(reg => reg.unregister()));
            }
            await clearPivotCaches();
            localStorage.removeItem(VERSION_KEY);
        }
    };

    window.addEventListener('load', () => {
        registerServiceWorker();
        checkVersion({ silent: true });
        setInterval(() => checkVersion({ silent: true }), CHECK_INTERVAL_MS);
    });
})();
