(function () {
    const ns = window.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderReadyPromise || (ns.renderBaseReady && ns.renderShellReady && ns.renderDocumentsReady && ns.renderResultsReady)) return;
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
    const scripts = [
        '/chat/regulations/render-base.js',
        '/chat/regulations/render-shell.js',
        '/chat/regulations/render-documents.js',
        '/chat/regulations/render-results.js'
    ];
    ns.renderReadyPromise = (async () => {
        for (const src of scripts) {
            await loadScriptOnce(src);
        }
    })();
})();
