/* 工作区切换的焦点保护：隐藏面板前先将焦点移至仍可访问的导航入口。 */
(() => {
function isElementVisible(el) {
    if (!el) return false;
    if (el.closest('.hidden, [hidden]')) return false;
    return el.offsetParent !== null || (typeof el.getClientRects === 'function' && el.getClientRects().length > 0);
}

function moveFocusOutsideHiddenWorkspace(panel, target) {
    if (!panel?.contains(document.activeElement)) return;
    const targetView = ['agent', 'agent-dag'].includes(target) ? 'automation' : target;
    const fallback = document.querySelector(`.sidebar-tool-btn[data-workspace-view="${targetView}"], .footer-mini-btn[data-workspace-view="${targetView}"]`)
        || document.getElementById('personal-workbench-btn');
    if (isElementVisible(fallback)) {
        fallback.focus({ preventScroll: true });
    }
    if (panel.contains(document.activeElement)) {
        document.activeElement?.blur?.();
    }
    if (panel.contains(document.activeElement) && document.body && typeof document.body.focus === 'function') {
        document.body.focus();
    }
}

window.Pivot?.exposeModule?.('workspaces.accessibility', { moveFocusOutsideHiddenWorkspace });
})();

