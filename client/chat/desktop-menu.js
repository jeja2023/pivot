(function () {
    const desktopApi = window.pivotDesktop;
    if (!desktopApi) return;

    const menuRoot = document.getElementById('desktop-app-menu');
    if (!menuRoot) return;

    document.body?.classList.add('pivot-desktop-runtime');
    menuRoot.hidden = false;

    const MENU_GROUPS = {
        pivot: [
            { header: '客户端与连接' },
            { label: '服务器连接配置...', action: 'server-config', shortcut: 'Ctrl+,' },
            { label: '配置受控交付目录...', action: 'configure-delivery' },
            { label: '查看受控交付状态', action: 'delivery-status' },
            { label: '检查客户端更新', action: 'check-updates' },
            { separator: true },
            { header: '视图与显示' },
            { label: '实际大小', action: 'window:zoom-reset', shortcut: 'Ctrl+0' },
            { label: '放大', action: 'window:zoom-in', shortcut: 'Ctrl+=' },
            { label: '缩小', action: 'window:zoom-out', shortcut: 'Ctrl+-' },
            { label: '切换全屏', action: 'window:toggle-fullscreen', shortcut: 'F11' },
            { separator: true },
            { header: '排障与维护' },
            { label: '刷新页面', action: 'reload', shortcut: 'Ctrl+R' },
            { label: '清理缓存并刷新', action: 'clear-cache-and-reload', shortcut: 'Ctrl+Shift+R' },
            { separator: true },
            { label: '关于 Pivot', action: 'about' },
            { separator: true },
            { label: '退出客户端', action: 'quit-client', shortcut: 'Ctrl+Q' }
        ]
    };

    let activeMenu = '';
    let activeButton = null;
    let activeUpdateState = null;
    let lastNotifiedVersion = '';
    let isServerConfigLocked = false;
    const popover = document.createElement('div');
    popover.className = 'desktop-app-menu-popover hidden';
    popover.setAttribute('role', 'menu');
    document.body.appendChild(popover);

    function toast(message, type = 'success') {
        if (typeof showToast === 'function') showToast(message, type);
    }

    function applyUpdateState(state, isBackground = false) {
        if (!state) return;
        activeUpdateState = state;
        const brandTrigger = menuRoot.querySelector('[data-desktop-menu="pivot"]');
        if (!brandTrigger) return;
        if (state.status === 'available' || state.status === 'downloading') {
            brandTrigger.classList.add('has-update');
            brandTrigger.classList.remove('is-ready');
            const version = state.updateInfo?.version ? 'v' + state.updateInfo.version : '';
            if (isBackground && version && version !== lastNotifiedVersion) {
                lastNotifiedVersion = version;
                toast('检测到客户端更新 ' + version + '，正在后台下载...', 'info');
            }
        } else if (state.status === 'downloaded') {
            brandTrigger.classList.add('has-update', 'is-ready');
            const version = state.updateInfo?.version ? 'v' + state.updateInfo.version : '';
            if (isBackground && version && version !== lastNotifiedVersion) {
                lastNotifiedVersion = version;
                toast('客户端更新 ' + version + ' 已下载完毕，点击 Pivot 菜单即可重启安装', 'success');
            }
        } else if (state.status === 'not-available' || state.status === 'idle') {
            brandTrigger.classList.remove('has-update', 'is-ready');
        }
    }

    function closeMenu() {
        activeMenu = '';
        activeButton?.classList.remove('is-open');
        activeButton?.setAttribute('aria-expanded', 'false');
        activeButton = null;
        popover.classList.add('hidden');
        popover.replaceChildren();
    }

    function positionPopover(button) {
        const rect = button.getBoundingClientRect();
        const width = popover.offsetWidth || 230;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const top = Math.min(rect.bottom + 4, window.innerHeight - 12);
        popover.style.left = left + 'px';
        popover.style.top = top + 'px';
    }

    function openMenu(name, button) {
        if (!MENU_GROUPS[name]) return;
        if (activeMenu === name) {
            closeMenu();
            return;
        }
        closeMenu();
        activeMenu = name;
        activeButton = button;
        activeButton.classList.add('is-open');
        activeButton.setAttribute('aria-expanded', 'true');
        popover.replaceChildren();
        MENU_GROUPS[name].forEach(item => {
            if (item.action === 'server-config' && isServerConfigLocked) {
                return;
            }
            if (item.header) {
                const header = document.createElement('div');
                header.className = 'desktop-app-menu-section-header';
                let headerText = item.header;
                if (headerText === '客户端与连接' && isServerConfigLocked) {
                    headerText = '受控文档交付';
                }
                header.textContent = headerText;
                popover.appendChild(header);
                return;
            }
            if (item.separator) {
                const separator = document.createElement('div');
                separator.className = 'desktop-app-menu-separator';
                separator.setAttribute('role', 'separator');
                popover.appendChild(separator);
                return;
            }
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'desktop-app-menu-item';
            option.dataset.desktopAction = item.action;
            option.setAttribute('role', 'menuitem');
            const label = document.createElement('span');
            let itemLabel = item.label;
            let badgeText = '';
            let badgeClass = '';
            if (item.action === 'check-updates') {
                if (activeUpdateState?.status === 'downloaded') {
                    itemLabel = '重启并安装更新';
                    badgeText = '已就绪';
                    badgeClass = 'is-ready';
                } else if (activeUpdateState?.status === 'downloading') {
                    itemLabel = '正在下载更新...';
                    const percent = Math.floor(activeUpdateState.progress?.percent || 0);
                    badgeText = percent > 0 ? percent + '%' : '下载中';
                } else if (activeUpdateState?.status === 'available') {
                    badgeText = '新版本';
                }
            }
            label.textContent = itemLabel;
            option.appendChild(label);
            if (badgeText) {
                const badge = document.createElement('span');
                badge.className = 'desktop-app-menu-badge ' + badgeClass;
                badge.textContent = badgeText;
                option.appendChild(badge);
            } else if (item.shortcut) {
                const shortcut = document.createElement('span');
                shortcut.className = 'desktop-app-menu-shortcut';
                shortcut.textContent = item.shortcut;
                option.appendChild(shortcut);
            }
            popover.appendChild(option);
        });
        popover.classList.remove('hidden');
        positionPopover(button);
    }

    async function reloadDesktop(clearCache = false) {
        try {
            if (clearCache) {
                toast('正在清理客户端缓存并刷新...', 'info');
                if (window.Pivot?.legacy?.PivotPwa?.reset) await window.Pivot.legacy.PivotPwa.reset();
            }
            if (typeof desktopApi.reload === 'function') {
                await desktopApi.reload({ clearCache });
                return;
            }
        } catch (error) {
            console.warn('客户端刷新失败', error);
            toast('客户端刷新失败，已尝试普通刷新', 'warning');
        }
        window.location.reload();
    }

    function runEditCommand(command) {
        const ok = document.execCommand(command);
        if (!ok && command === 'paste') toast('请使用 Ctrl+V 粘贴', 'info');
    }

    async function runWindowAction(action) {
        if (typeof desktopApi.windowAction !== 'function') {
            toast('当前客户端暂不支持该窗口操作', 'warning');
            return;
        }
        const ok = await desktopApi.windowAction(action);
        if (ok === false) toast('当前客户端暂不支持该窗口操作', 'warning');
    }

    function showUpdateState(state) {
        applyUpdateState(state, false);
        if (!state || state.enabled === false) {
            toast(state?.error || '当前客户端未启用自动更新', 'info');
            return;
        }
        if (state.status === 'checking') toast('正在检查客户端更新...', 'info');
        else if (state.status === 'available') toast('检测到客户端更新，可在更新提示中继续处理', 'success');
        else if (state.status === 'downloaded') toast('客户端更新已下载，重启后安装', 'success');
        else if (state.status === 'not-available') toast('当前已是最新客户端', 'success');
        else if (state.error) toast(state.error, 'error');
        else toast('已发起客户端更新检查', 'info');
    }

    async function executeAction(action) {
        closeMenu();
        switch (action) {
            case 'reload':
                await reloadDesktop(false);
                break;
            case 'clear-cache-and-reload':
                await reloadDesktop(true);
                break;
            case 'server-config':
                await runWindowAction('server-config');
                break;
            case 'configure-delivery':
                await runWindowAction('configure-delivery');
                break;
            case 'delivery-status':
                await runWindowAction('delivery-status');
                break;
            case 'check-updates':
                if (activeUpdateState?.status === 'downloaded') {
                    toast('正在准备重启并安装更新...', 'info');
                    await desktopApi.installUpdate?.();
                    break;
                }
                showUpdateState(await desktopApi.checkForUpdates?.());
                break;
            case 'about':
                await runWindowAction('about');
                break;
            case 'quit-client':
                await desktopApi.quit?.();
                break;
            case 'edit:undo':
            case 'edit:redo':
            case 'edit:cut':
            case 'edit:copy':
            case 'edit:paste':
            case 'edit:selectAll':
                runEditCommand(action.slice('edit:'.length));
                break;
            default:
                if (action.startsWith('window:')) await runWindowAction(action.slice('window:'.length));
                break;
        }
    }

    menuRoot.addEventListener('click', (event) => {
        const button = event.target.closest('[data-desktop-menu]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        openMenu(button.dataset.desktopMenu, button);
    });

    popover.addEventListener('click', (event) => {
        const item = event.target.closest('[data-desktop-action]');
        if (!item) return;
        event.preventDefault();
        executeAction(item.dataset.desktopAction);
    });

    document.addEventListener('click', (event) => {
        if (!activeMenu) return;
        if (event.target.closest('#desktop-app-menu') || event.target.closest('.desktop-app-menu-popover')) return;
        closeMenu();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && activeMenu) closeMenu();
    });

    window.addEventListener('resize', closeMenu);

    if (typeof desktopApi.getServerConfig === 'function') {
        desktopApi.getServerConfig().then(cfg => {
            if (cfg?.lockServerConfig) isServerConfigLocked = true;
        }).catch(() => {});
    }
    if (typeof desktopApi.getUpdateStatus === 'function') {
        desktopApi.getUpdateStatus().then(st => applyUpdateState(st, false)).catch(() => {});
    }
    if (typeof desktopApi.onUpdateEvent === 'function') {
        desktopApi.onUpdateEvent(st => applyUpdateState(st, true));
    }
})();
