(function () {
    const scripts = [
        '/chat/regulations/core.js',
        '/chat/regulations/render-base.js',
        '/chat/regulations/render-shell.js',
        '/chat/regulations/render-documents.js',
        '/chat/regulations/render-results.js',
        '/chat/regulations/actions-core.js',
        '/chat/regulations/actions-import.js',
        '/chat/regulations/actions-advanced.js',
        '/chat/regulations/events.js'
    ];
    let readyPromise = null;

    function loadScriptOnce(src) {
        if (window.Pivot?.loadScriptOnce) return window.Pivot.loadScriptOnce(src);
        return new Promise((resolve, reject) => {
            const existing = Array.from(document.scripts).find(script => (script.getAttribute('src') || '').includes(src));
            if (existing && existing.dataset.loaded !== 'false') {
                resolve();
                return;
            }
            const script = existing || document.createElement('script');
            script.async = false;
            script.dataset.loaded = 'false';
            script.onload = () => {
                script.dataset.loaded = 'true';
                resolve();
            };
            script.onerror = () => reject(new Error(`加载法规脚本失败: ${src}`));
            if (!existing) {
                script.src = src;
                document.head.appendChild(script);
            }
        });
    }

    async function ensureRegulationsWorkbench() {
        if (window.PivotRegulations?.ready) return window.PivotRegulations;
        if (!readyPromise) {
            readyPromise = (async () => {
                for (const src of scripts) {
                    await loadScriptOnce(src);
                }
                if (!window.PivotRegulations?.ready) {
                    throw new Error('法规工作台初始化失败');
                }
                return window.PivotRegulations;
            })();
        }
        return readyPromise;
    }

    async function showRegulationsApp() {
        const api = await ensureRegulationsWorkbench();
        return api.showRegulationsApp();
    }

    async function loadDocuments(options) {
        const api = await ensureRegulationsWorkbench();
        return api.loadDocuments(options);
    }

    async function runSearch() {
        const api = await ensureRegulationsWorkbench();
        return api.runSearch();
    }

    window.PivotRegulations = Object.assign(window.PivotRegulations || {}, {
        ensureReady: ensureRegulationsWorkbench,
        showRegulationsApp,
        loadDocuments,
        runSearch
    });
    window.showRegulationsApp = showRegulationsApp;
})();
