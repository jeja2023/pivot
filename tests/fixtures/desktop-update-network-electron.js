'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ElectronHttpExecutor, getNetSession } = require('electron-updater/out/electronHttpExecutor');
const { installStealthHeaderInterceptor } = require('../../desktop/stealth-policy');

app.setPath('userData', path.join(process.env.PIVOT_UPDATE_NETWORK_TEST_ROOT, 'user-data'));
app.setPath('sessionData', path.join(process.env.PIVOT_UPDATE_NETWORK_TEST_ROOT, 'session-data'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const baseUrl = process.env.PIVOT_UPDATE_NETWORK_TEST_URL;
    const base = new URL(baseUrl);
    const executor = new ElectronHttpExecutor();
    const request = requestPath => new Promise(resolve => {
        const pending = executor.createRequest({ protocol: base.protocol, hostname: base.hostname, port: Number(base.port), path: requestPath, method: 'GET' }, response => {
            response.resume();
            response.on('end', () => resolve({ status: response.statusCode }));
        });
        pending.on('error', error => resolve({ error: error.message }));
        pending.end();
    });
    const before = await request('/downloads/latest.yml');
    installStealthHeaderInterceptor(getNetSession(), { getTargetUrl: () => baseUrl, getSecret: () => 'updater-network-test-secret' });
    const after = [];
    for (const requestPath of ['/downloads/latest.yml', '/downloads/Pivot.exe', '/downloads/Pivot.exe.blockmap']) after.push(await request(requestPath));
    fs.writeFileSync(path.join(process.env.PIVOT_UPDATE_NETWORK_TEST_ROOT, 'result.json'), JSON.stringify({ before, after }));
    app.exit(0);
}).catch(() => app.exit(1));
