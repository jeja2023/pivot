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

    function formatVersionLabel(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        const match = text.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+)/i);
        if (!match) return '';
        return `v${match[1]}`;
    }

    function showUpdateNotice(info = {}) {
        if (document.getElementById('pwa-update-notice')) return;
        const notice = document.createElement('div');
        notice.id = 'pwa-update-notice';
        notice.className = 'pwa-update-notice';
        notice.setAttribute('role', 'status');
        notice.setAttribute('aria-live', 'polite');

        const text = document.createElement('span');
        text.className = 'pwa-update-notice__text';
        const versionLabel = formatVersionLabel(info.version) || formatVersionLabel(info.build);
        text.textContent = versionLabel ? `检测到新版本 ${versionLabel}` : '检测到新版本，请刷新页面';

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'pwa-update-notice__action';
        action.textContent = '刷新';

        const buildKey = String(info.build || info.version || Date.now()).trim() || String(Date.now());
        action.addEventListener('click', () => {
            localStorage.setItem(VERSION_KEY, buildKey);
            window.location.reload();
        });

        notice.appendChild(text);
        notice.appendChild(action);
        document.body.appendChild(notice);
    }

    async function checkVersion({ silent = false } = {}) {
        try {
            const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (!res.ok) return;
            const info = await res.json();
            const build = String(info.build || info.version || '').trim();
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
