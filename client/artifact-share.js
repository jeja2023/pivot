(async () => {
    'use strict';
    const status = document.getElementById('artifact-share-status');
    const content = document.getElementById('artifact-share-content');
    const id = location.pathname.split('/').filter(Boolean).at(-1);
    const controller = new AbortController();
    window.addEventListener('pagehide', () => { controller.abort(); content.replaceChildren(); }, { once: true });
    try {
        if (!/^[1-9]\d{0,18}$/.test(id || '')) throw new Error('分享地址无效，请联系分享者重新生成链接。');
        const response = await fetch(`/api/artifacts/shared/${encodeURIComponent(id)}`, { credentials: 'omit', cache: 'no-store', signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error || '共享内容暂不可用，请联系分享者核对。');
        if (controller.signal.aborted) return;
        const artifact = payload.data;
        document.getElementById('artifact-share-title').textContent = artifact.title || '共享产物';
        status.textContent = '公开分享 · 只读内容';
        const supported = ['html', 'react', 'vue', 'markdown', 'code', 'chart', 'diagram', 'interactive'];
        new window.Pivot.ArtifactRenderer().render(content, { ...artifact, type: supported.includes(artifact.type) ? artifact.type : 'code' }, { showToolbar: false });
    } catch (error) {
        if (controller.signal.aborted) return;
        content.replaceChildren(); status.textContent = error.message || '共享内容加载失败，请稍后重试。';
    }
})();
