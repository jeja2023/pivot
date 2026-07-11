const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pivotAbout', {
    close() {
        return ipcRenderer.invoke('pivot-about:close');
    }
});
