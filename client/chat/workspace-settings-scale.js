/* 设置工作区自适应缩放 */

let settingsWorkspaceScaleObserver = null;
let settingsWorkspaceScaleRaf = 0;
let lastObservedSettingsWidth = 0;
let lastObservedSettingsHeight = 0;

window.Pivot.legacy.scheduleSettingsWorkspaceScale = function() {
    if (settingsWorkspaceScaleRaf) window.cancelAnimationFrame(settingsWorkspaceScaleRaf);
    settingsWorkspaceScaleRaf = window.requestAnimationFrame(() => {
        settingsWorkspaceScaleRaf = 0;
        window.Pivot.legacy.updateSettingsWorkspaceScale?.();
    });
};

window.Pivot.legacy.updateSettingsWorkspaceScale = function() {
    const stage = document.getElementById('settings-scale-stage');
    const canvas = document.getElementById('settings-scale-canvas');
    const content = document.querySelector('.settings-workspace-view .admin-content');
    if (!stage || !canvas || !content) return;
    if (window.ResizeObserver && !settingsWorkspaceScaleObserver) {
        settingsWorkspaceScaleObserver = new window.ResizeObserver((entries) => {
            if (document.body?.dataset.activeWorkspace === 'settings') {
                const entry = entries?.[0];
                const width = entry?.contentRect?.width || content.clientWidth;
                const height = entry?.contentRect?.height || content.clientHeight;
                if (Math.abs(width - lastObservedSettingsWidth) > 1 || Math.abs(height - lastObservedSettingsHeight) > 1) {
                    lastObservedSettingsWidth = width;
                    lastObservedSettingsHeight = height;
                    window.Pivot.legacy.scheduleSettingsWorkspaceScale?.();
                }
            }
        });
        settingsWorkspaceScaleObserver.observe(content);
    }
    const baseWidth = 1540;
    const contentStyle = window.getComputedStyle(content);
    const horizontalPadding = (parseFloat(contentStyle.paddingLeft) || 0) + (parseFloat(contentStyle.paddingRight) || 0);
    const verticalPadding = (parseFloat(contentStyle.paddingTop) || 0) + (parseFloat(contentStyle.paddingBottom) || 0);
    const availableWidth = Math.max(1, content.clientWidth - horizontalPadding - 2);
    const availableHeight = Math.max(1, content.clientHeight - verticalPadding - 2);
    const useResponsiveCanvas = availableWidth < 1100;
    const layoutWidth = useResponsiveCanvas ? availableWidth : Math.max(baseWidth, availableWidth);
    const scale = useResponsiveCanvas ? 1 : Math.min(1, availableWidth / baseWidth);
    const stageWidth = Math.max(1, Math.ceil(layoutWidth * scale));
    const isMonitorTabActive = content.classList.contains('is-monitor-tab-active');
    stage.style.removeProperty('--settings-stage-height');
    canvas.style.setProperty('--settings-canvas-width', `${layoutWidth}px`);
    canvas.style.setProperty('--settings-scale', String(Number(scale.toFixed(4))));
    stage.style.setProperty('--settings-stage-width', `${stageWidth}px`);
    if (isMonitorTabActive) {
        const canvasHeight = Math.max(1, Math.ceil(availableHeight / scale));
        canvas.style.setProperty('--settings-canvas-height', `${canvasHeight}px`);
        stage.style.setProperty('--settings-stage-height', `${availableHeight}px`);
        return;
    }
    canvas.style.removeProperty('--settings-canvas-height');
    const measuredHeight = Math.ceil(canvas.scrollHeight * scale);
    const scaledHeight = measuredHeight > availableHeight + 2 ? measuredHeight : availableHeight;
    stage.style.setProperty('--settings-stage-height', `${scaledHeight}px`);
};

window.addEventListener('resize', () => {
    if (document.body?.dataset.activeWorkspace === 'settings') window.Pivot.legacy.scheduleSettingsWorkspaceScale?.();
});
