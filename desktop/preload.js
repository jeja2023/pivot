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
    setServerConfig(payload = {}) {
        return ipcRenderer.invoke('pivot-desktop:set-server-config', payload);
    },
    testServerConnection(payload = {}) {
        return ipcRenderer.invoke('pivot-desktop:test-server-connection', payload);
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
