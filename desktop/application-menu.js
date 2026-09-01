/** 桌面应用菜单组装，避免主进程入口累积 UI 行为。 */
function buildApplicationMenu(options = {}) {
    const Menu = options.Menu;
    return Menu.buildFromTemplate([
        {
            label: '页面',
            submenu: [
                { label: '刷新页面', accelerator: 'CmdOrCtrl+R', click: () => options.reloadDesktop() },
                { label: '清理缓存并刷新', accelerator: 'CmdOrCtrl+Shift+R', click: () => options.clearCacheAndReloadDesktop() }
            ]
        },
        {
            label: '显示',
            submenu: [
                { label: '实际大小', role: 'resetZoom' },
                { label: '放大', role: 'zoomIn' },
                { label: '缩小', role: 'zoomOut' },
                { type: 'separator' },
                { label: '切换全屏', accelerator: 'F11', role: 'togglefullscreen' }
            ]
        },
        {
            label: '客户端',
            submenu: [
                { label: '服务器连接配置...', accelerator: 'CmdOrCtrl+,', click: () => options.showServerConfigDialog() },
                { label: '配置文档交付目录...', click: () => { void options.configureDeliveryDirectory(); } },
                { label: '查看文档交付状态', click: () => { void options.showDeliveryStatus(); } },
                { type: 'separator' },
                { label: '检查客户端更新', click: () => options.checkForUpdates() },
                { type: 'separator' },
                { label: '关于 Pivot', click: () => options.showAboutDialog() },
                { type: 'separator' },
                { label: '退出客户端', click: () => options.quit() }
            ]
        }
    ]);
}

module.exports = { buildApplicationMenu };
