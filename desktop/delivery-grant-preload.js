const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pivotDeliveryGrant', {
    close() {
        return ipcRenderer.invoke('pivot-delivery-grant:close');
    },
    getData() {
        return ipcRenderer.invoke('pivot-delivery-grant:get-data');
    },
    viewStatus() {
        return ipcRenderer.invoke('pivot-delivery-grant:view-status');
    }
});
