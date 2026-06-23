const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pivotDesktop', {
    retry() {
        return ipcRenderer.invoke('pivot-desktop:retry');
    },
    getStatus() {
        return ipcRenderer.invoke('pivot-desktop:status');
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
