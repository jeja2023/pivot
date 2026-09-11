/* global window, document */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pivotDesktop', {
    retry() {
        return ipcRenderer.invoke('pivot-desktop:retry');
    },
    getStatus() {
        return ipcRenderer.invoke('pivot-desktop:status');
    },
    getServerConfig() {
        return ipcRenderer.invoke('pivot-desktop:get-server-config');
    },
    openServerConfigDialog() {
        return ipcRenderer.invoke('pivot-desktop:open-server-config-dialog');
    },
    reload(options = {}) {
        return ipcRenderer.invoke('pivot-desktop:reload', {
            clearCache: options && options.clearCache === true
        });
    },
    quit() {
        return ipcRenderer.invoke('pivot-desktop:quit');
    },
    windowAction(action) {
        return ipcRenderer.invoke('pivot-desktop:window-action', action);
    },
    getLocalAuthorizationStatus() {
        return ipcRenderer.invoke('pivot-local-auth:status');
    },
    requestLocalAuthorization(type, options = {}) {
        return ipcRenderer.invoke('pivot-local-auth:grant', type, options || {});
    },
    revokeLocalAuthorization(type) {
        return ipcRenderer.invoke('pivot-local-auth:revoke', type);
    },
    async executeLocalMcpTool(task) {
        const response = await ipcRenderer.invoke('pivot-local-auth:execute-tool', task || {});
        if (response && response.success === false) {
            const error = new Error(response.error?.message || '本机执行失败。');
            error.status = Number(response.error?.status || 0) || 500;
            error.statusCode = error.status;
            error.code = response.error?.code || '';
            error.detail = response.error?.detail || '';
            throw error;
        }
        return response && response.success === true ? response.result : response;
    },
    getLocalMcpConnectorStatus() {
        return ipcRenderer.invoke('pivot-local-connector:status');
    },
    syncLocalMcpConnector() {
        return ipcRenderer.invoke('pivot-local-connector:sync');
    },
    getDeliveryStatus() {
        return ipcRenderer.invoke('pivot-delivery:status');
    },
    startDelivery() {
        return ipcRenderer.invoke('pivot-delivery:start');
    },
    stopDelivery() {
        return ipcRenderer.invoke('pivot-delivery:stop');
    },
    authorizeDeliveryDirectory(options = {}) {
        return ipcRenderer.invoke('pivot-delivery:authorize-directory', options || {});
    },
    revokeDeliveryDirectory(grantId) {
        return ipcRenderer.invoke('pivot-delivery:revoke-directory', String(grantId || ''));
    },
    requestAgentWorkerApproval(task = {}) {
        return ipcRenderer.invoke('pivot-agent:request-approval', task || {});
    },
    runAgentWorker(task = {}, approvalToken = '') {
        return ipcRenderer.invoke('pivot-agent:run-worker', task || {}, String(approvalToken || ''));
    },
    checkForUpdates() {
        return ipcRenderer.invoke('pivot-updater:check');
    },
    downloadUpdate() {
        return ipcRenderer.invoke('pivot-updater:download');
    },
    installUpdate() {
        return ipcRenderer.invoke('pivot-updater:install');
    },
    getUpdateStatus() {
        return ipcRenderer.invoke('pivot-updater:status');
    },
    onUpdateEvent(callback) {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('pivot-updater:event', listener);
        return () => ipcRenderer.removeListener('pivot-updater:event', listener);
    }
});

function ensureDesktopRuntimeClass() {
    try {
        if (document.documentElement && !document.documentElement.classList.contains('pivot-desktop-runtime')) {
            document.documentElement.classList.add('pivot-desktop-runtime');
        }
        if (document.body && !document.body.classList.contains('pivot-desktop-runtime')) {
            document.body.classList.add('pivot-desktop-runtime');
        }
    } catch (_) {}
}

