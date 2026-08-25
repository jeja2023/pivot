// Memory usage explanation UI is kept separate from the large settings module.
(function () {
    window.Pivot?.exposeModule?.('settings.memoryUsage', {
        async fetch(memoryId) {
            const res = await apiFetch(`${API_BASE}/memories/${encodeURIComponent(memoryId)}/usage`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '记忆使用说明加载失败');
            return data.usage || {};
        }
    });
}());
