(function () {
    const desktopApi = window.pivotDesktop;
    if (!desktopApi) return;

    const menuRoot = document.getElementById('desktop-app-menu');
    if (!menuRoot) return;

    document.body?.classList.add('pivot-desktop-runtime');
    menuRoot.hidden = false;

    const MENU_GROUPS = {
        page: [
            { label: '刷新页面', action: 'reload', shortcut: 'Ctrl+R' },
            { label: '清理缓存并刷新', action: 'clear-cache-and-reload', shortcut: 'Ctrl+Shift+R' }
        ],
        display: [
            { label: '实际大小', action: 'window:zoom-reset', shortcut: 'Ctrl+0' },
            { label: '放大', action: 'window:zoom-in', shortcut: 'Ctrl+=' },
            { label: '缩小', action: 'window:zoom-out', shortcut: 'Ctrl+-' },
            { separator: true },
            { label: '切换全屏', action: 'window:toggle-fullscreen', shortcut: 'F11' }
        ],
        client: [
            { label: '检查客户端更新', action: 'check-updates' },
            { separator: true },
            { label: '关于 Pivot', action: 'about' },
            { separator: true },
            { label: '退出客户端', action: 'quit-client' }
        ]
    };

    let activeMenu = '';
    let activeButton = null;
    const popover = document.createElement('div');
    popover.className = 'desktop-app-menu-popover hidden';
    popover.setAttribute('role', 'menu');
    document.body.appendChild(popover);

    function toast(message, type = 'success') {
        if (typeof showToast === 'function') showToast(message, type);
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
        const width = popover.offsetWidth || 198;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const top = Math.min(rect.bottom + 6, window.innerHeight - 12);
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
            label.textContent = item.label;
            option.appendChild(label);
            if (item.shortcut) {
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
                if (window.Pivot.legacy.PivotPwa?.reset) await window.Pivot.legacy.PivotPwa.reset();
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
            case 'check-updates':
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
})();
