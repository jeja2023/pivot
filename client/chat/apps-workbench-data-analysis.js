(function () {
    const scripts = [
        '/chat/data-analysis/context.js',
        '/chat/data-analysis/view.js',
        '/chat/data-analysis/core.js',
        '/chat/data-analysis/query.js',
        '/chat/data-analysis/pivot.js',
        '/chat/data-analysis/chart.js',
        '/chat/data-analysis/compare-history.js',
        '/chat/data-analysis/ai.js',
        '/chat/data-analysis/database-import.js',
        '/chat/data-analysis/events.js'
    ];

    let loadingPromise = null;

    function loadScriptFallback(src) {
        return new Promise((resolve, reject) => {
            const existing = Array.from(document.scripts).find(script => (script.getAttribute('src') || '').includes(src));
            if (existing && existing.dataset.loaded !== 'false') {
                resolve();
                return;
            }
            const script = existing || document.createElement('script');
            script.async = false;
            script.onload = () => {
                script.dataset.loaded = 'true';
                resolve();
            };
            script.onerror = () => reject(new Error('Failed to load script: ' + src));
            if (!existing) {
                script.dataset.loaded = 'false';
                script.src = src;
                document.head.appendChild(script);
            }
        });
    }

    async function loadDataAnalysisModules() {
        if (!loadingPromise) {
            loadingPromise = (async () => {
                if (window.Pivot?.loadScripts) {
                    await window.Pivot.loadScripts(scripts);
                    return;
                }
                for (const src of scripts) {
                    await loadScriptFallback(src);
                }
            })();
        }
        return loadingPromise;
    }

    async function showDataAnalysisApp(options = {}) {
        await loadDataAnalysisModules();
        if (typeof window.PivotDataAnalysis?.showDataAnalysisApp !== 'function') {
            throw new Error('数据分析应用加载失败');
        }
        return window.PivotDataAnalysis.showDataAnalysisApp(options);
    }

    window.showDataAnalysisApp = showDataAnalysisApp;
    window.Pivot?.exposeModule?.('apps.dataAnalysis', {
        showDataAnalysisApp
    });
})();
