const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pivotDeliveryStatus', {
    close() {
        return ipcRenderer.invoke('pivot-delivery-status:close');
    },
    configureDirectory() {
        return ipcRenderer.invoke('pivot-delivery-status:configure-directory');
    },
    getStatus() {
        return ipcRenderer.invoke('pivot-delivery-status:get-status');
    }
});
