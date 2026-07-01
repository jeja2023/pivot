(function () {
    const ns = window.PivotRegulationsInternal;
    if (!ns) throw new Error('Pivot regulations core is not loaded');
    if (ns.actionsReadyPromise || (ns.actionsCoreReady && ns.actionsImportReady && ns.actionsAdvancedReady)) return;
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
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            if (!existing) {
                script.src = src;
                document.head.appendChild(script);
            }
        });
    }
    const scripts = [
        '/chat/regulations/actions-core.js',
        '/chat/regulations/actions-import.js',
        '/chat/regulations/actions-advanced.js'
    ];
    ns.actionsReadyPromise = (async () => {
        for (const src of scripts) {
            await loadScriptOnce(src);
        }
    })();
})();
