(function () {
    const scripts = [
        '/chat/data-analysis/context.js',
        '/chat/data-analysis/navigation-metadata.js',
        '/chat/data-analysis/view.js',
        '/chat/data-analysis/controls.js',
        '/chat/data-analysis/dataset-editor.js',
        '/chat/data-analysis/model-panels.js',
        '/chat/data-analysis/extra-panels.js',
        '/chat/data-analysis/core.js',
        '/chat/data-analysis/query.js',
        '/chat/data-analysis/async-query.js',
        '/chat/data-analysis/pivot.js',
        '/chat/data-analysis/chart.js',
        '/chat/data-analysis/compare-history.js',
        '/chat/data-analysis/cleaning.js',
        '/chat/data-analysis/ai.js',
        '/chat/data-analysis/database-import.js',
        '/chat/data-analysis/governance.js',
        '/chat/data-analysis/semantic-models.js',
        '/chat/data-analysis/dashboards.js',
        '/chat/data-analysis/scalability.js',
        '/chat/data-analysis/extensions.js',
        '/chat/data-analysis/transactions.js',
        '/chat/data-analysis/modeling-state.js',
        '/chat/data-analysis/modeling-view.js',
        '/chat/data-analysis/modeling-forms.js',
        '/chat/data-analysis/modeling-operators.js',
        '/chat/data-analysis/modeling-preview.js',
        '/chat/data-analysis/modeling-canvas.js',
        '/chat/data-analysis/modeling.js',
        '/chat/data-analysis/modeling-lifecycle.js',
        '/chat/data-analysis/modeling-consumers.js',
        '/chat/data-analysis/modeling-ownership.js',
        '/chat/data-analysis/modeling-migration.js',
        '/chat/data-analysis/modeling-sources.js',
        '/chat/data-analysis/source-metadata.js',
        '/chat/data-analysis/controlled-ingestion.js',
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
            script.onerror = () => reject(new Error('加载数据分析脚本失败：' + src));
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
        if (typeof window.Pivot.legacy.PivotDataAnalysis?.showDataAnalysisApp !== 'function') {
            throw new Error('数据分析应用加载失败');
        }
        return window.Pivot.legacy.PivotDataAnalysis.showDataAnalysisApp(options);
    }

    async function showDataModelingApp(options = {}) {
        await loadDataAnalysisModules();
        if (typeof window.Pivot.legacy.PivotDataAnalysis?.showDataModelingApp !== 'function') {
            throw new Error('数据建模应用加载失败');
        }
        return window.Pivot.legacy.PivotDataAnalysis.showDataModelingApp(options);
    }

    window.Pivot.legacy.showDataAnalysisApp = showDataAnalysisApp;
    window.Pivot?.exposeModule?.('apps.dataAnalysis', {
        showDataAnalysisApp,
        showDataModelingApp
    });
})();
