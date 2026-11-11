(() => {
    'use strict';
    let loading = null, sequence = 0;
    const pivot = window.Pivot;
    const account = () => String(pivot.legacy?.currentUser?.id || 'current-page');
    const load = () => {
        if (!loading) loading = pivot.loadScriptOnce('/chat/artifact-renderer.js')
            .then(() => pivot.loadScriptOnce('/chat/artifact-viewer.js'))
            .catch(error => { loading = null; throw error; });
        return loading;
    };
    const open = async (value, preview) => {
        const requested = ++sequence, userId = account();
        try {
            await load();
            if (requested !== sequence || userId !== account()) return;
            return preview ? pivot.ArtifactViewer.openPreview(value) : pivot.ArtifactViewer.open(value);
        } catch (error) {
            if (requested === sequence && userId === account()) pivot.legacy?.showToast?.(error.message || '产物查看器加载失败，请重试。', 'error');
        }
    };
    pivot.openArtifact = id => open(id, false);
    pivot.openArtifactPreview = artifact => open(artifact, true);
})();