function installSessionListScrollFallback() {
    ensureDesktopRuntimeClass();
    const styleId = 'pivot-desktop-session-list-scroll-fallback';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            html,
            body {
                height: 100% !important;
                min-height: 0 !important;
                overflow: hidden !important;
            }
            #app {
                height: calc(100vh - 30px) !important;
                height: calc(100dvh - 30px) !important;
                min-height: 0 !important;
                box-sizing: border-box !important;
            }
            body.is-main-workspace-full .sidebar {
                display: none !important;
            }
            body:not(.is-main-workspace-full) .sidebar {
                display: flex !important;
                flex-direction: column !important;
                height: 100% !important;
                min-height: 0 !important;
                align-self: stretch !important;
            }
            .sidebar.collapsed {
                margin-left: calc(var(--sidebar-width, 336px) * -1) !important;
            }
            #session-list {
                flex: 1 1 0 !important;
                min-height: 0 !important;
                max-height: 100% !important;
                overflow-x: hidden !important;
                overflow-y: scroll !important;
                overscroll-behavior-y: contain !important;
                touch-action: pan-y !important;
                scrollbar-gutter: stable !important;
                -ms-overflow-style: auto !important;
            }
            @supports not selector(::-webkit-scrollbar) {
                #session-list {
                    scrollbar-width: thin !important;
                    scrollbar-color: transparent transparent !important;
                }
                #session-list.scrollbar-visible {
                    scrollbar-color: var(--scrollbar-thumb, rgba(148, 163, 184, 0.45)) var(--scrollbar-track, transparent) !important;
                }
            }
            #session-list::-webkit-scrollbar {
                display: block !important;
                width: 5px !important;
                height: 5px !important;
            }
            #session-list::-webkit-scrollbar-track {
                display: block !important;
                background: var(--scrollbar-track, transparent) !important;
                border-radius: 999px !important;
            }
            #session-list::-webkit-scrollbar-thumb {
                display: block !important;
                min-height: 28px !important;
                border: none !important;
                border-radius: 999px !important;
                background: transparent !important;
                transition: background 0.18s ease !important;
            }
            #session-list.scrollbar-visible::-webkit-scrollbar-thumb {
                background: var(--scrollbar-thumb, rgba(148, 163, 184, 0.45)) !important;
            }
            #session-list.scrollbar-visible::-webkit-scrollbar-thumb:hover {
                background: var(--scrollbar-thumb-hover, rgba(100, 116, 139, 0.72)) !important;
            }
            #session-list.scrollbar-visible::-webkit-scrollbar-thumb:active {
                background: var(--scrollbar-thumb-active, rgba(51, 65, 85, 0.9)) !important;
            }
        `;
        if (document.head) document.head.appendChild(style);
    }

    const isVisibleModalTarget = target => {
        const modal = target && typeof target.closest === 'function'
            ? target.closest('.modal-overlay, [role="dialog"]')
            : null;
        if (!modal || modal.classList.contains('hidden')) return false;
        const style = window.getComputedStyle(modal);
        const opacity = Number.parseFloat(style.opacity);
        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.pointerEvents !== 'none'
            && (!Number.isFinite(opacity) || opacity > 0.01);
    };

    const hasVisibleModal = () => [...document.querySelectorAll('.modal-overlay, [role="dialog"]')]
        .some(modal => isVisibleModalTarget(modal));

    const scrollSessionList = (list, rawDeltaY, deltaMode = 0) => {
        const targetList = list || document.getElementById('session-list');
        if (!targetList || targetList.scrollHeight <= targetList.clientHeight) return false;
        const raw = Number(rawDeltaY) || 0;
        if (!raw) return false;

        let deltaY = 0;
        if (deltaMode === 1) {
            deltaY = raw * 36;
        } else if (deltaMode === 2) {
            deltaY = raw * (targetList.clientHeight || 360);
        } else {
            const abs = Math.abs(raw);
            if (abs < 1) {
                deltaY = raw;
            } else if (abs < 30) {
                // 触控板/高精度滚轮微步放大平滑度，避免整数截断无响应
                deltaY = Math.sign(raw) * Math.max(32, abs * 2.2);
            } else {
                deltaY = raw;
            }
        }

        const maxScrollTop = Math.max(0, targetList.scrollHeight - targetList.clientHeight);
        const nextScrollTop = Math.min(maxScrollTop, Math.max(0, targetList.scrollTop + deltaY));
        if (nextScrollTop === targetList.scrollTop) return false;
        targetList.scrollTop = nextScrollTop;
        return true;
    };

    let viewportSyncScheduled = false;
    let pointerInsideSessionList = false;

    const setSessionListPointerInside = inside => {
        const next = inside === true;
        if (pointerInsideSessionList === next) return;
        pointerInsideSessionList = next;
        scheduleSessionListViewportSync();
    };

    const publishSessionListViewport = () => {
        viewportSyncScheduled = false;
        const list = document.getElementById('session-list');
        const sidebar = list?.closest('.sidebar');
        const app = document.getElementById('app');
        const inactive = !list || !sidebar
            || document.body?.classList.contains('auth-active')
            || app?.classList.contains('hidden')
            || hasVisibleModal();
        if (inactive) {
            pointerInsideSessionList = false;
            ipcRenderer.send('pivot-desktop:session-list-viewport', { active: false });
            return;
        }

        const rect = sidebar.getBoundingClientRect();
        const active = rect.width > 0 && rect.height > 0;
        ipcRenderer.send('pivot-desktop:session-list-viewport', {
            active,
            scrollable: list.scrollHeight > list.clientHeight,
            modalOpen: false,
            pointerInside: pointerInsideSessionList,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom
        });
    };

    const scheduleSessionListViewportSync = () => {
        if (viewportSyncScheduled) return;
        viewportSyncScheduled = true;
        window.requestAnimationFrame(publishSessionListViewport);
    };

    const resolveWheelSessionList = event => {
        const list = document.getElementById('session-list');
        if (!list) return null;
        const target = event.target;
        if (target && typeof target.closest === 'function') {
            if (target.closest('#session-list, .sidebar-session-section-label')) return list;
            if (target.closest('.sidebar')) return list;
        }

        // Chromium/Electron 在无边框窗口、透明层或合成层切换后，偶尔会把
        // wheel.target 报为 BODY/HTML/覆盖层。此时按指针坐标识别侧栏，避免
        // 因错误的命中目标丢掉滚轮；真正可见的弹窗仍保持独立滚动。
        const app = document.getElementById('app');
        if (document.body?.classList.contains('auth-active') || app?.classList.contains('hidden')) return null;
        if (isVisibleModalTarget(target)) return null;
        const sidebar = list.closest('.sidebar');
        if (!sidebar) return null;
        const rect = sidebar.getBoundingClientRect();
        const x = Number(event.clientX);
        const y = Number(event.clientY);
        return Number.isFinite(x) && Number.isFinite(y)
            && x >= rect.left && x <= rect.right
            && y >= rect.top && y <= rect.bottom
            ? list
            : null;
    };

    // 远程服务可能尚未升级到与客户端匹配的 CSS。在滚轮事件命中侧栏
    // 且会话列表有溢出内容时兜底更新 scrollTop，确保任何鼠标与触控板均可顺畅浏览。
    document.addEventListener('wheel', event => {
        const list = resolveWheelSessionList(event);
        if (scrollSessionList(list, event.deltaY, event.deltaMode)) event.preventDefault();
    }, { capture: true, passive: false });

    // 主进程在 DOM 事件分发前截获原生 mouseWheel。这里只接收已经完成
    // 可信来源和侧栏范围校验的输入，再以同一套边界规则更新列表位置。
    ipcRenderer.on('pivot-desktop:session-list-wheel', (_event, input) => {
        const list = document.getElementById('session-list');
        if (hasVisibleModal()) return;
        scrollSessionList(list, input?.deltaY, 0);
    });

    const list = document.getElementById('session-list');
    const sidebar = list?.closest('.sidebar');
    const onEnter = () => setSessionListPointerInside(true);
    const onLeave = () => setSessionListPointerInside(false);
    list?.addEventListener('pointerenter', onEnter, { passive: true });
    list?.addEventListener('pointerleave', onLeave, { passive: true });
    sidebar?.addEventListener('pointerenter', onEnter, { passive: true });
    sidebar?.addEventListener('pointerleave', onLeave, { passive: true });
    document.addEventListener('pointermove', event => {
        const currentSidebar = document.getElementById('session-list')?.closest('.sidebar');
        if (currentSidebar && currentSidebar.contains(event.target)) {
            setSessionListPointerInside(true);
        }
    }, { passive: true });
    window.addEventListener('blur', onLeave, { passive: true });
    if (typeof window.ResizeObserver === 'function') {
        const resizeObserver = new window.ResizeObserver(scheduleSessionListViewportSync);
        if (list) resizeObserver.observe(list);
        if (sidebar) resizeObserver.observe(sidebar);
    }
    const mutationObserver = new window.MutationObserver(scheduleSessionListViewportSync);
    mutationObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
        childList: true,
        subtree: true
    });
    window.addEventListener('resize', scheduleSessionListViewportSync, { passive: true });
    scheduleSessionListViewportSync();

    // --- Scrollbar hover visibility for Electron ---
    // 桌面客户端也需要JS控制滚动条显示/隐藏
    if (list && sidebar) {
        let hoverTimer = null;
        const HIDE_DELAY = 800;

        const showScrollbar = () => {
            if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
            if (list.scrollHeight > list.clientHeight) {
                list.classList.add('scrollbar-visible');
            }
        };

        const hideScrollbar = () => {
            if (hoverTimer) clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                list.classList.remove('scrollbar-visible');
                hoverTimer = null;
            }, HIDE_DELAY);
        };

        sidebar.addEventListener('pointerenter', showScrollbar, { passive: true });
        sidebar.addEventListener('pointerleave', hideScrollbar, { passive: true });
        window.addEventListener('blur', hideScrollbar, { passive: true });

        // 窗口 resize/maximize 时强制重排并重新评估
        let resizeRafId = null;
        const onResize = () => {
            if (resizeRafId) return;
            resizeRafId = requestAnimationFrame(() => {
                resizeRafId = null;
                void list.offsetHeight;
                if (sidebar.matches(':hover') && list.scrollHeight > list.clientHeight) {
                    list.classList.add('scrollbar-visible');
                }
            });
        };
        window.addEventListener('resize', onResize, { passive: true });

        // ResizeObserver 同步
        if (typeof window.ResizeObserver === 'function') {
            const scrollbarRo = new window.ResizeObserver(() => {
                if (sidebar.matches(':hover') && list.scrollHeight > list.clientHeight) {
                    list.classList.add('scrollbar-visible');
                }
            });
            scrollbarRo.observe(list);
        }
    }
}

function bootstrapDesktopSessionScroll() {
    ensureDesktopRuntimeClass();
    const style = document.createElement('style');
    style.innerHTML = `
        body::before {
            content: "";
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: rgba(0, 0, 0, 0.08);
            z-index: 999999;
            pointer-events: none;
        }
        @media (prefers-color-scheme: dark) {
            body::before {
                background: rgba(255, 255, 255, 0.12);
            }
        }
    `;
    if (document.head) document.head.appendChild(style);
    installSessionListScrollFallback();
}

ensureDesktopRuntimeClass();
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootstrapDesktopSessionScroll, { once: true });
} else {
    bootstrapDesktopSessionScroll();
}
