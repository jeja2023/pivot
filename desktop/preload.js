/* global window, document */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pivotDesktop', {
    retry() {
        return ipcRenderer.invoke('pivot-desktop:retry');
    },
    getStatus() {
        return ipcRenderer.invoke('pivot-desktop:status');
    },
    getLocalAuthorizationStatus() {
        return ipcRenderer.invoke('pivot-local-auth:status');
    },
    requestLocalAuthorization(type) {
        return ipcRenderer.invoke('pivot-local-auth:grant', type);
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

window.addEventListener('DOMContentLoaded', () => {
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
    document.head.appendChild(style);
});
