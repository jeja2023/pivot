/* 设置工作区自适应缩放 */

let settingsWorkspaceScaleObserver = null;
let settingsWorkspaceScaleRaf = 0;
let lastObservedSettingsWidth = 0;
let lastObservedSettingsHeight = 0;

function scheduleSettingsWorkspaceScale() {
    if (settingsWorkspaceScaleRaf) window.cancelAnimationFrame(settingsWorkspaceScaleRaf);
    settingsWorkspaceScaleRaf = window.requestAnimationFrame(() => {
        settingsWorkspaceScaleRaf = 0;
        updateSettingsWorkspaceScale();
    });
}

function updateSettingsWorkspaceScale() {
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
                    scheduleSettingsWorkspaceScale();
                }
            }
        });
        settingsWorkspaceScaleObserver.observe(content);
    }
    const baseWidth = 1540;
    const contentStyle = window.getComputedStyle(content);
    const horizontalPadding = (parseFloat(contentStyle.paddingLeft) || 0) + (parseFloat(contentStyle.paddingRight) || 0);
    const verticalPadding = (parseFloat(contentStyle.paddingTop) || 0) + (parseFloat(contentStyle.paddingBottom) || 0);
    // 严格以排除纵向滚动条后的 clientInnerWidth 为可用宽度基准，舞台宽度向下取整且严格不超过 clientInnerWidth，杜绝任何水平溢出
    const clientInnerWidth = Math.max(1, (content.clientWidth || content.offsetWidth) - horizontalPadding);
    const availableWidth = clientInnerWidth;
    const availableHeight = Math.max(1, content.clientHeight - verticalPadding - 2);
    const useResponsiveCanvas = availableWidth < 1100;
    const layoutWidth = useResponsiveCanvas ? availableWidth : Math.max(baseWidth, availableWidth);
    const scale = useResponsiveCanvas ? 1 : Math.min(1, availableWidth / baseWidth);
    const stageWidth = Math.max(1, Math.min(clientInnerWidth, Math.floor(layoutWidth * scale)));
    const isMonitorTabActive = content.classList.contains('is-monitor-tab-active');
    stage.style.removeProperty('--settings-stage-height');
    canvas.style.setProperty('--settings-canvas-width', `${layoutWidth}px`);
    canvas.style.setProperty('--settings-scale', String(Number(scale.toFixed(4))));
    stage.style.setProperty('--settings-stage-width', `${stageWidth}px`);
    if (isMonitorTabActive) {
        const canvasHeight = Math.max(1, Math.ceil(availableHeight / scale));
        canvas.style.setProperty('--settings-canvas-height', `${canvasHeight}px`);
        stage.style.setProperty('--settings-stage-height', `${availableHeight}px`);
        if (content.scrollTop > 0) content.scrollTop = 0;
        return;
    }
    canvas.style.removeProperty('--settings-canvas-height');
    const measuredHeight = Math.ceil(canvas.scrollHeight * scale);
    // 预留 14px 容差，杜绝亚像素计算和字体渲染抖动导致的 1-5px 伪溢出触发右侧滚动条
    const scaledHeight = measuredHeight > availableHeight + 14 ? measuredHeight : availableHeight;
    stage.style.setProperty('--settings-stage-height', `${scaledHeight}px`);
    if (scaledHeight <= availableHeight && content.scrollTop > 0) {
        content.scrollTop = 0;
    }

    // 若样式文件尚未完全就绪，设定短延迟兜底，确保样式挂载并生效后必定再次纠偏画布尺寸
    const isStyleLoaded = window.Pivot?.moduleApi?.('workspaces.styleLoader')?.isWorkspaceStyleLoaded?.('settings');
    if (isStyleLoaded === false) {
        setTimeout(scheduleSettingsWorkspaceScale, 60);
        setTimeout(scheduleSettingsWorkspaceScale, 180);
        setTimeout(scheduleSettingsWorkspaceScale, 400);
    }
}

window.addEventListener('resize', () => {
    if (document.body?.dataset.activeWorkspace === 'settings') scheduleSettingsWorkspaceScale();
});

window.addEventListener('pivot:workspace-style-loaded', () => {
    if (document.body?.dataset.activeWorkspace === 'settings') scheduleSettingsWorkspaceScale();
});

window.Pivot?.exposeModule?.('settings.scale', {
    scheduleSettingsWorkspaceScale,
    updateSettingsWorkspaceScale
});
