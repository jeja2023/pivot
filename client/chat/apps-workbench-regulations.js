(function () {
    const scripts = [
        '/chat/regulations/core.js',
        '/chat/regulations/render-base.js',
        '/chat/regulations/render-batch.js',
        '/chat/regulations/render-shell.js',
        '/chat/regulations/render-documents.js',
        '/chat/regulations/render-results.js',
        '/chat/regulations/actions-core.js',
        '/chat/regulations/actions-import.js',
        '/chat/regulations/actions-batch.js',
        '/chat/regulations/actions-batch-edit.js',
        '/chat/regulations/actions-governance.js',
        '/chat/regulations/actions-bookmarks.js',
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
            script.onerror = () => { script.remove(); reject(new Error(`加载法规脚本失败: ${src}`)); };
            if (!existing) {
                script.src = src;
                document.head.appendChild(script);
            }
        });
    }

    async function ensureRegulationsWorkbench() {
        if (window.Pivot.legacy.PivotRegulations?.ready) return window.Pivot.legacy.PivotRegulations;
        if (!readyPromise) {
            readyPromise = (async () => {
                // 并行预取但按依赖顺序执行；首个失败时停止，避免重试时使用不完整状态。
                const preloads = scripts.map(src => {
                    const link = document.createElement('link');
                    link.rel = 'preload';
                    link.as = 'script';
                    link.href = window.Pivot?.versionedAssetUrl?.(src) || src;
                    document.head.appendChild(link);
                    return link;
                });
                try {
                    for (const src of scripts) await loadScriptOnce(src);
                } finally {
                    preloads.forEach(link => link.remove());
                }
                if (!window.Pivot.legacy.PivotRegulations?.ready) {
                    throw new Error('法规工作台初始化失败');
                }
                return window.Pivot.legacy.PivotRegulations;
            })().catch(error => { readyPromise = null; throw error; });
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

    window.Pivot.legacy.PivotRegulations = Object.assign(window.Pivot.legacy.PivotRegulations || {}, {
        ensureReady: ensureRegulationsWorkbench,
        showRegulationsApp,
        loadDocuments,
        runSearch
    });
    window.Pivot.legacy.showRegulationsApp = showRegulationsApp;
})();
