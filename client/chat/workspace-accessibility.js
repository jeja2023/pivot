/* 工作区切换的焦点保护：隐藏面板前先将焦点移至仍可访问的导航入口。 */
(() => {
function moveFocusOutsideHiddenWorkspace(panel, target) {
    if (!panel?.contains(document.activeElement)) return;
    const targetView = ['agent', 'agent-dag'].includes(target) ? 'automation' : target;
    const fallback = document.querySelector(`.sidebar-tool-btn[data-workspace-view="${targetView}"], .footer-mini-btn[data-workspace-view="${targetView}"]`)
        || document.getElementById('personal-workbench-btn');
    if (fallback && !fallback.closest('.hidden, [hidden]')) fallback.focus({ preventScroll: true });
    else document.activeElement?.blur?.();
}

window.Pivot?.exposeModule?.('workspaces.accessibility', { moveFocusOutsideHiddenWorkspace });
})();
