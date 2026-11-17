(() => {
    'use strict';
    const pivot = window.Pivot;
    let sequence = 0;
    async function invoke(method, args) {
        const revision = sequence;
        const userId = pivot.legacy.currentUser?.id;
        try {
            await pivot.loadScriptOnce('/chat/agent-projects.js');
            document.removeEventListener('click', openFromButton);
            if (revision !== sequence || userId !== pivot.legacy.currentUser?.id) return;
            return pivot.moduleApi('agent.projects')[method](...args);
        } catch (error) {
            if (revision === sequence && userId === pivot.legacy.currentUser?.id) pivot.legacy.showToast?.(error.message || '项目空间加载失败，请重试。', 'error');
        }
    }
    function openFromButton(event) {
        if (!event.target?.closest?.('[data-open-projects]')) return;
        event.preventDefault();
        void invoke('open', []);
    }
    document.addEventListener('click', openFromButton);
    pivot.exposeModule('agent.projects', {
        open: (...args) => invoke('open', args),
        refreshSelect: (...args) => invoke('refreshSelect', args),
        reset: () => { sequence++; }
    });
})();
