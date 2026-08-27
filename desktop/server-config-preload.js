const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pivotServerConfig', {
    getConfig() {
        return ipcRenderer.invoke('pivot-desktop:get-server-config');
    },
    saveConfig(payload) {
        return ipcRenderer.invoke('pivot-desktop:set-server-config', payload || {});
    },
    testConnection(url, stealthSecret) {
        return ipcRenderer.invoke('pivot-desktop:test-server-connection', { url, stealthSecret });
    },
    close() {
        return ipcRenderer.invoke('pivot-server-config:close');
    }
});
