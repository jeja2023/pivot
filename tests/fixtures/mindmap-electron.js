'use strict';
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadURL(process.env.PIVOT_MINDMAP_TEST_URL);
});
app.on('window-all-closed', () => app.quit());
