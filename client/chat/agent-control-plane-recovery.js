(function () {
    let inFlight = null;
    let dirty = false;
    let timer = null;
    let lastRun = 0;
    function visible() {
        if (document.hidden) return false;
        const panel = document.getElementById('agent-inbox-panel');
        const channels = document.getElementById('agent-channels-panel');
        return [panel, channels].some(item => item && !item.closest('.hidden, [hidden], [aria-hidden="true"]'));
    }
    async function refresh() {
        if (!visible()) return;
        const load = window.Pivot?.moduleApi?.('agent.harness')?.loadAgentControlPlane;
        if (typeof load !== 'function') return;
        if (inFlight) { dirty = true; return inFlight; }
        inFlight = Promise.resolve().then(() => load()).catch(() => {}).finally(() => { inFlight = null; });
        await inFlight;
        if (dirty) { dirty = false; return refresh(); }
    }
    function schedule({ immediate = false } = {}) {
        if (!visible()) return;
        if (timer && !immediate) return;
        if (timer) clearTimeout(timer);
        const wait = immediate ? 300 : Math.max(300, 15000 - (Date.now() - lastRun));
        timer = setTimeout(() => { timer = null; lastRun = Date.now(); void refresh(); }, wait);
    }
    window.Pivot?.exposeModule?.('agent.controlPlaneRecovery', { refresh, schedule });
})();
